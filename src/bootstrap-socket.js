/* eslint-disable max-lines */
'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
 *
 * This file is part of Buttress.
 * Buttress is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public Licence as published by the Free Software
 * Foundation, either version 3 of the Licence, or (at your option) any later version.
 * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public Licence for more details.
 * You should have received a copy of the GNU Affero General Public Licence along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */
const hash = require('object-hash');
const net = require('net');
const Express = require('express');
const {createClient} = require('redis');
const {v4: uuidv4} = require('uuid');
const Sugar = require('sugar');
require('sugar-inflections');

const sio = require('socket.io');
const sioClient = require('socket.io-client');
const redisAdapter = require('@socket.io/redis-adapter');
const {Emitter} = require('@socket.io/redis-emitter');

const Bootstrap = require('./bootstrap');

const Config = require('node-env-obj')();

const {ObjectId} = require('bson');
const Model = require('./model');
const Helpers = require('./helpers');
const Logging = require('./helpers/logging');

const AccessControl = require('./access-control');
const AccessControlHelpers = require('./access-control/helpers');
const AccessControlConditions = require('./access-control/conditions');

const Schema = require('./schema');

const Datastore = require('./datastore');

class BootstrapSocket extends Bootstrap {
	constructor() {
		super();

		this.__apps = [];
		this.__namespace = {};

		this._dataShareSockets = {};

		this.__superApps = [];

		this._policyCloseSocketEvents = [];

		this._oneWeekMilliseconds = Sugar.Number.day(7);

		this.isPrimary = Config.sio.app === 'primary';

		this.io = null;
		this._socketExpressServer = null;

		this._mainServer = null;

		this._redisClientEmitter = null;
		this.emitter = null;

		this._processResQueue = {};

		// This client is used by the emitter
		this._redisClientIOPub = null;
		this._redisClientIOSub = null;

		this.primaryDatastore = Datastore.createInstance(Config.datastore, true);

		// A map that holds reference to sockets which have subscribed to a request
		// the map keys will expire after 5 minutes.
		this._requestSockets = new Helpers.ExpireMap(5 * 60 * 1000);

		// Policy rooms should just be a map of roomId -> {collections,projections}
		// We dont't need to track what users are in which room as this is already
		// done for us.
		// Only the Primary will hold this structure, it can then be accessed by
		// the appropriate workers on request
		this._policyRooms = {
			/*
			roomId: {
				appId:
				schema: {
					car: {
						access
					},
					car: {
						access
					}
				}
				appliedPolicy: []
			}
			*/
		};

		this.logicalOperator = [
			'$or',
			'$and',
		];
	}

	async init() {
		await super.init();

		await this.primaryDatastore.connect();

		// Register some services.
		this.__services.set('modelManager', Model);

		// Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
		await Model.init(this.__services);
		await AccessControl.init(this.__nrp);

		// Init models
		await Model.initCoreModels();
		await Model.initSchema();

		return await this.__createCluster();
	}

	async clean() {
		await super.clean();

		Logging.logSilly('BootstrapSocket:clean');

		if (this._redisClientEmitter) {
			Logging.logSilly('Closing redisClientEmitter');
			await new Promise((resolve) => this._redisClientEmitter.quit(resolve));
			this._redisClientEmitter = null;
			this._emitter = null;
		}
		if (this._redisClientIOPub) {
			Logging.logSilly('Closing redisClientIOPub');
			await new Promise((resolve) => this._redisClientIOPub.quit(resolve));
			this._redisClientIOPub = null;
		}
		if (this._redisClientIOSub) {
			Logging.logSilly('Closing redisClientIOSub');
			await new Promise((resolve) => this._redisClientIOSub.quit(resolve));
			this._redisClientIOSub = null;
		}

		this._requestSockets.destory();
		this._requestSockets = null;

		// Close down all socket.io connections / handlers
		if (this.io) {
			Logging.logSilly('Closing socket.io');
			this.io.disconnectSockets(true);
			await new Promise((resolve) => this.io.close(resolve));
			this.io = null;
		}
		if (this._socketExpressServer) {
			Logging.logSilly('Closing socket.io express proxy');
			await new Promise((resolve) => this._socketExpressServer.close(resolve));
			this._socketExpressServer = null;
		}
		if (this._mainServer) {
			Logging.logSilly('Closing main server');
			this._mainServer.closeAllConnections();
			await new Promise((resolve) => this._mainServer.close(resolve));
			this._mainServer = null;
		}
		for await (const sockets of Object.values(this._dataShareSockets)) {
			for await (const socket of sockets) {
				Logging.logSilly('Closing data share socket');
				socket.destroy();
			}
		}

		// Destory all models
		await Model.clean();

		// Close Datastore connections
		Logging.logSilly('Closing down all datastore connections');
		await Datastore.clean();
	}

	/**
	 * message the primary and wait for a response
	 * @param {*} channel
	 * @param {*} message
	 */
	async _messagePrimary(channel, message) {
		// Generate an identifier for message
		const id = uuidv4();
		// Notify the primary with our payload
		this.__nrp.emit(`primary:${channel}`, {id, message, date: new Date()});
		// Await a response from the primary
		return await new Promise((resolve, reject) => this._processResQueue[id] = {resolve, reject});
	}

	async __initMaster() {
		this._redisClientEmitter = createClient(Config.redis);
		this.emitter = new Emitter(this._redisClientEmitter);

		if (this.isPrimary) {
			Logging.logVerbose(`Primary Main SOCKET`);
			await this.__registerNRPPrimaryListeners();

			this.__namespace['stats'] = {
				emitter: this.emitter.of(`/stats`),
				sequence: {
					super: 0,
					global: 0,
				},
			};
			this.__namespace['debug'] = {
				emitter: this.emitter.of(`/debug`),
				sequence: {
					super: 0,
					global: 0,
				},
			};

			// create app namespaces
			const rxsApps = await Model.App.findAll();
			for await (const app of rxsApps) {
				if (!app._tokenId) {
					Logging.logWarn(`App with no token`);
					continue;
				}

				await this.__createAppNamespace(app);
			}
		} else {
			Logging.logVerbose(`Secondary Main SOCKET`);
		}

		// This should be distributed across instances
		if (this.isPrimary) {
			Logging.logSilly(`Setting up data sharing connections`);
			const rxsDataShare = await Model.AppDataSharing.find({
				active: true,
			});

			for await (const dataShare of rxsDataShare) {
				await this.__primaryCreateDataShareConnection(dataShare);
			}
		}

		await this.__registerNRPMasterListeners();
		await this.__registerNRPProcessListeners();

		await this.__spawnWorkers();

		// Fielding request through to the worker processes. Do we even need this? It feels like
		// express should be handling this like we do on the rest.
		if (this.workerProcesses > 0) {
			this._mainServer = net.createServer({pauseOnConnect: true}, (connection) => {
				const worker = this.workers[this.__indexFromIP(connection.remoteAddress, this.workerProcesses)];
				worker.worker.send('buttress:connection', connection);
			}).listen(Config.listenPorts.sock);
		}
	}

	async __initWorker() {
		const app = new Express();
		this._socketExpressServer = (this.workerProcesses > 0) ? app.listen(0, 'localhost') :
			app.listen(Config.listenPorts.sock);
		this.io = sio(this._socketExpressServer, {
			// Allow connections from sio 2 clients
			// https://socket.io/docs/v3/migrating-from-2-x-to-3-0/#How-to-upgrade-an-existing-production-deployment
			allowEIO3: true,
			// https://expressjs.com/en/resources/middleware/cors.html#configuration-options
			// set origin to true to reflect the request origin, as defined by req.header('Origin'), or set it to false to disable CORS.
			cors: {
				origin: true,
				credentials: true,
			},
		});

		// As of v7, the library will no longer create Redis clients on behalf of the user.
		this._redisClientIOPub = createClient(Config.redis);
		this._redisClientIOSub = this._redisClientIOPub.duplicate();
		this.io.adapter(redisAdapter(this._redisClientIOPub, this._redisClientIOSub));

		const stats = this.io.of(`/stats`);
		stats.on('connect', (socket) => {
			Logging.logSilly(`${socket.id} Connected on /stats`);
			socket.on('disconnect', () => {
				Logging.logSilly(`${socket.id} Disconnect on /stats`);
			});
		});

		this.io.of(`/debug`).use(async (socket, next) => {
			const apiPath = 'debug';
			const rawToken = socket.handshake.query.token;
			if (!rawToken) return next('invalid-token');

			Logging.logWarn(`[${apiPath}] Connected ${socket.id}`);

			Logging.logDebug(`Fetching token with value: ${rawToken}`);
			const token = await Model.Token.findOne({value: rawToken});
			if (!token || token.type !== Model.Token.Constants.Type.SYSTEM) {
				Logging.logWarn(`Invalid token, closing connection: ${socket.id}`);
				return next('invalid-token');
			}

			const debugDump = async () => {
				const rooms = await this._messagePrimary('getPolicyRooms');
				const rollcall = await this._messagePrimary('debugRollcall');

				return {
					Config,
					rooms,
					rollcall,
				};
			};

			socket.on('request', async () => socket.emit('dump', await debugDump()));

			this.__nrp.on('debug:dump', async () => socket.emit('dump', await debugDump()));

			socket.on('disconnect', () => {
				Logging.log(`[${apiPath}] Disconnect ${socket.id}`);
			});

			next();
		});
		// debug.on('connect', (socket) => {
		// 	Logging.logSilly(`${socket.id} Connected on /debug`);
		// 	socket.on('disconnect', () => {
		// 		Logging.logSilly(`${socket.id} Disconnect on /debug`);
		// 	});
		// });

		Logging.logSilly(`Listening on app namespaces`);
		this.io.of(/^\/[a-z\d-]+$/i).use(async (socket, next) => {
			const apiPath = socket.nsp.name.substring(1);
			const rawToken = socket.handshake.query.token;

			Logging.logDebug(`Fetching token with value: ${rawToken}`);
			const token = await Model.Token.findOne({value: rawToken});
			if (!token) {
				Logging.logWarn(`Invalid token, closing connection: ${socket.id}`);
				return next('invalid-token');
			}

			socket.data.type = token.type;
			socket.data.tokenId = token.id.toString();

			Logging.logDebug(`Fetching app with apiPath: ${apiPath}`);
			const app = await Model.App.findOne({apiPath: apiPath});
			if (!app) {
				Logging.logWarn(`Invalid app, closing connection: ${socket.id}`);
				return next('invalid-app');
			}

			const remoteSchemas = Schema.decode(app.__schema).reduce((obj, item) => {
				if (!item.remotes) return obj;
				item.remotes.forEach((remote) => {
					obj[`${remote.name}.${remote.schema}`] = item;
				});
				return obj;
			}, {});

			if (token.type === 'dataSharing') {
				Logging.logDebug(`Fetching data share with tokenId: ${token.id}`);
				const dataShare = await Model.AppDataSharing.findOne({
					_tokenId: this.primaryDatastore.ID.new(token.id),
					active: true,
				});
				if (!dataShare) {
					Logging.logWarn(`Invalid data share, closing connection: ${socket.id}`);
					return next('invalid-data-share');
				}

				socket.data.dataShareId = dataShare.id.toString();

				// Emit this activity to our instance.
				// This would result in the event being mutiplied
				socket.on('share', (data) => {
					if (!data.schemaName || !remoteSchemas[`${dataShare.name}.${data.schemaName}`]) {
						Logging.log(`Skipping data sharing app doesn't use schema ${app.apiPath} ${dataShare.name}.${data.schemaName}, ${socket.id}`);
						return;
					}

					data.isSameApp = app.apiPath === data.appAPIPath;
					data.appId = app.id;
					data.appAPIPath = app.apiPath;

					this.__nrp.emit('activity', data);
				});

				Logging.log(`[${apiPath}][DataShare] Connected ${socket.id} to room ${dataShare.name}`);
			} else if (token.type === 'user') {
				Logging.logDebug(`Fetching user with id: ${token._userId}`);
				const user = await Model.User.findById(token._userId);
				if (!user) {
					Logging.logWarn(`Invalid token user ID, closing connection: ${socket.id}`);
					return next('invalid-token-user-ID');
				}

				socket.data.userId = user.id.toString();
				socket.data.userRef = user.auth[0].email ?? user.auth[0].appId;

				await this.__workerEvaluateUserRooms(user, app, socket);
			} else {
				Logging.log(`[${apiPath}][Global] Connected ${socket.id}`);
			}

			socket.on('bjs-request-subscribe', (data) => {
				if (!data.id) return Logging.logError(`[${apiPath}] bjs-request-subscribe ${socket.id} missing id`);
				Logging.logSilly(`[${apiPath}] bjs-request-subscribe ${socket.id} ${data.id}`);

				// Check to see if there is already a socket subbing to this id.
				const reqSock = this._requestSockets.get(data.id);
				if (reqSock && socket !== reqSock) return Logging.logError(`[${apiPath}] bjs-request-subscribe ${socket.id} already subscribed`);

				// if the socket hasn't already been subscribed then we'll set it.
				if (!reqSock) this._requestSockets.set(data.id, socket);

				socket.emit('bjs-request-subscribe-ack', data);
			});

			socket.on('disconnect', () => {
				Logging.logSilly(`[${apiPath}] Disconnect ${socket.id}`);
			});

			/**
			  * Take in an appId or userId an re-evalute the users rooms
			 	* @param {Object} data
				* @param {string} data.appId
				* @param {string} data.userId - Optional
			 */
			const debounceMap = {};
			this.__nrp.on('worker:socket:evaluateUserRooms', async (data) => {
				// Early out if userId isn't set, we must not have a user token
				if (!socket.data.userId) return;
				// Check that the request is for the correct app
				if (!data.appId || app.id.toString() !== data.appId) return;
				// Optional - If they've provided a userId then we only want to evaluate the single users room.
				if (data.userId && socket.data.userId !== data.userId) return;

				// TODO: Could do with being debounced
				const debounceKey = `worker:socket:evaluateUserRooms-${socket.data.userId}`;
				if (debounceMap[debounceKey]) clearTimeout(debounceMap[debounceKey]);
				debounceMap[debounceKey] = setTimeout(async () => {
					debounceMap[debounceKey] = null;
					Logging.logSilly(`worker:socket:evaluateUserRooms data.appId:${data.appId}` +
						`data.userId:${data.userId} userId:${socket.data.userId} ${socket.id}`);

					const user = await Model.User.findById(socket.data.userId);
					await this.__workerEvaluateUserRooms(user, app, socket, true);
				}, 100);
			});

			next();
		});

		await this.__registerNRPWorkerListeners();
		await this.__registerNRPProcessListeners();

		process.on('message', (message, input) => {
			if (message === 'buttress:connection') {
				const connection = input;
				this._socketExpressServer.emit('connection', connection);
				connection.resume();
				return;
			}
		});

		Logging.logSilly(`Worker ready`);
	}

	async __registerNRPPrimaryListeners() {
		Logging.logDebug(`Primary Master`);
		this.__nrp.on('activity', (data) => this.__primaryOnActivity(data));
		this.__nrp.on('clearUserLocalData', (data) => this.__primaryClearUserLocalData(data));
		this.__nrp.on('dataShare:activated', async (data) => {
			const dataShare = await Model.AppDataSharing.findById(data.appDataSharingId);
			await this.__primaryCreateDataShareConnection(dataShare);
		});

		this.__nrp.on('app:created', async (data) => {
			const app = await Model.App.findById(data.appId);
			await this.__createAppNamespace(app);
		});

		this.__nrp.on('app-schema:updated', async (data) => {
			await Model.initSchema(data.appId);
		});

		this.__nrp.on('queuePolicyRoomCloseSocketEvent', async (data) => {
			if (!this._policyRooms[data.appId]) return;
			Logging.logSilly(`queuePolicyRoomCloseSocketEvent ${data.appId}`);
			await this._primaryQueuePolicyRoomCloseSocketEvent(data);
		});

		this.__nrp.on('queueBasedConditionQuery', async (data) => {
			Logging.logSilly(`queueBasedConditionQuery`);
			this._policyCloseSocketEvents.push(data);
		});

		this.__nrp.on('accessControlPolicy:disconnectQueryBasedSocket', async (data) => {
			Logging.logSilly(`accessControlPolicy:disconnectQueryBasedSocket`);
			await this._primaryDisconnectQueryBasedSocket(data);
		});

		this.__nrp.on('primary:debugRollcall', async (data) => {
			Logging.logSilly(`primary:debugRollcall ${data.id}`);

			const id = uuidv4();

			// Broadcast to all and see whos listening
			this.__nrp.emit(`worker:debugRollcall`, {id});

			// Generate an identifier for message
			// Await a response from the primary
			const result = await new Promise((resolve, reject) => {
				let _result = {};
				let _timeout = setTimeout(() => resolve(_result), 50);
				const handleResponce = (data) => {
					clearTimeout(_timeout);
					_result = {..._result, ...data};
					_timeout = setTimeout(() => resolve(_result), 50);
				};
				// Debounce based on the callback
				// await responces
				// We'll just push in a callback and we'll handle the clean up
				this._processResQueue[id] = {callback: handleResponce};
			});

			this.__nrp.emit(`process:messageQueueResponse`, {id: data.id, response: result});
		});
		this.__nrp.on('primary:debugRollcallResponce', async (data) => {
			if (!this._processResQueue[data.id]) return;
			this._processResQueue[data.id].callback(data.responce);
		});

		// Take updates from the workers on room structs and update our copy
		this.__nrp.on('primary:updatePolicyRooms', async (data) => {
			Logging.logSilly(`primary:updatePolicyRooms ${data.id}`);

			for (const roomId of Object.keys(data.message)) {
				this._policyRooms[roomId] = data.message[roomId];
			}

			this.__nrp.emit(`process:messageQueueResponse`, {id: data.id, response: true});
		});

		this.__nrp.on('primary:getPolicyRooms', async (data) => {
			Logging.logSilly(`primary:getPolicyRooms ${data.id}`);
			this.__nrp.emit(`process:messageQueueResponse`, {id: data.id, response: this._policyRooms});
		});

		// Serve up a copy of the policy rooms to the requester
		this.__nrp.on('primary:getPolicyRoomsByIds', async (data) => {
			Logging.logSilly(`primary:getPolicyRoomsByIds ${data.id}`);

			const roomStructs = data.message.rooms
				.reduce((map, roomId) => {
					if (this._policyRooms[roomId]) map[roomId] = this._policyRooms[roomId];
					return map;
				}, {});

			this.__nrp.emit(`process:messageQueueResponse`, {id: data.id, response: roomStructs});
		});

		this.__nrp.on('primary:getPolicyRoomsByAppId', async (data) => {
			Logging.logSilly(`primary:getPolicyRoomsByAppId ${data.id}`);

			const roomStructs = Object.keys(this._policyRooms)
				.filter((roomId) => this._policyRooms[roomId].appId === data.message.appId)
				.reduce((map, roomId) => {
					map[roomId] = this._policyRooms[roomId];
					return map;
				}, {});

			this.__nrp.emit(`process:messageQueueResponse`, {id: data.id, response: roomStructs});
		});

		this.__nrp.on('primary:policy-updated', async (data) => {
			// Policy has been updated
			// - Trigger workers to revaluate what rooms users are connected to.

			// TODO: Handle outdated rooms and clean up this._policyRooms
		});
	}

	async __registerNRPMasterListeners() {
	}

	async __registerNRPWorkerListeners() {
		this.__nrp.on('worker:debugRollcall', async (data) => {
			Logging.logSilly(`worker:debugRollcall ${data.id}`);

			const nspSids = {};
			for (const nsp of this.io._nsps.keys()) {
				// Ignore some namespaces
				if (['/', '/stats', '/debug'].includes(nsp)) continue;
				if (!nspSids[nsp]) nspSids[nsp] = {};
				for (const [sid, rooms] of this.io.of(nsp).adapter.sids.entries()) {
					if (!nspSids[nsp][sid]) {
						nspSids[nsp][sid] = {
							socketData: this.io.of(nsp).sockets.get(sid)?.data,
							rooms: Array.from(rooms.values()),
						};
					}
				}
			}

			this.__nrp.emit('primary:debugRollcallResponce', {id: data.id, responce: nspSids});
		});

		this.__nrp.on('sock:worker:request-status', async (data) => {
			if (!data.id) return;

			const socket = this._requestSockets.get(data.id);
			if (!socket) return;

			socket.emit('bjs-request-status', data);
		});
		this.__nrp.on('sock:worker:request-end', async (data) => {
			if (!data.id) return;

			const socket = this._requestSockets.get(data.id);
			if (!socket) return;

			socket.emit('bjs-request-status', data);
			this._requestSockets.delete(data.id);
		});
	}

	async __registerNRPProcessListeners() {
		this.__nrp.on('process:messageQueueResponse', (data) => {
			if (!this._processResQueue[data.id]) return;
			Logging.logSilly(`process:messageQueueResponse ${data.id}`);
			this._processResQueue[data.id].resolve(data.response);
		});
	}

	async __workerEvaluateUserRooms(user, app, socket, clear = false) {
		Logging.logSilly(`__workerEvaluateUserRooms::start userId:${user.id} socketId:${socket.id}`);
		// TODO: needs to build the user request on connection and build its authApp and authUser
		// DO NOT USE socket.request
		const userRoomsStruct = await AccessControl.getUserRoomStructures(user, app.id, socket.request);
		const userRooms = Object.keys(userRoomsStruct);

		if (userRooms.length < 1) {
			Logging.logSilly(`__workerEvaluateUserRooms::end-no-user-rooms socketId:${socket.id}`);
			return;
		}

		this._messagePrimary('updatePolicyRooms', userRoomsStruct);

		const currentRooms = Array.from(socket.rooms.values());
		const roomsToLeave = currentRooms.filter((roomId) => roomId !== socket.id && !userRooms.includes(roomId));
		const roomsToJoin = userRooms.filter((roomId) => !currentRooms.includes(roomId));

		await this.__workerUserLeaveRooms(user, app, socket, roomsToLeave, clear);

		if (roomsToJoin.length > 0) {
			socket.join(roomsToJoin);

			// Emit event to users
			for (const roomId of roomsToJoin) {
				const collections = Object.keys(userRoomsStruct[roomId].schema);

				// Instead of broadcasting to everyone that a user needs to clear their data, we'll just ask the user POLITELY
				// to clear their data... don't hold your breath, they may say no.
				socket.emit('db-connect-room', {
					collections: collections,
					userId: user.id,
					room: roomId,
					apiPath: app.apiPath,
				});
			}

			Logging.log(`[${app.apiPath}][${user.id}] Joining ${socket.id} to rooms ${roomsToJoin.join(', ')}`);
		}

		// DEBUG - Rooms have changed lets notify
		this.__nrp.emit('debug:dump', {});

		// Logging.log(`[${app.apiPath}][${user.id}] Connected ${socket.id} to room ${userRooms.join(', ')}`);
		Logging.logSilly(`__workerEvaluateUserRooms::end socketId:${socket.id}`);
	}

	async __workerUserLeaveRooms(user, app, socket, roomsToLeave = null, clear = false) {
		Logging.logSilly(`__workerUserLeaveRooms::start userId:${user.id} socketId:${socket.id}`);

		if (roomsToLeave.length < 1) {
			// We've got no rooms to leave, early out.
			Logging.logSilly(`__workerUserLeaveRooms::end-no-rooms-to-leave userId:${user.id} socketId:${socket.id}`);
			return;
		}

		// Fetch the room structs if we're clearing the data, if not we don't need it.
		const roomStructsToClear = (clear) ? await this._messagePrimary('getPolicyRoomsByIds', {rooms: roomsToLeave}) : null;

		for (const roomId of roomsToLeave) {
			if (clear) {
				const collections = Object.keys(roomStructsToClear[roomId].schema);

				// Instead of broadcasting to everyone that a user needs to clear their data, we'll just ask the user POLITELY
				// to clear their data... don't hold your breath, they may say no.
				socket.emit('db-disconnect-room', {
					collections: collections,
					userId: user.id,
					room: roomId,
					apiPath: app.apiPath,
				});
			}

			// I'm not sure there is a need to wait for the user to respond that they've left the room, we'll just revoke their
			// access now and it's up to them to have honored clearing the data
			socket.leave(roomId);
		}

		Logging.log(`[${app.apiPath}][${user.id}] Remove ${socket.id} from rooms ${roomsToLeave.join(',')}`);
		Logging.logSilly(`__workerUserLeaveRooms::end userId:${user.id} socketId:${socket.id}`);
	}

	async __primaryOnActivity(data) {
		const container = {
			id: Datastore.getInstance('core').ID.new(),
			timer: new Helpers.Timer(),
		};
		container.timer.start();
		Logging.logTimer(`[${data.appAPIPath}][${data.verb}] activity in on ${data.path}`,
			container.timer, Logging.Constants.LogLevel.SILLY, container.id);

		const apiPath = data.appAPIPath;

		if (!this.emitter) {
			throw new Error('SIO Emitter isn\'t defined');
		}

		this.__namespace['stats'].emitter.emit('activity', 1);

		Logging.logTimer(`emitted stats activity`, container.timer, Logging.Constants.LogLevel.SILLY, container.id);

		// Super apps?
		if (data.isSuper) {
			// Broadcast to any super apps
			this.__superApps.forEach((superApiPath) => {
				this.__namespace[superApiPath].sequence['super']++;
				this.__namespace[superApiPath].emitter.emit('db-activity', {
					data: data,
					sequence: this.__namespace[superApiPath].sequence['super'],
				});
				Logging.logDebug(`[${superApiPath}][super][${data.verb}] ${data.path}`);
			});

			// Broadcast to the app token
			if (data.appAPIPath) {
				this.__namespace[data.appAPIPath].sequence['global']++;
				this.__namespace[data.appAPIPath].emitter.emit('db-activity', {
					data: data,
					sequence: this.__namespace[data.appAPIPath].sequence['global'],
				});
				Logging.logDebug(`[${data.appAPIPath}][app][${data.verb}] ${data.path}`);
			}

			return;
		}

		// Disable broadcasting to public space
		if (data.broadcast === false) {
			Logging.logDebug(`[${apiPath}][${data.verb}] ${data.path} - Early out as it isn't public.`);
			return;
		}

		if (data.appId && this._dataShareSockets[data.appId] && data.isSameApp === undefined) {
			Logging.logTimer(`[${data.appAPIPath}][${data.verb}] notifying data sharing`,
				container.timer, Logging.Constants.LogLevel.SILLY, container.id);
			this._dataShareSockets[data.appId].forEach((sock) => sock.emit('share', data));
		}

		// Broadcast on requested channel
		if (!this.__namespace[apiPath]) {
			// Init the namespace
			// throw new Error('Trying to access namespace that doesn\'t exist');
			Logging.logTimer(`[${data.appAPIPath}][${data.verb}] creating emitter for namespace /${apiPath}`,
				container.timer, Logging.Constants.LogLevel.SILLY, container.id);
			this.__namespace[apiPath] = {
				emitter: this.emitter.of(`/${apiPath}`),
				sequence: {
					super: 0,
					global: 0,
				},
			};
		}

		await this.__masterBroadcastToRooms(data, container);
	}

	async __masterBroadcastToRooms(data, container) {
		Logging.logTimer(`__masterBroadcastToRooms::start`, container.timer, Logging.Constants.LogLevel.SILLY, container.id);

		// TODO: Maybe cache this on the master, for now we'll just requst it from the primary
		const _policyRooms = await this._messagePrimary('getPolicyRoomsByAppId', {appId: data.appId});
		const roomIds = Object.keys(_policyRooms);

		const appId = data.appId;
		const verb = data.verb;
		const collection = data.path.split('/').filter((v) => v).shift().replace('/', '');
		if (!roomIds || roomIds.length < 1) {
			Logging.logTimer(`__masterBroadcastToRooms::end-no-policy-room`, container.timer, Logging.Constants.LogLevel.SILLY, container.id);
			return;
		}

		const broadcastRoomsIds = roomIds.filter((roomId) => _policyRooms[roomId].schema[collection]);
		if (!broadcastRoomsIds || broadcastRoomsIds < 1) {
			Logging.logTimer(`__masterBroadcastToRooms::end-no-broadcast-rooms`, container.timer, Logging.Constants.LogLevel.SILLY, container.id);
			return;
		}

		for await (const roomKey of broadcastRoomsIds) {
			const room = _policyRooms[roomKey].schema[collection];
			Logging.logTimer(`__masterBroadcastToRooms::roomBroadcast::start`, container.timer,
				Logging.Constants.LogLevel.SILLY, `${container.id}-${roomKey}`);

			// We don't care at this point if we have users in a room we'll try and broadcast to it anyway.
			// if (room.userIds.length < 1) {
			// 	Logging.logTimer(`__masterBroadcastToUsers::roomBroadcast::end-no-users`, container.timer,
			// 		Logging.Constants.LogLevel.SILLY, `${container.id}-${roomKey}`);
			// 	continue;
			// }

			const roomQueryKeys = Object.keys(room.access.query);
			const roomProjectionKeys = (room.access.projection) ? room.access.projection : [];
			if (roomQueryKeys.length < 1 && roomProjectionKeys.length < 1) {
				this.__broadcastData(data, roomKey);
				Logging.logTimer(`__masterBroadcastToRooms::roomBroadcast::end-no-query-no-projection`, container.timer,
					Logging.Constants.LogLevel.SILLY, `${container.id}-${roomKey}`);
				continue;
			}

			const appShortId = Helpers.shortId(appId);
			const entityId = (data.params.id) ? data.params.id : data.response.id;
			if (!entityId && data.verb === 'delete') {
				this.__broadcastData(data, roomKey);
				Logging.logTimer(`__masterBroadcastToRooms::roomBroadcast::end-no-entity-deletion`, container.timer,
					Logging.Constants.LogLevel.SILLY, `${container.id}-${roomKey}`);
				continue;
			}

			if (!entityId) {
				Logging.logWarn('Unable to broadcast entity, data is missing a id');
				continue;
			}

			if (!Model[`${appShortId}-${collection}`]) {
				Logging.logWarn(`Unable to broadcast entity, can not find ${appShortId}-${collection} in the database`);
				continue;
			}

			// TODO: Should be using ID from datastore not direct ObjectID
			const rxsEntity = await Model[`${appShortId}-${collection}`].find({id: new ObjectId(entityId)});
			const entity = await Helpers.streamFirst(rxsEntity);

			const broadcast = await this.__evaluateRoomQueryOperation(room.access.query, entity);
			if (!broadcast && verb === 'post') {
				Logging.logTimer(`__masterBroadcastToRooms::roomBroadcast::end-falsy-evaluateRoomQueryOperation-post`, container.timer,
					Logging.Constants.LogLevel.SILLY, `${container.id}-${roomKey}`);
				continue;
			}

			if (!broadcast) {
				data.verb = 'delete';
				this.__broadcastData(data, roomKey);
				Logging.logTimer(`__masterBroadcastToRooms::roomBroadcast::end-falsy-evaluateRoomQueryOperation-delete`, container.timer,
					Logging.Constants.LogLevel.SILLY, `${container.id}-${roomKey}`);
				continue;
			}

			// TODO: Is this a flatterned object at this point?
			const projectedData = roomProjectionKeys.reduce((obj, key) => {
				if (data.response[key]) {
					obj[key] = data.response[key];
				}

				return obj;
			}, {});

			if (Object.keys(projectedData).length > 0) {
				data.response = projectedData;
			}

			this.__broadcastData(data, roomKey);
			Logging.logTimer(`__masterBroadcastToRooms::roomBroadcast::end`, container.timer,
				Logging.Constants.LogLevel.SILLY, `${container.id}-${roomKey}`);
		}

		Logging.logTimer(`__masterBroadcastToUsers::end`, container.timer, Logging.Constants.LogLevel.SILLY, container.id);
	}

	async __evaluateRoomQueryOperation(roomQuery, entity, partialPass = null, fullPass = null, skip = false) {
		if (!entity) return false;

		await Object.keys(roomQuery).reduce(async (prev, operator) => {
			await prev;

			partialPass = (partialPass === null)? (operator === '@or') ? true : false : partialPass;
			fullPass = (fullPass === null)? (!partialPass) ? true : false : fullPass;

			if (this.logicalOperator.includes(operator)) {
				const arr = roomQuery[operator];
				await arr.reduce(async (prev, conditionObj) => {
					await prev;
					await this.__evaluateRoomQueryOperation(conditionObj, entity, partialPass, fullPass, true);
				}, Promise.resolve());
			} else {
				const [queryOperator] = Object.keys(roomQuery[operator]);
				const rhs = roomQuery[operator][queryOperator];
				operator = operator.replace(/^_+/, '');
				const lhs = (ObjectId.isValid(entity[operator])) ? entity[operator].toString() : entity[operator];
				const passed = await AccessControlHelpers.evaluateOperation(lhs, rhs, queryOperator);
				if (partialPass && passed) {
					partialPass = true;
				}

				if (!passed) {
					fullPass = false;
				}
			}
		}, Promise.resolve());

		if (skip) return;

		return (partialPass)? partialPass : fullPass;
	}

	__broadcastData(data, room) {
		const apiPath = data.appAPIPath;
		if (!this.__namespace[apiPath].sequence[room]) {
			this.__namespace[apiPath].sequence[room] = 0;
		}

		const broadcastedData = {
			response: data.response,
			path: data.path,
			pathSpec: data.pathSpec,
			user: data.user,
			verb: data.verb,
			params: data.params,
			isSameApp: data.isSameApp,
			isBulkDelete: Object.keys(data.params).length < 1 && data.verb === 'delete',
		};

		Logging.logDebug(`[${apiPath}][${room}][${data.verb}] ${data.path}`);
		this.__namespace[apiPath].sequence[room]++;
		this.__namespace[apiPath].emitter.in(room).emit('db-activity', {
			data: broadcastedData,
			sequence: this.__namespace[apiPath].sequence[room],
			room,
		});
	}

	__primaryClearUserLocalData(data) {
		throw new Error('DEPRECATED: call made to __primaryClearUserLocalData');
		// const apiPath = data.appAPIPath;

		// this.__namespace[apiPath].emitter.emit('clear-local-db', {
		// 	data: data,
		// });
	}

	__indexFromIP(ip, spread) {
		let s = '';
		for (let i = 0, _len = ip.length; i < _len; i++) {
			if (!isNaN(ip[i])) {
				s += ip[i];
			}
		}

		return Number(s) % spread;
	}

	async __createAppNamespace(app) {
		if (this.__namespace[app.apiPath]) {
			return Logging.logDebug(`Namespace already created: ${app.name}`);
		}

		const token = await Model.Token.findOne({id: app._tokenId});
		if (!token) return Logging.logWarn(`No Token found for ${app.name}`);

		const isSuper = token.type === Model.Token.Constants.Type.SYSTEM;

		this.__namespace[app.apiPath] = {
			emitter: this.emitter.of(`/${app.apiPath}`),
			sequence: {
				super: 0,
				global: 0,
			},
		};

		if (isSuper) {
			this.__superApps.push(app.apiPath);
		}

		Logging.log(`${(isSuper) ? 'SUPER' : 'APP'} Name: ${app.name}, App ID: ${app.id}, Path: /${app.apiPath}`);
	}

	async __primaryCreateDataShareConnection(dataShare) {
		const url = `${dataShare.remoteApp.endpoint}/${dataShare.remoteApp.apiPath}`;
		Logging.logSilly(`Attempting to connect to ${url}`);
		if (!this._dataShareSockets[dataShare._appId]) {
			this._dataShareSockets[dataShare._appId] = [];
		}

		const socket = sioClient(url, {
			query: {
				token: dataShare.remoteApp.token,
			},
			allowEIO3: true,
			rejectUnauthorized: false,
		});

		this._dataShareSockets[dataShare._appId].push(socket);

		socket.on('connect', () => {
			Logging.logSilly(`Connected to ${url} with id ${socket.id}`);
		});
		socket.on('disconnect', () => {
			Logging.logSilly(`Disconnected from ${url} with id ${socket.id}`);
		});
	}

	async _primaryQueuePolicyRoomCloseSocketEvent(data) {
		const policies = data.policies;
		// TODO: Add app id to hash
		const room = hash(policies);
		for await (const key of Object.keys(policies)) {
			const policy = policies[key];
			const conditionStr = policy.conditions.reduce((str, condition) => str = str + JSON.stringify(condition), '');
			if (!conditionStr) continue;

			await this._queueEvent(data, room, policy, key, conditionStr);
		}
	}

	async _queueEvent(data, room, policy, roomKey, conditionStr) {
		const conditions = policy.conditions;
		conditions.reduce(async (prev, condition) => {
			await prev;
			const dateTimeBasedCondition = await AccessControlConditions.isPolicyDateTimeBased(condition);
			if (dateTimeBasedCondition) {
				let policyIdx = this._policyCloseSocketEvents.findIndex((event) => event.name === roomKey);
				if (policyIdx === -1) {
					policyIdx = this._policyCloseSocketEvents.push({
						name: roomKey,
						conditions: [
							conditionStr,
						],
					});
				} else {
					const policyConditionExist = this._policyCloseSocketEvents[policyIdx].conditions.some((c) => c === conditionStr);
					if (policyConditionExist) return;

					this._policyCloseSocketEvents[policyIdx].conditions.push(conditionStr);
				}

				await this._queueDateTimeEvent(data, policy, dateTimeBasedCondition, policyIdx);
				return;
			}

			const queryBasedCondition = await AccessControlConditions.isPolicyQueryBasedCondition(condition, data.schemaNames);
			if (queryBasedCondition) {
				this.__nrp.emit('queueBasedConditionQuery', {
					room: room,
					collection: queryBasedCondition.name,
					identifier: queryBasedCondition.entityId,
				});
			}
		}, Promise.resolve());
	}

	async _queueDateTimeEvent(data, policy, dateTimeBasedCondition, idx) {
		const envVars = policy.env;

		if (dateTimeBasedCondition === 'time') {
			const conditionEndTime = AccessControlConditions.getEnvironmentVar(envVars, 'env.endTime');
			if (!conditionEndTime) return;

			const timeout = Sugar.Date.range(`now`, `${conditionEndTime}`).milliseconds();
			setTimeout(() => {
				this.__nrp.emit('worker:socket:updateUserSocketRooms', {
					userId: data.userId,
					appId: data.appId,
				});
				this._policyCloseSocketEvents.splice(idx - 1, 1);
			}, timeout);
		}

		if (dateTimeBasedCondition === 'date') {
			const conditionEndDate = AccessControlConditions.getEnvironmentVar(envVars, 'env.endDate');
			if (!conditionEndDate) return;

			const nearlyExpired = Sugar.Number.day(Sugar.Date.create(conditionEndDate));
			if (this._oneWeekMilliseconds > nearlyExpired) {
				setTimeout(() => {
					this.__nrp.emit('worker:socket:updateUserSocketRooms', {
						userId: data.userId,
						appId: data.appId,
					});
					this._policyCloseSocketEvents.splice(idx - 1, 1);
				}, nearlyExpired);
			}
		}
	}

	async _primaryDisconnectQueryBasedSocket(data) {
		const schemaBasedConditionIdx = this._policyCloseSocketEvents.findIndex((c) => {
			return c.collection === data.updatedSchema && c.identifier === data.identifier;
		});

		if (schemaBasedConditionIdx === -1) return;

		this.__nrp.emit('worker:socket:updateUserSocketRooms', {
			userId: data.userId,
			appId: data.appId,
		});

		this._policyCloseSocketEvents.splice(schemaBasedConditionIdx, 1);
	}
}

module.exports = BootstrapSocket;
