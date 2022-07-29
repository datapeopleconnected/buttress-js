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
const Sugar = require('sugar');
const os = require('os');
const cluster = require('cluster');
const net = require('net');
const Express = require('express');
const {createClient} = require('redis');

const sio = require('socket.io');
const sioClient = require('socket.io-client');
const redisAdapter = require('@socket.io/redis-adapter');
const {Emitter} = require('@socket.io/redis-emitter');

const NRP = require('node-redis-pubsub');

const Config = require('node-env-obj')();

const ObjectId = require('mongodb').ObjectId;
const shortId = require('./helpers').shortId;
const Model = require('./model');
const Helpers = require('./helpers');
const Logging = require('./logging');
const AccessControl = require('./access-control');
const AccessControlConditions = require('./access-control/conditions');

const Datastore = require('./datastore');

class BootstrapSocket {
	constructor() {
		Logging.setLogLevel(Logging.Constants.LogLevel.INFO);

		this.processes = os.cpus().length;
		this.workers = [];

		this.__apps = [];
		this.__namespace = {};

		this._dataShareSockets = {};

		this.__superApps = [];

		this._policyCloseSocketEvents = [];

		this._oneWeekMilliseconds = Sugar.Number.day(7);

		this.isPrimary = Config.sio.app === 'primary';

		this.emitter = null;

		this.primaryDatastore = Datastore.createInstance(Config.datastore, true);

		this._policyRooms = {};

		this.logicalOperator = [
			'$or',
			'$and',
		];

		// let socketInitTask = null;
		// if (cluster.isMaster) {
		// 	socketInitTask = (db) => this.__initMaster(db);
		// } else {
		// 	socketInitTask = (db) => this.__initWorker(db);
		// }

		// return this.__nativeMongoConnect()
		// 	.then(socketInitTask)
		// 	.then(() => cluster.isMaster);
	}

	async init() {
		await this.primaryDatastore.connect();

		await Model.init();

		if (cluster.isMaster) {
			await this.__initMaster();
		} else {
			await this.__initWorker();
		}

		return cluster.isMaster;
	}

	async __initMaster() {
		const nrp = new NRP(Config.redis);

		const redisClient = createClient(Config.redis);
		this.emitter = new Emitter(redisClient);

		if (this.isPrimary) {
			Logging.logDebug(`Primary Master`);
			nrp.on('activity', (data) => this.__onActivity(data));
			nrp.on('clearUserLocalData', (data) => this.__clearUserLocalData(data));
			nrp.on('dataShare:activated', async (data) => {
				const dataShare = await Model.AppDataSharing.findById(data.appDataSharingId);
				await this.__createDataShareConnection(dataShare);
			});

			nrp.on('queuePolicyRoomCloseSocketEvent', async (data) => {
				if (!this._policyRooms[data.appId]) return;
				await this._queuePolicyRoomCloseSocketEvent(nrp, data);
			});

			nrp.on('queueBasedConditionQuery', async (data) => {
				this._policyCloseSocketEvents.push(data);
			});

			nrp.on('accessControlPolicy:disconnectQueryBasedSocket', async (data) => {
				await this._disconnectQueryBasedSocket(nrp, data);
			});

			nrp.on('setMainPolicyRooms', async (data) => {
				this._policyRooms = data;
				nrp.emit('finishedSettingMainPolicyRooms', true);
			});

			nrp.on('getPolicyRooms', async () => {
				nrp.emit('sendPolicyRooms', this._policyRooms);
			});

			nrp.on('accessControlPolicy:disconnectSocket', async (data) => {
				const apiPath = data.apiPath;
				const room = data.room;

				if (data.clear) {
					this.__namespace[apiPath].emitter.in(room).emit('db-disconnect-room', {
						collections: data.collections,
						userId: data.userId,
						room,
					});
				}
			});
		}

		const rxsApps = await Model.App.findAll();

		this.__namespace['stats'] = {
			emitter: this.emitter.of(`/stats`),
			sequence: {
				super: 0,
				global: 0,
			},
		};

		// Spawn worker processes, pass through build app objects
		for await (const app of rxsApps) {
			if (!app._token) {
				Logging.logWarn(`App with no token`);
				continue;
			}

			await this.__createAppNamespace(app);
		}

		// This should be distributed across instances
		if (this.isPrimary) {
			Logging.logSilly(`Setting up data sharing connections`);
			const rxsDataShare = await Model.AppDataSharing.find({
				active: true,
			});

			for await (const dataShare of rxsDataShare) {
				await this.__createDataShareConnection(dataShare);
			}
		}

		this.__spawnWorkers({
			apps: this.__apps,
		});
	}

	async __initWorker() {
		const nrp = new NRP(Config.redis);

		const app = new Express();
		const server = app.listen(0, 'localhost');
		const io = sio(server, {
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
		const redisClient = createClient(Config.redis);
		io.adapter(redisAdapter(redisClient, redisClient.duplicate()));

		const stats = io.of(`/stats`);
		stats.on('connect', (socket) => {
			Logging.logSilly(`${socket.id} Connected on /stats`);
			socket.on('disconnect', () => {
				Logging.logSilly(`${socket.id} Disconnect on /stats`);
			});
		});

		nrp.on('updateSocketRooms', async (data) => {
			if (!io[data.apiPath]) {
				nrp.emit('updatedUserSocketRooms', {});
				return;
			}

			nrp.emit('updateUserSocketRooms', data);
		});

		Logging.logSilly(`Listening on app namespaces`);
		io.of(/^\/[a-z\d-]+$/i).use(async (socket, next) => {
			const apiPath = socket.nsp.name.substring(1);
			const rawToken = socket.handshake.query.token;

			Logging.logDebug(`Fetching token with value: ${rawToken}`);
			const token = await Model.Token.findOne({value: rawToken});
			if (!token) {
				Logging.logWarn(`Invalid token, closing connection: ${socket.id}`);
				return next('invalid-token');
			}

			Logging.logDebug(`Fetching app with apiPath: ${apiPath}`);
			const app = await Model.App.findOne({apiPath: apiPath});
			if (!app) {
				Logging.logWarn(`Invalid app, closing connection: ${socket.id}`);
				return next('invalid-app');
			}

			if (token.type === 'dataSharing') {
				Logging.logDebug(`Fetching data share with tokenId: ${token._id}`);
				const dataShare = await Model.AppDataSharing.findOne({
					_tokenId: this.primaryDatastore.ID.new(token._id),
					active: true,
				});
				if (!dataShare) {
					Logging.logWarn(`Invalid data share, closing connection: ${socket.id}`);
					return next('invalid-data-share');
				}

				// Emit this activity to our instance.
				socket.on('share', (data) => {
					// Map the app data to our path
					if (!data.schema.remote) return;

					data.appId = app._id;
					data.appAPIPath = app.apiPath;

					data.fromDataShare = dataShare._id;

					nrp.emit('activity', data);
				});

				Logging.log(`[${apiPath}][DataShare] Connected ${socket.id} to room ${dataShare.name}`);
			} else if (token.type === 'user') {
				Logging.logDebug(`Fetching user with id: ${token._user}`);
				const user = await Model.User.findById(token._user);
				if (!user) {
					Logging.logWarn(`Invalid token user ID, closing connection: ${socket.id}`);
					return next('invalid-token-user-ID');
				}

				// await this.__disconnectUserRooms(nrp, user._id, app);
				await this.__joinUserRooms(nrp, user, app, socket);
			} else {
				Logging.log(`[${apiPath}][Global] Connected ${socket.id}`);
			}

			socket.on('disconnect', () => {
				Logging.logSilly(`[${apiPath}] Disconnect ${socket.id}`);
			});

			nrp.on('updateUserSocketRooms', async (data) => {
				let userToken = null;
				const rxsUserToken = await Model.Token.findUserAuthTokens(data.userId, data.appId);
				for await (const t of rxsUserToken) {
					userToken = t;
				}
				if (userToken.value !== token.value) return;

				const user = await Model.User.findById(data.userId);
				await this.__joinUserRooms(nrp, user, app, socket, true);

				nrp.emit('updatedUserSocketRooms', {});
			});

			nrp.on('disconnectUserSocketRooms', async (data) => {
				let userToken = null;
				const rxsUserToken = await Model.Token.findUserAuthTokens(data.userId, data.appId);
				for await (const t of rxsUserToken) {
					userToken = t;
				}
				if (userToken.value !== token.value) return;

				await this.__disconnectUserRooms(nrp, data.userId, app, socket, true);
			});

			socket.on('clear-socket-room', (data) => {
				socket.leave(data.room);

				nrp.emit('socketLeftRoom', {
					userId: data.userId,
					room: data.room,
				});
			});

			next();
		});

		process.on('message', (message, input) => {
			if (message === 'buttress:connection') {
				const connection = input;
				server.emit('connection', connection);
				connection.resume();
				return;
			}
		});

		Logging.logSilly(`Worker ready`);
		process.send('workerInitiated');
	}

	async __joinUserRooms(nrp, user, app, socket, clear = false) {
		await this.__disconnectUserRooms(nrp, user._id, app, socket, clear);

		const policyRooms = await new Promise((resolve) => {
			nrp.emit('getPolicyRooms', {});
			nrp.on('sendPolicyRooms', (data) => resolve(data));
		});

		if (!policyRooms || (policyRooms && (Array.isArray(policyRooms) || typeof policyRooms !== 'object'))) return;

		if (!policyRooms[app._id]) {
			policyRooms[app._id] = {};
		}

		const userRooms = await AccessControl.getUserRooms(user, socket.request, app._id, policyRooms[app._id]);
		if (userRooms.length < 1) return;

		await new Promise((resolve) => {
			nrp.emit('setMainPolicyRooms', policyRooms);
			nrp.on('finishedSettingMainPolicyRooms', () => resolve());
		});

		socket.join(userRooms);
		Logging.log(`[${app.apiPath}][${user._id}] Connected ${socket.id} to room ${userRooms.join(', ')}`);
	}

	async __disconnectUserRooms(nrp, userId, app, socket, clear = false) {
		const prevSocketRooms = Array.from(socket.rooms).filter((v) => v !== socket.id).join(', ');
		if (prevSocketRooms) {
			Logging.log(`[${app.apiPath}][${userId}] Disconnecting ${socket.id} from room ${prevSocketRooms}`);
		}

		const policyRooms = await new Promise((resolve) => {
			nrp.emit('getPolicyRooms', {});
			nrp.on('sendPolicyRooms', (data) => resolve(data));
		});

		if (!policyRooms || !policyRooms[app._id]) return;

		const appPolicyRooms = policyRooms[app._id];
		const policyRoomsKeys = Object.keys(appPolicyRooms);
		for await (const key of policyRoomsKeys) {
			const room = appPolicyRooms[key];
			for await (const roomKey of Object.keys(room)) {
				const apiPath = app.apiPath;
				const roomUserIds = room[roomKey].userIds;
				const userIdx = roomUserIds.findIndex((id) => id === userId.toString());
				const sharedCollections = this.__getRoomSharedCollections(appPolicyRooms, policyRoomsKeys, roomKey);
				if (userIdx !== -1) {
					nrp.emit('accessControlPolicy:disconnectSocket', {
						collections: sharedCollections,
						apiPath,
						userId,
						room: roomKey,
						clear,
					});

					roomUserIds.splice(userIdx, 1);

					if (!socket.rooms.has(roomKey)) continue;

					await new Promise((resolve) => {
						nrp.on('socketLeftRoom', (data) => {
							if (data.userId !== userId && data.room !== roomKey) return;
							resolve();
						});
					});
				}
			}
		}

		await new Promise((resolve) => {
			nrp.emit('setMainPolicyRooms', policyRooms);
			nrp.on('finishedSettingMainPolicyRooms', () => resolve());
		});
	}

	async __onActivity(data) {
		const apiPath = data.appAPIPath;

		if (!this.emitter) {
			throw new Error('SIO Emitter isn\'t defined');
		}

		this.__namespace['stats'].emitter.emit('activity', 1);

		Logging.logSilly(`[${apiPath}][${data.verb}] activity in on ${data.path}`);

		// Super apps?
		if (data.isSuper) {
			this.__superApps.forEach((superApiPath) => {
				this.__namespace[superApiPath].sequence['super']++;
				this.__namespace[superApiPath].emitter.emit('db-activity', {
					data: data,
					sequence: this.__namespace[superApiPath].sequence['super'],
				});
				Logging.logDebug(`[${superApiPath}][super][${data.verb}] ${data.path}`);
			});
			return;
		}

		// Disable broadcasting to public space
		if (data.broadcast === false) {
			Logging.logDebug(`[${apiPath}][${data.verb}] ${data.path} - Early out as it isn't public.`);
			return;
		}

		if (data.appId && this._dataShareSockets[data.appId] && !data.fromDataShare) {
			this._dataShareSockets[data.appId].forEach((sock) => sock.emit('share', data));
		}

		// Broadcast on requested channel
		if (!this.__namespace[apiPath]) {
			// Init the namespace
			// throw new Error('Trying to access namespace that doesn\'t exist');
			this.__namespace[apiPath] = {
				emitter: this.emitter.of(`/${apiPath}`),
				sequence: {
					super: 0,
					global: 0,
				},
			};
		}

		await this.__broadcastToUsers(data);
	}

	async __broadcastToUsers(data) {
		const appId = data.appId;
		const verb = data.verb;
		const collection = data.path.split('/').filter((v) => v).shift().replace('/', '');
		if (!this._policyRooms[appId]) return;

		const broadcastRooms = this._policyRooms[appId][collection];
		if (!broadcastRooms) return;

		for await (const roomKey of Object.keys(broadcastRooms)) {
			const room = broadcastRooms[roomKey];
			if (room.userIds.length < 1) continue;

			const roomQueryKeys = Object.keys(room.access.query);
			const roomProjectionKeys = (room.access.projection) ? room.access.projection : [];
			if (roomQueryKeys.length < 1 && roomProjectionKeys.length < 1) {
				this.__broadcastData(data, roomKey);
				continue;
			}

			const appShortId = shortId(appId);
			const rxsEntity = await Model[`${appShortId}-${collection}`].find({_id: new ObjectId(data.params.id)});
			const entity = await Helpers.streamFirst(rxsEntity);

			const broadcast = await this.__evaluateRoomQueryOperation(room.access.query, entity);
			if (!broadcast && verb === 'post') continue;

			if (!broadcast) {
				data.verb = 'delete';
				this.__broadcastData(data, roomKey);
				continue;
			}

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
		}
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
				const lhs = (ObjectId.isValid(entity[operator])) ? entity[operator].toString() : entity[operator];
				const passed = await AccessControlConditions.evaluateOperation(lhs, rhs, queryOperator);
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

		Logging.logDebug(`[${apiPath}][${room}][${data.verb}] ${data.path}`);
		this.__namespace[apiPath].sequence[room]++;
		this.__namespace[apiPath].emitter.in(room).emit('db-activity', {
			data: data,
			sequence: this.__namespace[apiPath].sequence[room],
			room,
		});
	}

	__clearUserLocalData(data) {
		// const apiPath = data.appAPIPath;

		// this.__namespace[apiPath].emitter.emit('clear-local-db', {
		// 	data: data,
		// });
	}

	__spawnWorkers() {
		Logging.log(`Spawning ${this.processes} Socket Workers`);

		for (let x = 0; x < this.processes; x++) {
			this.workers[x] = cluster.fork();
			this.workers[x].on('message', (res) => {
				if (res === 'workerInitiated') {
					// this.workers[x].send({'buttress:initAppTokens': appTokens});
				}
			});
		}

		net.createServer({pauseOnConnect: true}, (connection) => {
			const worker = this.workers[this.__indexFromIP(connection.remoteAddress, this.processes)];
			worker.send('buttress:connection', connection);
		}).listen(Config.listenPorts.sock);
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

		const token = await Model.Token.findOne({_id: app._token});
		if (!token) return Logging.logWarn(`No Token found for ${app.name}`);

		const isSuper = token.authLevel > 2;

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

		Logging.log(`${(isSuper) ? 'SUPER' : 'APP'} Name: ${app.name}, App ID: ${app._id}, Path: /${app.apiPath}`);
	}

	async __createDataShareConnection(dataShare) {
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

	async _queuePolicyRoomCloseSocketEvent(nrp, data) {
		const policies = data.policies;
		const room = hash(policies);
		for await (const key of Object.keys(policies)) {
			const policy = policies[key];
			const conditionStr = policy.conditions.reduce((str, condition) => str = str + JSON.stringify(condition), '');
			if (!conditionStr) continue;

			await this._queueEvent(nrp, data, room, policy, key, conditionStr);
		}
	}

	async _queueEvent(nrp, data, room, policy, roomKey, conditionStr) {
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

				await this._queueDateTimeEvent(nrp, data, policy, dateTimeBasedCondition, policyIdx);
				return;
			}

			const queryBasedCondition = await AccessControlConditions.isPolicyQueryBasedCondition(condition, data.schemaNames);
			if (queryBasedCondition) {
				nrp.emit('queueBasedConditionQuery', {
					room: room,
					collection: queryBasedCondition.name,
					identifier: queryBasedCondition.entityId,
				});
			}
		}, Promise.resolve());
	}

	async _queueDateTimeEvent(nrp, data, policy, dateTimeBasedCondition, idx) {
		const envVars = policy.env;

		if (dateTimeBasedCondition === 'time') {
			const conditionEndTime = AccessControlConditions.getEnvironmentVar(envVars, 'env.endTime');
			if (!conditionEndTime) return;

			const timeout = Sugar.Date.range(`now`, `${conditionEndTime}`).milliseconds();
			setTimeout(() => {
				nrp.emit('updateUserSocketRooms', {
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
					nrp.emit('updateUserSocketRooms', {
						userId: data.userId,
						appId: data.appId,
					});
					this._policyCloseSocketEvents.splice(idx - 1, 1);
				}, nearlyExpired);
			}
		}
	}

	async _disconnectQueryBasedSocket(nrp, data) {
		const schemaBasedConditionIdx = this._policyCloseSocketEvents.findIndex((c) => {
			return c.collection === data.updatedSchema && c.identifier === data.identifier;
		});

		if (schemaBasedConditionIdx === -1) return;

		nrp.emit('updateUserSocketRooms', {
			userId: data.userId,
			appId: data.appId,
		});

		this._policyCloseSocketEvents.splice(schemaBasedConditionIdx, 1);
	}

	__getRoomSharedCollections(appPolicyRooms, policyRoomsKeys, roomKey) {
		return policyRoomsKeys.reduce((arr, key) => {
			if (Object.keys(appPolicyRooms[key]).some((i) => i === roomKey)) {
				arr.push(key);
			}

			return arr;
		}, []);
	}
}

module.exports = BootstrapSocket;
