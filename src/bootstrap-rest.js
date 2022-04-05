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

const path = require('path');
const fs = require('fs');
const os = require('os');
const cluster = require('cluster');
const express = require('express');
const methodOverride = require('method-override');
const bodyParser = require('body-parser');
const morgan = require('morgan');

const Config = require('node-env-obj')('../');
const Model = require('./model');
const Routes = require('./routes');
const Logging = require('./logging');
const Schema = require('./schema');
const MongoClient = require('mongodb').MongoClient;
const NRP = require('node-redis-pubsub');
const shortId = require('./helpers').shortId;

morgan.token('id', (req) => req.id);

Error.stackTraceLimit = Infinity;
class BootstrapRest {
	constructor() {
		Logging.setLogLevel(Logging.Constants.LogLevel.INFO);

		this.processes = os.cpus().length;
		this.workers = [];

		this.routes = null;

		let restInitTask = null;
		if (cluster.isMaster) {
			restInitTask = (db) => this.__initMaster(db);
		} else {
			restInitTask = (db) => this.__initWorker(db);
		}

		return this.__nativeMongoConnect()
			.then(restInitTask)
			.then(() => cluster.isMaster);
	}

	__initMaster(db) {
		const isPrimary = Config.rest.app === 'primary';
		let initMasterTask = Promise.resolve();

		if (isPrimary) {
			Logging.logVerbose(`Primary Master REST`);
			initMasterTask = Model.initCoreModels(db)
				.then(() => this.__systemInstall())
				.then(() => Model.App.findAll().toArray())
				.then((apps) => this.__updateAppSchema(apps))
				.then(() => Model.initSchema())
				.catch((e) => Logging.logError(e));
		} else {
			Logging.logVerbose(`Secondary Master REST`);
		}

		const nrp = new NRP(Config.redis);
		nrp.on('app-schema:updated', (data) => {
			Logging.logDebug(`App Schema Updated: ${data.appId}, notifying ${this.workers.length} Workers`);
			this.workers.forEach((w) => w.send({
				type: 'app-schema:updated',
				appId: data.appId,
			}));
		});
		nrp.on('app-routes:bust-cache', (data) => {
			Logging.logDebug(`App Routes: Bust token cache, notifying ${this.workers.length} Workers`);
			this.workers.forEach((w) => w.send({
				type: 'app-routes:bust-cache',
			}));
		});

		return initMasterTask
			.then(() => this.__spawnWorkers());
	}

	__initWorker(db) {
		const app = express();
		app.use(morgan(`:date[iso] [${cluster.worker.id}] [:id] :method :status :url :res[content-length] - :response-time ms - :remote-addr`));
		app.enable('trust proxy', 1);
		app.use(bodyParser.json({limit: '20mb'}));
		app.use(bodyParser.urlencoded({extended: true}));
		app.use(methodOverride());
		app.use(express.static(`${Config.paths.appData}/public`));

		process.on('unhandledRejection', (error) => {
			Logging.logError(error);
		});

		process.on('message', (payload) => {
			if (payload.type === 'app-schema:updated') {
				Logging.logDebug(`App Schema Updated: ${payload.appId}`);
				return Model.initSchema(db)
					.then(() => this.routes.regenerateAppRoutes(payload.appId));
			} else if (payload.type === 'app-routes:bust-cache') {
				Logging.logDebug(`App Routes: cache bust`);
				this.routes.loadTokens();
			}
		});

		return Model.init(db)
			.then(() => {
				const localSchema = this._getLocalSchemas();
				Model.App.setLocalSchema(localSchema);

				this.routes = new Routes(app);

				return this.routes.initRoutes();
			})
			.then(() => app.listen(Config.listenPorts.rest))
			.catch(Logging.Promise.logError());
	}

	__nativeMongoConnect() {
		const dbName = `${Config.app.code}-${Config.env}`;
		const mongoUrl = `mongodb://${Config.mongoDb.url}`;
		Logging.logDebug(`Attempting connection to ${mongoUrl}`);

		return MongoClient.connect(mongoUrl, Config.mongoDb.options)
			.then((client) => client.db(dbName))
			.catch(Logging.Promise.logError());
	}

	__spawnWorkers() {
		Logging.logVerbose(`Spawning ${this.processes} REST Workers`);

		const __spawn = (idx) => {
			this.workers[idx] = cluster.fork();
		};

		for (let x = 0; x < this.processes; x++) {
			__spawn(x);
		}
	}

	__systemInstall() {
		let isInstalled = false;

		Logging.log('Checking for existing apps.');

		return Model.App.findAll().toArray()
			.then((apps) => {
				if (apps.length > 0) {
					isInstalled = true;
					Logging.log('Existing apps found - Skipping install.');
					return {app: apps[0], token: null}; // If any apps, assume we've got a Super Admin app
				}

				Logging.log('No apps found - Creating super app.');
				return Model.App.add({
					name: `${Config.app.title} ADMIN`,
					type: Model.App.Constants.Type.SERVER,
					authLevel: Model.Token.Constants.AuthLevel.SUPER,
					permissions: [{route: '*', permission: '*'}],
					domain: '',
				});
			})
			.then((res) => {
				if (isInstalled) {
					return res.app;
				}

				const pathName = path.join(Config.paths.appData, 'super.json');
				Logging.log(`Super app created: ${res.app.id}`);
				return new Promise((resolve, reject) => {
					const app = Object.assign(res.app, {token: res.token.value});
					fs.writeFile(pathName, JSON.stringify(app), (err) => {
						if (err) {
							return reject(err);
						}
						Logging.log(`Created ${pathName}`);

						resolve(res.app);
					});
				});
			});
	}

	/**
	 * @return {Array} - content of json files loaded from local system
	 */
	_getLocalSchemas() {
		const filenames = fs.readdirSync(`${__dirname}/schema`);

		const files = [];
		for (let x = 0; x < filenames.length; x++) {
			const file = filenames[x];
			if (path.extname(file) === '.json') {
				files.push(require(`${__dirname}/schema/${path.basename(file, '.js')}`));
			}
		}
		return files;
	}

	__updateAppSchema(apps) {
		const schemaUpdates = [];

		// Load local defined schemas into super app
		const localSchema = this._getLocalSchemas();

		// Add local schema to Model.App
		Model.App.setLocalSchema(localSchema);

		// Build a update queue for merging local schema with each app schema
		apps.forEach((app) => {
			const appSchema = Schema.decode(app.__schema);
			const appShortId = shortId(app._id);
			Logging.log(`Adding ${localSchema.length} local schema for ${appShortId}:${app.name}:${appSchema.length}`);
			localSchema.forEach((cS) => {
				const appSchemaIdx = appSchema.findIndex((s) => s.name === cS.name);
				const schema = appSchema[appSchemaIdx];
				if (!schema) {
					return appSchema.push(cS);
				}
				schema.properties = Object.assign(schema.properties, cS.properties);
				appSchema[appSchemaIdx] = schema;
			});

			schemaUpdates.push(() => Model.App.updateSchema(app._id, appSchema));
		});

		// Run update queue
		return schemaUpdates.reduce((prev, task) => {
			return prev.then(() => task());
		}, Promise.resolve());
	}
}

module.exports = BootstrapRest;
