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

const Model = require('./model');
const Logging = require('./logging');
const AccessControl = require('./access-control');
const AccessControlConditions = require('./access-control/conditions');

const Datastore = require('./datastore');

class BootstrapSocket {
	constructor() {
		Logging.setLogLevel(Logging.Constants.LogLevel.INFO);

		this.processes = os.cpus().length;
		this.processes = 1;
		this.workers = [];

		this.__apps = [];
		this.__namespace = {};

		this._dataShareSockets = {};

		this.__superApps = [];

		this._attributeCloseSocketEvents = [];

		this._oneWeekMilliseconds = Sugar.Number.day(7);

		this.isPrimary = Config.sio.app === 'primary';

		this.emitter = null;

		this.primaryDatastore = Datastore.createInstance(Config.datastore, true);

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

			nrp.on('queueAttributeCloseSocketEvent', async (data) => {
				await this._queueAttributeCloseSocketEvent(nrp, data.attributes, data.schemaNames);
			});

			nrp.on('queueBasedConditionQuery', async (data) => {
				this._attributeCloseSocketEvents.push(data);
			});

			nrp.on('accessControlPolicy:disconnectQueryBasedSocket', async (data) => {
				await this._disconnectQueryBasedSocket(nrp, data.updatedSchema, data.id);
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
			if (!app._token) return Logging.logWarn(`App with no token`);

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

				const roomName = (await AccessControl.getAttributesChainForToken(token.attributes)).map((attr) => attr.name).join(',');
				socket.join(roomName);
				Logging.log(`[${apiPath}][${token.role}] Connected ${socket.id} to room ${roomName}`);
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

	__onActivity(data) {
		const apiPath = data.appAPIPath;

		if (!this.emitter) {
			throw new Error('SIO Emitter isn\'t defined');
		}

		this.__namespace['stats'].emitter.emit('activity', 1);

		Logging.logSilly(`[${apiPath}][${data.attribute}][${data.verb}] activity in on ${data.path}`);

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
			Logging.logDebug(`[${apiPath}][${data.attribute}][${data.verb}] ${data.path} - Early out as it isn't public.`);
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

		if (data.attribute) {
			if (!this.__namespace[apiPath].sequence[data.attribute]) {
				this.__namespace[apiPath].sequence[data.attribute] = 0;
			}
			Logging.logDebug(`[${apiPath}][${data.attribute}][${data.verb}] ${data.path}`);
			this.__namespace[apiPath].sequence[data.attribute]++;
			this.__namespace[apiPath].emitter.in(data.attribute).emit('db-activity', {
				data: data,
				sequence: this.__namespace[apiPath].sequence[data.attribute],
			});
		} else {
			Logging.logDebug(`[${apiPath}][global]: [${data.verb}] ${data.path}`);
			this.__namespace[apiPath].sequence.global++;
			this.__namespace[apiPath].emitter.emit('db-activity', {
				data: data,
				sequence: this.__namespace[apiPath].sequence.global,
			});
		}
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

	async _queueAttributeCloseSocketEvent(nrp, attributes, schemaNames) {
		const prioritisedConditions = await AccessControlConditions.__prioritiseConditionOrder(attributes);
		await prioritisedConditions.reduce(async (prev, attribute) => {
			await prev;

			const name = attribute.name;
			const conditionStr = JSON.stringify(attribute.condition);
			let attributeIdx = this._attributeCloseSocketEvents.findIndex((event) => event.name === name);
			if (attributeIdx === -1) {
				attributeIdx = this._attributeCloseSocketEvents.push({
					name,
					conditions: [
						conditionStr,
					],
				});
			} else {
				const attributeConditionExist = this._attributeCloseSocketEvents[attributeIdx].conditions.some((c) => c === conditionStr);
				if (attributeConditionExist) return;

				this._attributeCloseSocketEvents[attributeIdx].conditions.push(conditionStr);
			}

			await this._queueEvent(nrp, attribute, schemaNames, attributeIdx);
		}, Promise.resolve());

		return;
	}

	async _queueEvent(nrp, attribute, schemaNames, idx) {
		const conditions = attribute.condition;
		const dateTimeBasedCondition = await AccessControlConditions.isAttributeDateTimeBased(conditions);
		if (dateTimeBasedCondition) {
			await this._queueDateTimeEvent(nrp, attribute, dateTimeBasedCondition, idx);
			return;
		}

		const queryBasedCondition = await AccessControlConditions.isAttributeQueryBasedCondition(conditions, schemaNames);
		if (queryBasedCondition) {
			nrp.emit('queueBasedConditionQuery', {
				name: attribute.name,
				collection: queryBasedCondition.name,
				entityId: queryBasedCondition.entityId,
				attribute,
			});
		}
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
				this._attributeCloseSocketEvents.splice(idx - 1, 1);
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
					this._attributeCloseSocketEvents.splice(idx - 1, 1);
				}, nearlyExpired);
			}
		}
	}

	async _disconnectQueryBasedSocket(nrp, updatedSchema, id) {
		const schemaBasedConditionIdx = this._attributeCloseSocketEvents.findIndex((c) => {
			return c.collection === updatedSchema && c.entityId === id;
		});
		if (schemaBasedConditionIdx === -1) return;

		const attribute = this._attributeCloseSocketEvents[schemaBasedConditionIdx].attribute;
		const attributeName = attribute.name;

		nrp.emit('accessControlPolicy:disconnectSocket', {
			id: attribute.name,
			type: (attribute.targetedSchema.length > 0)? attribute.targetedSchema : 'generic',
		});

		this._attributeCloseSocketEvents.splice(schemaBasedConditionIdx, 1);

		this._attributeCloseSocketEvents.forEach((obj, idx) => {
			if (obj.name === attributeName) {
				const conditionIdx = obj.conditions.findIndex((c) => c === JSON.stringify(attribute.condition));
				this._attributeCloseSocketEvents[idx].conditions.splice(conditionIdx, 1);
			}
		});
	}
}

module.exports = BootstrapSocket;
