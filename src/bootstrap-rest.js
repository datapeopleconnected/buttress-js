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
const EventEmitter = require('events');
const cluster = require('cluster');
const express = require('express');
const cors = require('cors');
const methodOverride = require('method-override');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const NRP = require('node-redis-pubsub');

const Config = require('node-env-obj')();

const Model = require('./model');
const Routes = require('./routes');
const Logging = require('./logging');
const Schema = require('./schema');
const shortId = require('./helpers').shortId;

const Datastore = require('./datastore');

const Plugins = require('./plugins');

const AccessControl = require('./access-control');

morgan.token('id', (req) => req.id);

Error.stackTraceLimit = Infinity;
class BootstrapRest extends EventEmitter {
	constructor() {
		super();

		const ConfigWorkerCount = parseInt(Config.app.workers);
		this.workerProcesses = (isNaN(ConfigWorkerCount)) ? os.cpus().length : ConfigWorkerCount;

		this.workers = [];

		this.routes = null;

		this.id = (cluster.isMaster) ? 'MASTER' : cluster.worker.id;

		this.primaryDatastore = Datastore.createInstance(Config.datastore, true);

		this._restServer = null;
		this._nrp = null;
	}

	async init() {
		Logging.log(`Connecting to primary datastore...`);
		await this.primaryDatastore.connect();

		this._nrp = new NRP(Config.redis);

		// Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
		await Model.init(this._nrp);
		await AccessControl.init(this._nrp);

		if (cluster.isMaster) {
			await this.__initMaster();
		} else {
			await this.__initWorker();
		}

		await Plugins.initialise(
			Plugins.APP_TYPE.REST,
			(cluster.isMaster) ? Plugins.PROCESS_ROLE.MAIN : Plugins.PROCESS_ROLE.WORKER,
			(Config.rest.app === 'primary') ? Plugins.INFRASTRUCTURE_ROLE.PRIMARY : Plugins.INFRASTRUCTURE_ROLE.SECONDARY,
		);

		if (!cluster.isMaster) {
			Plugins.initRoutes(this.routes);
		}

		return cluster.isMaster;
	}

	async clean() {
		Logging.logSilly('BootstrapRest:clean');
		// Should close down all connections
		// Kill worker processes
		for (let x = 0; this.workers.length; x++) {
			Logging.logSilly(`Killing worker ${x}`);
			this.workers[x].kill();
		}

		// Destroy all routes
		// this.routes.clean();

		// Destory all models
		// Model.clean();

		if (this._restServer) {
			Logging.logSilly('Closing express server');
			this._restServer.close((err) => (err) ? process.exit(1) : Logging.logSilly(`Express server closed`));
		}

		// Close out the NRP connection
		if (this._nrp) {
			Logging.logSilly('Closing node redis pubsub connection');
			this._nrp.quit();
		}

		// Close Datastore connections
		Logging.logSilly('Closing down all datastore connections');
		Datastore.clean();
	}

	async __initMaster() {
		const isPrimary = Config.rest.app === 'primary';

		this._nrp.on('app-schema:updated', (data) => {
			Logging.logDebug(`App Schema Updated: ${data.appId}`);
			this.notifyWorkers({
				type: 'app-schema:updated',
				appId: data.appId,
			});
		});
		this._nrp.on('app-routes:bust-cache', () => {
			Logging.logDebug(`App Routes: Bust token cache`);
			this.notifyWorkers({
				type: 'app-routes:bust-cache',
			});
		});

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

		Plugins.on('request', (req, res) => app.handle(req, res));

		process.on('unhandledRejection', (error) => {
			Logging.logError(error);
		});

		process.on('message', (payload) => this.handleProcessMessage(payload));

		await Model.initCoreModels();

		const localSchema = this._getLocalSchemas();
		Model.App.setLocalSchema(localSchema);

		this.routes = new Routes(app);

		await this.routes.init(this._nrp);
		await this.routes.initRoutes();

		this._restServer = await app.listen(Config.listenPorts.rest);

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
		}
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
			type: Model.Token.Constants.Type.SYSTEM,
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
