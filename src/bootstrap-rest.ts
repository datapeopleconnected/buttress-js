'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
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

import path from 'path';
import fs from 'fs';
import cluster from 'cluster';
import Express from 'express';
import {RedisClient, createClient} from 'redis';
import cors from 'cors';
import methodOverride from 'method-override';
import bodyParser from 'body-parser';

import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;

import Bootstrap, {LocalProcessMessage} from './bootstrap';
const Model = require('./model');
const Routes = require('./routes');
const Logging = require('./helpers/logging');
const Schema = require('./schema');
import {shortId} from './helpers';

import {SourceDataSharingRouting} from './services/source-ds-routing';

import Datastore from './datastore';
import Plugins from './plugins';
const AccessControl = require('./access-control');

// morgan.token('id', (req) => req.id);

Error.stackTraceLimit = Infinity;
export default class BootstrapRest extends Bootstrap {
	routes: any;
	primaryDatastore: any;

	_restServer: Express.Application;
	_installMode: boolean;

	constructor(installMode = false) {
		super();

		this.routes = null;

		this.primaryDatastore = Datastore.createInstance(Config.datastore, true);

		this._restServer = null;

		this._installMode = process.env.INSTALL_MODE === 'true' || installMode || false;
	}

	async init(): Promise<boolean> {
		await super.init();

		Logging.logDebug(`Connecting to primary datastore...`);
		await this.primaryDatastore.connect();

		const redisClient = this.__services.get('redisClient');
		if (redisClient === undefined) throw new Error('Redis client not found whilst trying to init BootstrapRest');

		// Register some services.
		this.__services.set('redisClient', createClient({
			port: parseInt(Config.redis.port, 10) || 6379,
			host: Config.redis.host,
			prefix: Config.redis.scope
		}));
		this.__services.set('sdsRouting', new SourceDataSharingRouting(redisClient as RedisClient));
		this.__services.set('modelManager', Model);

		// Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
		Logging.logDebug(`Init process libs...`);
		await Model.init(this.__services);
		await AccessControl.init(this.__nrp);
		await Plugins.initialise(
			Plugins.APP_TYPE.REST,
			(cluster.isMaster) ? Plugins.PROCESS_ROLE.MAIN : Plugins.PROCESS_ROLE.WORKER,
			(Config.rest.app === 'primary') ? Plugins.INFRASTRUCTURE_ROLE.PRIMARY : Plugins.INFRASTRUCTURE_ROLE.SECONDARY,
		);

		return await this.__createCluster();
	}

	async clean() {
		await super.clean();
		Logging.logDebug('Shutting down all connections');
		Logging.logSilly('BootstrapRest:clean');

		// TODO: Handle requests that are in flight and shut them down.

		// this.routes.clean();

		if (this.__services.has('redisClient') !== undefined) {
			Logging.logSilly('Closing _redisClientRest client');
			(this.__services.get('redisClient') as RedisClient).quit();
			this.__services.delete('redisClient');
		}

		if (this.__services.has('sdsRouting') !== undefined) {
			Logging.logSilly('Closing _sdsRouting');
			(this.__services.get('sdsRouting') as SourceDataSharingRouting).clean();
			this.__services.delete('sdsRouting');
		}

		// Destory all models
		await Model.clean();

		if (this._restServer) {
			Logging.logSilly('Closing express server');
			this._restServer.close((err) => (err) ? process.exit(1) : Logging.logSilly(`Express server closed`));
		}

		// Close Datastore connections
		Logging.logSilly('Closing down all datastore connections');
		await Datastore.clean();
	}

	async __initMaster() {
		const isPrimary = Config.rest.app === 'primary';

		if (this.__nrp === undefined) throw new Error('NRP not found whilst trying to init BootstrapRest');

		this.__nrp.on('app-schema:updated', (data: any) => {
			Logging.logDebug(`App Schema Updated: ${data.appId}`);
			this.notifyWorkers({
				type: 'app-schema:updated',
				payload: {
					appId: data.appId
				},
			});
		});
		this.__nrp.on('app-routes:bust-cache', () => {
			Logging.logDebug(`App Routes: Bust token cache`);
			this.notifyWorkers({
				type: 'app-routes:bust-cache',
				payload: {}
			});
		});

		if (isPrimary) {
			Logging.logVerbose(`Primary Main REST`);
			await Model.initCoreModels();
			await this.__systemInstall();

			// If we're running in install mode we'll just shutdown now.
			if (this._installMode) {
				Logging.log(`Install complete. Shutting down...`);
				process.exit(0);
			}

			await this.__updateAppSchema();
		} else {
			Logging.logVerbose(`Secondary Main REST`);
		}

		await this.__spawnWorkers();
	}

	async __initWorker() {
		Plugins.initRoutes(this.routes);

		const app = Express();
		// app.use(morgan(`:date[iso] [${this.id}] [:id] :method :status :url :res[content-length] - :response-time ms - :remote-addr`));
		app.enable('trust proxy', 1);
		app.use(bodyParser.json({limit: '20mb'}));
		app.use(bodyParser.urlencoded({extended: true}));
		app.use(methodOverride());
		app.use(cors({
			origin: true,
			methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,SEARCH',
			credentials: true,
		}));
		app.use(Express.static(`${Config.paths.appData}/public`));

		Plugins.on('request', (req, res) => app.handle(req, res));

		await Model.initCoreModels();

		const localSchema = this._getLocalSchemas();
		Model.getModel('App').setLocalSchema(localSchema);

		this.routes = new Routes(app);

		await this.routes.init(this.__services);
		await this.routes.initRoutes();

		this._restServer = await app.listen(Config.listenPorts.rest);

		await Model.initSchema();
		await this.routes.initAppRoutes();
	}

	async __handleMessageFromMain(message: LocalProcessMessage) {
		if (message.type === 'app-schema:updated') {
			if (!this.routes) return Logging.logDebug(`Skipping app schema update, router not created yet`);
			Logging.logDebug(`App Schema Updated: ${message.payload.appId}`);
			await Model.initSchema(message.payload.appId);
			await this.routes.regenerateAppRoutes(message.payload.appId);
			Logging.logDebug(`Models & Routes regenereated: ${message.payload.appId}`);
		} else if (message.type === 'app-routes:bust-cache') {
			if (!this.routes) return Logging.logDebug(`Skipping token cache bust, router not created yet`);
			// TODO: Maybe do this better than
			Logging.logDebug(`App Routes: cache bust`);
			await this.routes.loadTokens();
		}
	}

	async __systemInstall() {
		Logging.log('Checking for existing apps.');
		const pathName = path.join(Config.paths.appData, 'super.json');

		let superApp: any = null;

		try {
			const appCount = await Model.getModel('App').count();
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

			superApp = await Model.getModel('App').add({
				name: `${Config.app.title} TEST`,
				type: Model.getModel('Token').Constants.Type.SYSTEM,
				permissions: [{route: '*', permission: '*'}],
				apiPath: 'bjs',
				domain: '',
			});

			if (!superApp) {
				Logging.logError('Failed to create super app.');
				throw new Error('Failed to create super app.');
			}

		} catch (err) {
			Logging.logError(err);
			Logging.logError('Failed to create super app.');
			throw err;
		}

		await new Promise<void>((resolve, reject) => {
			const app = Object.assign(superApp.app, {token: superApp.token.value});

			if (!fs.existsSync(Config.paths.appData)) fs.mkdirSync(Config.paths.appData, {recursive: true});

			fs.writeFile(pathName, JSON.stringify(app), (err) => {
				if (err) return reject(err);
				Logging.log(`--------------------------------------------------------`);
				Logging.log(` SUPER APP CREATED: ${superApp.app.id}`);
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

		const files: any[] = [];
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

		// Add local schema to Model.getModel('App')
		Model.getModel('App').setLocalSchema(localSchema);

		const rxsApps = await Model.getModel('App').findAll();
		for await (const app of rxsApps) {
			const appSchema = Schema.decode(app.__schema);
			const appShortId = shortId(app.id);
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

			await Model.getModel('App').updateSchema(app.id, appSchema);
		}
	}
}
