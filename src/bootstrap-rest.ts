/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';

import Express from 'express';
import { createClient, RedisClientType } from '@redis/client';
import cors from 'cors';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Bootstrap, { LocalProcessMessage } from './bootstrap.js';
import Model from './model/index.js';
import Routes from './routes/index.js';
import Logging from './helpers/logging.js';
import * as Schema from './helpers/schema.js';

import { SourceDataSharingRouting } from './services/source-ds-routing.js';

import DatastoreManager, { Datastore } from './datastore/index.js';
import Plugins from './plugins/index.js';
import AccessControl from './access-control/index.js';
import { PolicyCache } from './services/policy-cache.js';
import AppSchemaModel from './model/core/app.js';
import TokenSchemaModel from './model/core/token.js';

// morgan.token('id', (req) => req.context.id);

Error.stackTraceLimit = Infinity;
export default class BootstrapRest extends Bootstrap {
  routes?: Routes;
  primaryDatastore: Datastore;

  _restServer?: http.Server;
  _installMode: boolean;

  constructor(installMode = false) {
    super();

    this.primaryDatastore = DatastoreManager.createInstance(Config.datastore, true);

    this._installMode = process.env.INSTALL_MODE === 'true' || installMode || false;
  }

  async init(): Promise<boolean> {
    await super.init();

    Logging.logDebug(`Connecting to primary datastore...`);
    await this.primaryDatastore.connect();

    if (!this.__nrp) throw new Error('NRP not found whilst trying to init BootstrapRest');

    // Register some services.
    this.__services.set(
      'redisClient',
      createClient({
        url: Config.redis.url,
      }),
    );

    const redisClient = this.__services.get('redisClient') as RedisClientType;
    if (redisClient === undefined) throw new Error('Redis client not found whilst trying to init BootstrapRest');
    await redisClient.connect();

    this.__services.set('policyCache', new PolicyCache(redisClient, Model));
    const policyCache = this.__services.get('policyCache') as PolicyCache;
    if (policyCache === undefined) throw new Error('PolicyCache not found whilst trying to init BootstrapRest');

    this.__services.set('sdsRouting', new SourceDataSharingRouting(redisClient));
    this.__services.set('modelManager', Model);

    // Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
    Logging.logDebug(`Init process libs...`);
    await Model.init(this.__services);
    await AccessControl.init(this.__nrp, policyCache);
    await Plugins.initialise(
      Plugins.APP_TYPE.REST,
      cluster.isPrimary ? Plugins.PROCESS_ROLE.MAIN : Plugins.PROCESS_ROLE.WORKER,
      Config.rest.app === 'primary' ? Plugins.INFRASTRUCTURE_ROLE.PRIMARY : Plugins.INFRASTRUCTURE_ROLE.SECONDARY,
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
      (this.__services.get('redisClient') as RedisClientType).quit();
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
      this._restServer.close((err) => (err ? process.exit(1) : Logging.logSilly(`Express server closed`)));
    }

    // Close Datastore connections
    Logging.logSilly('Closing down all datastore connections');
    await DatastoreManager.clean();
  }

  async __initMain() {
    const isPrimary = Config.rest.app === 'primary';

    if (this.__nrp === undefined) throw new Error('NRP not found whilst trying to init BootstrapRest');

    this.__nrp.on('app-schema:updated', (json) => {
      const data = JSON.parse(json);
      Logging.logDebug(`App Schema Updated: ${data.appId}`);
      this.notifyWorkers({
        type: 'app-schema:updated',
        payload: {
          appId: data.appId,
        },
      });
    });
    this.__nrp.on('app-routes:bust-cache', () => {
      Logging.logDebug(`App Routes: Bust token cache`);
      this.notifyWorkers({
        type: 'app-routes:bust-cache',
        payload: {},
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

    if (Config.app.trustProxy) {
      app.set('trust proxy', Config.app.trustProxy);
      Logging.logVerbose(`Trust proxy enabled for REST server, ${Config.app.trustProxy}`);
    }

    app.use(Express.json({ limit: '20mb' }));
    app.use(Express.urlencoded({ extended: true }));
    app.use(
      cors({
        origin: true,
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,SEARCH',
        credentials: true,
      }),
    );
    app.use(Express.static(`${Config.paths.appData}/public`));

    // @ts-expect-error - Calling a private function within the class, this is the only way it's exposed.
    Plugins.on('request', (req, res) => app.handle(req, res));

    await Model.initCoreModels();

    const localSchema = this._getLocalSchemas();
    Model.getCoreModel(AppSchemaModel).setLocalSchema(localSchema);

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
      await this.routes.loadTokens();
      Logging.logDebug(`App Routes: cache bust`);
    }
  }

  async __systemInstall() {
    Logging.log('Checking for existing apps.');
    const pathName = path.join(Config.paths.appData, 'super.json');

    let superApp: any = null;

    try {
      const appCount = await Model.getCoreModel(AppSchemaModel).count();
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

      superApp = await Model.getCoreModel(AppSchemaModel).add(
        {
          name: `${Config.app.title} TEST`,
          apiPath: 'bjs',
          domain: '',
        },
        {
          type: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
        },
      );

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
      const app = Object.assign(superApp.app, { token: superApp.token.value });

      if (!fs.existsSync(Config.paths.appData)) fs.mkdirSync(Config.paths.appData, { recursive: true });

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
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const filenames = fs.readdirSync(`${__dirname}/schema`);

    const files: any[] = [];
    for (let x = 0; x < filenames.length; x++) {
      const file = filenames[x];
      if (path.extname(file) === '.json') {
        // Load the file using fs
        const filePath = path.join(__dirname, 'schema', file);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const jsonData = JSON.parse(fileContent);
        files.push(jsonData);
      }
    }

    return files;
  }

  async __updateAppSchema() {
    // Load local defined schemas into super app
    const localSchema = this._getLocalSchemas();

    Model.getCoreModel(AppSchemaModel).setLocalSchema(localSchema);

    const rxsApps = await Model.getCoreModel(AppSchemaModel).findAll();
    for await (const app of rxsApps) {
      const appSchema: any[] = Schema.decode(app.__schema);
      Logging.log(`Adding ${localSchema.length} local schema for ${app.id}:${app.name}:${appSchema.length}`);
      localSchema.forEach((cS) => {
        const appSchemaIdx = appSchema.findIndex((s) => s.name === cS.name);
        const schema = appSchema[appSchemaIdx];
        if (!schema) {
          return appSchema.push(cS);
        }
        schema.properties = Object.assign(schema.properties, cS.properties);
        appSchema[appSchemaIdx] = schema;
      });

      await Model.getCoreModel(AppSchemaModel).updateSchema(app.id, appSchema);
    }
  }
}
