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

			nrp.on('dbClientLeaveRoom', async (data) => {
				data.rooms.forEach((room) => {
					this.__namespace[data.apiPath].emitter.in(room).emit('db-disconnect-room', {
						target: data.type,
						sequence: this.__namespace[data.apiPath].sequence[room],
					});
				});
			});

			nrp.on('queuePolicyRoomCloseSocketEvent', async (data) => {
				await this._queuePolicyRoomCloseSocketEvent(nrp, data.policies, data.schemaNames);
			});

			nrp.on('queueBasedConditionQuery', async (data) => {
				this._policyCloseSocketEvents.push(data);
			});

			nrp.on('accessControlPolicy:disconnectQueryBasedSocket', async (data) => {
				await this._disconnectQueryBasedSocket(nrp, data.updatedSchema, data.id);
			});

			nrp.on('setMainPolicyRooms', async (data) => {
				this._policyRooms = data;
				nrp.emit('finishedSettingMainPolicyRooms', true);
			});

			nrp.on('getPolicyRooms', async () => {
				nrp.emit('sendPolicyRooms', this._policyRooms);
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

				const policyRooms = await new Promise((resolve) => {
					nrp.emit('getPolicyRooms', {});
					nrp.on('sendPolicyRooms', (data) => resolve(data));
				});

				if (!policyRooms || (policyRooms && (Array.isArray(policyRooms) || typeof policyRooms !== 'object'))) {
					Logging.logWarn(`policyRooms is returning an invalid value, closing connection: ${socket.id}`);
					return next('invalid-policy-rooms');
				}

				if (!policyRooms[app._id]) {
					policyRooms[app._id] = {};
				}

				const userRooms = await AccessControl.getUserRooms(user, socket.request, app._id, policyRooms[app._id]);

				await new Promise((resolve) => {
					nrp.emit('setMainPolicyRooms', policyRooms);
					nrp.on('finishedSettingMainPolicyRooms', () => resolve());
				});

				socket.join(userRooms);
				Logging.log(`[${apiPath}][${token._id}] Connected ${socket.id} to room ${userRooms.join(', ')}`);
			} else {
				Logging.log(`[${apiPath}][Global] Connected ${socket.id}`);
			}

			socket.on('disconnect', () => {
				Logging.logSilly(`[${apiPath}] Disconnect ${socket.id}`);
			});

			nrp.on('accessControlPolicy:disconnectSocket', async (data) => {
				const rooms = socket.adapter.rooms;
				const regex = new RegExp(data.room, 'g');
				const attributeRooms = [];
				rooms.forEach((value, key) => {
					if (key.match(regex)) {
						attributeRooms.push(key);
					}
				});

				socket.leave(data.room);

				nrp.emit('dbClientLeaveRoom', {
					apiPath,
					type: data.type,
					rooms: attributeRooms,
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

		if (data.isUser) {
			await this.__broadcastToUsers(data);
		} else {
			Logging.logDebug(`[${apiPath}][global]: [${data.verb}] ${data.path}`);
			this.__namespace[apiPath].sequence.global++;
			this.__namespace[apiPath].emitter.emit('db-activity', {
				data: data,
				sequence: this.__namespace[apiPath].sequence.global,
			});
		}
	}

	async __broadcastToUsers(data) {
		const appId = data.appId;
		const verb = data.verb;
		const collection = data.path.match(/(?<=)[aA-zZ]*(?=)/g).filter((v) => v).shift();
		const broadcastRooms = this._policyRooms[appId][collection];

		for await (const roomKey of Object.keys(broadcastRooms)) {
			const room = broadcastRooms[roomKey];
			const roomQueryKeys = Object.keys(room.access.query);
			const roomProjectionKeys = (room.access.projection) ? room.access.projection : [];
			if (roomQueryKeys.length < 1 && roomProjectionKeys.length < 1) {
				this.__broadcastData(data, roomKey);
				continue;
			}

			let broadcast = true;
			roomQueryKeys.forEach((key) => {
				const operator = Object.keys(room.access.query[key]).pop();
				const rhs = room.access.query[key][operator];
				let lhs = (!Array.isArray(data.response)) ? data.response[key] : data.response.find((item) => item.path === key);
				lhs = (typeof lhs === 'object') ? lhs.value : lhs;
				const match = AccessControlConditions.evaluateOperation(lhs, rhs, operator);
				if (!match) broadcast = false;
			});

			if (!broadcast) {
				data.verb = 'delete';
				this.__broadcastData(data, roomKey);
				continue;
			}

			if (verb === 'put') {
				const appShortId = shortId(appId);
				data.response = await Model[`${appShortId}-${collection}`].findOne({_id: new ObjectId(data.params.id)});
				data.verb = 'post';
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
		});
	}

	__clearUserLocalData(data) {
		const apiPath = data.appAPIPath;

		this.__namespace[apiPath].emitter.emit('clear-local-db', {
			data: data,
		});
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

	async _queuePolicyRoomCloseSocketEvent(nrp, policies, schemaNames) {
		await Object.keys(policies).reduce(async (prev, key) => {
			await prev;

			const policy = policies[key];
			const name = policy.name;
			const conditionStr = policy.conditions.reduce((str, condition) => str = str + JSON.stringify(condition), '');
			let policyIdx = this._policyCloseSocketEvents.findIndex((event) => event.name === name);
			if (policyIdx === -1) {
				policyIdx = this._policyCloseSocketEvents.push({
					name,
					conditions: [
						conditionStr,
					],
				});
			} else {
				const policyConditionExist = this._policyCloseSocketEvents[policyIdx].conditions.some((c) => c === conditionStr);
				if (policyConditionExist) return;

				this._policyCloseSocketEvents[policyIdx].conditions.push(conditionStr);
			}

			await this._queueEvent(nrp, policy, schemaNames, policyIdx);
		}, Promise.resolve());
	}

	async _queueEvent(nrp, policy, schemaNames, idx) {
		const conditions = policy.conditions;
		conditions.reduce(async (prev, condition) => {
			await prev;
			const dateTimeBasedCondition = await AccessControlConditions.isPolicyDateTimeBased(condition);
			if (dateTimeBasedCondition) {
				// await this._queueDateTimeEvent(nrp, policy, dateTimeBasedCondition, idx);
				// return;
			}

			// const queryBasedCondition = await AccessControlConditions.isAttributeQueryBasedCondition(conditions, schemaNames);
			// if (queryBasedCondition) {
			// 	nrp.emit('queueBasedConditionQuery', {
			// 		name: policy.name,
			// 		collection: queryBasedCondition.name,
			// 		entityId: queryBasedCondition.entityId,
			// 	});
			// }
		}, Promise.resolve());
	}

	async _queueDateTimeEvent(nrp, attribute, dateTimeBasedCondition, idx) {
		const envVars = attribute.environmentVar;
		if (dateTimeBasedCondition === 'time') {
			const conditionEndTime = AccessControlConditions.getEnvironmentVar(envVars, 'env.endTime');
			if (!conditionEndTime) return;

			const timeout = Sugar.Date.range(`now`, `${conditionEndTime}`).milliseconds();
			setTimeout(() => {
				nrp.emit('accessControlPolicy:disconnectSocket', {
					id: attribute.name,
					type: 'generic',
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
					nrp.emit('accessControlPolicy:disconnectSocket', {
						id: attribute.name,
						type: 'generic',
					});
					this._policyCloseSocketEvents.splice(idx - 1, 1);
				}, nearlyExpired);
			}
		}
	}

	async _disconnectQueryBasedSocket(nrp, updatedSchema, id) {
		const schemaBasedConditionIdx = this._policyCloseSocketEvents.findIndex((c) => {
			return c.collection === updatedSchema && c.entityId === id;
		});
		if (schemaBasedConditionIdx === -1) return;

		const attribute = this._policyCloseSocketEvents[schemaBasedConditionIdx].attribute;
		const attributeName = attribute.name;

		nrp.emit('accessControlPolicy:disconnectSocket', {
			id: attribute.name,
			type: (attribute.targetedSchema.length > 0)? attribute.targetedSchema : 'generic',
		});

		this._policyCloseSocketEvents.splice(schemaBasedConditionIdx, 1);

		this._policyCloseSocketEvents.forEach((obj, idx) => {
			if (obj.name === attributeName) {
				const conditionIdx = obj.conditions.findIndex((c) => c === JSON.stringify(attribute.condition));
				this._policyCloseSocketEvents[idx].conditions.splice(conditionIdx, 1);
			}
		});
	}
}

module.exports = BootstrapSocket;
