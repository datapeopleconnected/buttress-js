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
const cors = require('cors');
const methodOverride = require('method-override');
const bodyParser = require('body-parser');
const morgan = require('morgan');

const Config = require('node-env-obj')();
const Model = require('./model');
const Routes = require('./routes');
const Logging = require('./logging');
const Schema = require('./schema');
const NRP = require('node-redis-pubsub');
const shortId = require('./helpers').shortId;

const Datastore = require('./datastore');

morgan.token('id', (req) => req.id);

Error.stackTraceLimit = Infinity;
class BootstrapRest {
	constructor() {
		Logging.setLogLevel(Logging.Constants.LogLevel.INFO);

		const ConfigWorkerCount = parseInt(Config.app.workers);
		this.workerProcesses = (isNaN(ConfigWorkerCount)) ? os.cpus().length : ConfigWorkerCount;

		this.workers = [];

		this.routes = null;

		this.id = (cluster.isMaster) ? 'MASTER' : cluster.worker.id;

		this.primaryDatastore = Datastore.createInstance(Config.datastore, true);
	}

	async init() {
		Logging.log(`Connecting to primary datastore...`);
		await this.primaryDatastore.connect();
		if (cluster.isMaster) {
			await this.__initMaster();
		} else {
			await this.__initWorker();
		}

		return cluster.isMaster;
	}

	async __initMaster() {
		const isPrimary = Config.rest.app === 'primary';

		const nrp = new NRP(Config.redis);
		nrp.on('app-schema:updated', (data) => {
			Logging.logDebug(`App Schema Updated: ${data.appId}`);
			this.notifyWorkers({
				type: 'app-schema:updated',
				appId: data.appId,
			});
		});
		nrp.on('app-routes:bust-cache', () => {
			Logging.logDebug(`App Routes: Bust token cache`);
			this.notifyWorkers({
				type: 'app-routes:bust-cache',
			});
		});

		// Not needed for now
		// nrp.on('app-routes:bust-attribute-cache', (data) => {
		// 	Logging.logDebug(`App Routes: Bust attributes cache for ${data.appId}, notifying ${this.workers.length} Workers`);
		// 	this.notifyWorkers({
		// 		type: 'app-routes:bust-attribute-cache',
		// 		appId: data.appId,
		// 	});
		// });

		if (isPrimary) {
			Logging.logVerbose(`Primary Master REST`);
			await Model.initCoreModels();
			await this.__systemInstall();
			await this.__updateAppSchema();
		} else {
			Logging.logVerbose(`Secondary Master REST`);
		}

		if (this.workerProcesses === 0) {
			Logging.logWarn(`Running in SINGLE Instance mode, BUTTRESS_APP_WORKERS has been set to 0`);
			await this.__initWorker();
		} else {
			await this.__spawnWorkers();
		}

		if (isPrimary) {
			// await Model.initSchema();
		}
	}

	async __initWorker() {
		const app = express();
		app.use(morgan(`:date[iso] [${this.id}] [:id] :method :status :url :res[content-length] - :response-time ms - :remote-addr`));
		app.enable('trust proxy', 1);
		app.use(bodyParser.json({limit: '20mb'}));
		app.use(bodyParser.urlencoded({extended: true}));
		app.use(methodOverride());
		app.use(cors({
			origin: true,
			methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,SEARCH',
			credentials: true,
		}));
		app.use(express.static(`${Config.paths.appData}/public`));

		process.on('unhandledRejection', (error) => {
			Logging.logError(error);
		});

		process.on('message', (payload) => this.handleProcessMessage(payload));

		await Model.initCoreModels();

		const localSchema = this._getLocalSchemas();
		Model.App.setLocalSchema(localSchema);

		this.routes = new Routes(app);

		await this.routes.initRoutes();

		await app.listen(Config.listenPorts.rest);

		await Model.initSchema();
		await this.routes.initAppRoutes();
	}

	async notifyWorkers(payload) {
		if (this.workerProcesses > 0) {
			Logging.logDebug(`notifying ${this.workers.length} Workers`);
			this.workers.forEach((w) => w.send(payload));
		} else {
			Logging.logSilly(`single instance mode notification`);
			await this.handleProcessMessage(payload);
		}
	}

	async handleProcessMessage(payload) {
		if (payload.type === 'app-schema:updated') {
			if (!this.routes) return Logging.logDebug(`Skipping app schema update, router not created yet`);
			Logging.logDebug(`App Schema Updated: ${payload.appId}`);
			await Model.initSchema();
			await this.routes.regenerateAppRoutes(payload.appId);
			Logging.logDebug(`Models & Routes regenereated: ${payload.appId}`);
		} else if (payload.type === 'app-routes:bust-cache') {
			if (!this.routes) return Logging.logDebug(`Skipping token cache bust, router not created yet`);
			// TODO: Maybe do this better than
			Logging.logDebug(`App Routes: cache bust`);
			await this.routes.loadTokens();
		} // else if (payload.type === 'app-routes:bust-attribute-cache') { // not needed for now
		// if (!this.routes) return Logging.logDebug(`Skipping attributes cache bust, router not created yet`);
		// Logging.logDebug(`App Routes: attributes cache bust`);
		// await this.routes.loadAttributes(payload.appId);
		// }
	}

	__spawnWorkers() {
		Logging.logVerbose(`Spawning ${this.workerProcesses} REST Workers`);

		const __spawn = (idx) => {
			this.workers[idx] = cluster.fork();
		};

		for (let x = 0; x < this.workerProcesses; x++) {
			__spawn(x);
		}
	}

	async __systemInstall() {
		Logging.log('Checking for existing apps.');

		const pathName = path.join(Config.paths.appData, 'super.json');

		const appCount = await Model.App.count();

		if (appCount > 0) {
			Logging.log('Existing apps found - Skipping install.');

			if (fs.existsSync(pathName)) {
				Logging.logWarn(`--------------------------------------------------------`);
				Logging.logWarn(' !!WARNING!!');
				Logging.logWarn(' Super token file still exists on the file system.');
				Logging.logWarn(' Please capture this token and remove delete the file:');
				Logging.logWarn(` rm ${pathName}`);
				Logging.logWarn(`--------------------------------------------------------`);
			}

			return;
		}

		const res = await Model.App.add({
			name: `${Config.app.title} TEST`,
			type: Model.App.Constants.Type.SERVER,
			authLevel: Model.Token.Constants.AuthLevel.SUPER,
			permissions: [{route: '*', permission: '*'}],
			apiPath: 'bjs',
			domain: '',
		});

		await new Promise((resolve, reject) => {
			const app = Object.assign(res.app, {token: res.token.value});

			if (!fs.existsSync(Config.paths.appData)) fs.mkdirSync(Config.paths.appData, {recursive: true});

			fs.writeFile(pathName, JSON.stringify(app), (err) => {
				if (err) return reject(err);
				Logging.log(`--------------------------------------------------------`);
				Logging.log(` SUPER APP CREATED: ${res.app._id}`);
				Logging.log(``);
				Logging.log(` Token can be found at the following path:`);
				Logging.log(` ${pathName}`);
				Logging.log(``);
				Logging.log(` IMPORTANT:`);
				Logging.log(` Please delete this file once you've captured the token`);
				Logging.log(`--------------------------------------------------------`);
				resolve();
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

	async __updateAppSchema() {
		// Load local defined schemas into super app
		const localSchema = this._getLocalSchemas();

		// Add local schema to Model.App
		Model.App.setLocalSchema(localSchema);

		const rxsApps = await Model.App.findAll();
		for await (const app of rxsApps) {
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

			await Model.App.updateSchema(app._id, appSchema);
		}
	}
}

module.exports = BootstrapRest;
