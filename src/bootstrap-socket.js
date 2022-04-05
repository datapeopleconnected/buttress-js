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

const os = require('os');
const cluster = require('cluster');
const net = require('net');
const Express = require('express');
const sio = require('socket.io');
const sioRedis = require('socket.io-redis');
const sioEmitter = require('socket.io-emitter');

const Config = require('node-env-obj')('../');
const Model = require('./model');
const Logging = require('./logging');
const MongoClient = require('mongodb').MongoClient;
// const ObjectId = require('mongodb').ObjectId;
const NRP = require('node-redis-pubsub');

class BootstrapSocket {
	constructor() {
		Logging.setLogLevel(Logging.Constants.LogLevel.INFO);

		this.processes = os.cpus().length;
		this.workers = [];

		this.__apps = [];
		this.__tokens = [];
		this.__namespace = {};

		this.__superApps = [];

		this.isPrimary = Config.sio.app === 'primary';

		this.emitter = null;

		let socketInitTask = null;
		if (cluster.isMaster) {
			socketInitTask = (db) => this.__initMaster(db);
		} else {
			socketInitTask = (db) => this.__initWorker(db);
		}

		return this.__nativeMongoConnect()
			.then(socketInitTask)
			.then(() => cluster.isMaster);
	}

	__initMaster(db) {
		const nrp = new NRP(Config.redis);

		this.emitter = sioEmitter(Config.redis);

		if (this.isPrimary) {
			Logging.logDebug(`Primary Master`);
			nrp.on('activity', (data) => this.__onActivityReceived(data));
		}

		return this.__initMongoConnect()
			.then((db) => {
			// Load Apps
				return new Promise((resolve, reject) => {
					Model.App.findAll().toArray((err, _apps) => {
						if (err) reject(err);
						resolve(this.__apps = _apps);
					});
				});
			})
			.then(() => {
			// Load Tokens
				return new Promise((resolve, reject) => {
					Model.Token.findAll().toArray((err, _tokens) => {
						if (err) reject(err);
						resolve(this.__tokens = _tokens);
					});
				});
			})
			.then(() => {
				this.__namespace['stats'] = {
					emitter: this.emitter.of(`/stats`),
					sequence: {
						super: 0,
						global: 0,
					},
				};

				// Spawn worker processes, pass through build app objects
				this.__apps.map((app) => {
					const token = this.__tokens.find((t) => {
						return app._token && t._id.equals(app._token);
					});
					if (!token) {
						Logging.logWarn(`No Token found for ${app.name}`);
						return null;
					}

					app.token = token;
					app.publicId = Model.App.genPublicUID(app.name, app._id);

					const isSuper = token.authLevel > 2;
					Logging.log(`Name: ${app.name}, App ID: ${app._id}, Public ID: ${app.publicId}`);

					this.__namespace[app.publicId] = {
						emitter: this.emitter.of(`/${app.publicId}`),
						sequence: {
							super: 0,
							global: 0,
						},
					};
					Logging.logDebug(`[${app.publicId}]: Created Namespace for ${app.name}, ${(isSuper) ? 'SUPER' : ''}`);

					if (isSuper) {
						this.__superApps.push(app.publicId);
					}

					return app;
				}).filter((app) => app);

				this.__spawnWorkers({
					apps: this.__apps,
					tokens: this.__tokens,
				});
			});
	}

	__initWorker() {
		const app = new Express();
		const server = app.listen(0, 'localhost');
		const io = sio(server);
		const namespace = [];
		io.origins('*:*');
		io.adapter(sioRedis(Config.redis));

		const stats = io.of(`/stats`);
		stats.on('connect', (socket) => {
			Logging.logSilly(`${socket.id} Connected on /stats`);
			socket.on('disconnect', () => {
				Logging.logSilly(`${socket.id} Disconnect on /stats`);
			});
		});

		process.on('message', (message, input) => {
			if (message === 'buttress:connection') {
				const connection = input;
				server.emit('connection', connection);
				connection.resume();
				return;
			}
			if (message['buttress:initAppTokens']) {
				const appTokens = message['buttress:initAppTokens'];
				appTokens.apps.forEach((app) => {
					namespace.push(this.__initSocketNamespace(io, app.publicId, appTokens));
				});
			}
		});

		process.send('workerInitiated');
	}

	__onActivityReceived(data) {
		const publicId = data.appPId;

		if (!this.emitter) {
			throw new Error('SIO Emitter isn\'t defined');
		}

		this.__namespace['stats'].emitter.emit('activity', 1);

		// Super apps?
		if (data.isSuper) {
			this.__superApps.forEach((superPublicId) => {
				this.__namespace[superPublicId].sequence['super']++;
				this.__namespace[superPublicId].emitter.emit('db-activity', {
					data: data,
					sequence: this.__namespace[superPublicId].sequence['super'],
				});
				Logging.logDebug(`[${superPublicId}][super][${data.verb}] ${data.path}`);
			});
			return;
		}

		// Disable broadcasting to public space
		if (data.broadcast === false) {
			Logging.logDebug(`[${publicId}][${data.role}][${data.verb}] ${data.path} - Early out as it isn't public.`);
			return;
		}

		// Broadcast on requested channel
		if (!this.__namespace[publicId]) {
			throw new Error('Trying to access namespace that doesn\'t exist');
		}

		if (data.role) {
			if (!this.__namespace[publicId].sequence[data.role]) {
				this.__namespace[publicId].sequence[data.role] = 0;
			}
			Logging.logDebug(`[${publicId}][${data.role}][${data.verb}] ${data.path}`);
			this.__namespace[publicId].sequence[data.role]++;
			this.__namespace[publicId].emitter.in(data.role).emit('db-activity', {
				data: data,
				sequence: this.__namespace[publicId].sequence[data.role],
			});
		} else {
			Logging.logDebug(`[${publicId}][global]: [${data.verb}] ${data.path}`);
			this.__namespace[publicId].sequence.global++;
			this.__namespace[publicId].emitter.emit('db-activity', {
				data: data,
				sequence: this.__namespace[publicId].sequence.global,
			});
		}
	}

	__spawnWorkers(appTokens) {
		Logging.log(`Spawning ${this.processes} Socket Workers`);

		for (let x = 0; x < this.processes; x++) {
			this.workers[x] = cluster.fork();
			this.workers[x].on('message', (res) => {
				if (res === 'workerInitiated') {
					this.workers[x].send({'buttress:initAppTokens': appTokens});
				}
			});
		}

		net.createServer({pauseOnConnect: true}, (connection) => {
			const worker = this.workers[this.__indexFromIP(connection.remoteAddress, this.processes)];
			worker.send('buttress:connection', connection);
		}).listen(Config.listenPorts.sock);
	}

	__initSocketNamespace(io, publicId, appTokens) {
		const namespace = io.of(`/${publicId}`);
		namespace.on('connection', (socket) => {
			const userToken = socket.handshake.query.token;
			const token = appTokens.tokens.find((t) => t.value === userToken);
			if (!token) {
				Logging.logDebug(`Invalid token, closing connection: ${socket.id}`);
				return socket.disconnect(0);
			}

			const app = appTokens.apps.find((a) => a.publicId === publicId);
			if (!app) {
				Logging.logDebug(`Invalid app, closing connection: ${socket.id}`);
				return socket.disconnect(0);
			}

			if (token.role) {
				socket.join(token.role);
				Logging.log(`[${publicId}][${token.role}] Connected ${socket.id}`);
			} else {
				Logging.log(`[${publicId}][Global] Connected ${socket.id}`);
			}

			socket.on('disconnect', () => {
				Logging.logSilly(`[${publicId}] Disconnect ${socket.id}`);
			});
		});

		return namespace;
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

	__nativeMongoConnect() {
		const dbName = `${Config.app.code}-${Config.env}`;
		const mongoUrl = `mongodb://${Config.mongoDb.url}`;
		Logging.logDebug(`Attempting connection to ${mongoUrl}`);

		return MongoClient.connect(mongoUrl, Config.mongoDb.options)
			.then((client) => client.db(dbName))
			.catch(Logging.Promise.logError());
	}

	__initMongoConnect() {
		return this.__nativeMongoConnect()
			.then((db) => {
				Model.init(db);
				return db;
			})
			.catch((e) => Logging.logError(e));
	}
}

module.exports = BootstrapSocket;
