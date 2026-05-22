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
import morgan from 'morgan';
import { createClient, RedisClientType } from '@redis/client';
import { Request } from 'express';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Bootstrap from './bootstrap.js';
import Datastore from './datastore/index.js';
import Logging from './helpers/logging.js';
import Model from './model/index.js';

import { PolicyCache } from './services/policy-cache.js';

import LambdaManager from './lambda/lambda-manager.js';
import LambdaRunner, { LambdaType } from './lambda/lambda-runner.js';

morgan.token('id', (req: Request) => req.context.id);
export default class BootstrapLambda extends Bootstrap {
  routes: any;

  primaryDatastore: any;

  private _redisClient?: RedisClientType;

  __apiWorkers: number;
  __pathMutationWorkers: number;
  __cronWorkers: number;

  __lambdaManagerProcess?: LambdaManager;
  __lambdaWorkerProcess?: LambdaRunner;

  constructor() {
    super();

    this.routes = null;

    this.primaryDatastore = Datastore.createInstance(Config.datastore, true);

    this.__apiWorkers = 0;
    this.__pathMutationWorkers = 0;
    this.__cronWorkers = 0;
  }

  async init() {
    await super.init();

    Logging.log(`Connecting to primary datastore...`);
    await this.primaryDatastore.connect();

    // Register some services.
    this.__services.set('modelManager', Model);

    this._redisClient = createClient({
      url: Config.redis.url,
    });
    await this._redisClient.connect();

    this.__services.set('policyCache', new PolicyCache(this._redisClient, Model));

    // Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
    await Model.init(this.__services);

    return await this.__createCluster();
  }

  async clean() {
    await super.clean();

    Logging.logDebug('BootstrapLambda:clean');

    // Clean up lambda process.
    if (this.__lambdaManagerProcess) await this.__lambdaManagerProcess.clean();
    if (this.__lambdaWorkerProcess) await this.__lambdaWorkerProcess.clean();

    if (this._redisClient) {
      this._redisClient.quit();
    }

    // Close Datastore connections
    Logging.logSilly('Closing down all datastore connections');
    Datastore.clean();
  }

  async __initMain() {
    // Lambda workers config
    const isPrimary = Config.rest.app === 'primary';

    if (isPrimary) {
      Logging.logVerbose(`Primary Main LAMBDA`);
      await Model.initCoreModels();

      this.__nrp?.on('lambdaProcessWorker:worker-initiated', (id) => {
        const type = this.__getLambdaWorkerType();
        this.__nrp?.emit('lambdaProcessMain:worker-type', JSON.stringify({ id, type }));
      });

      this.__lambdaManagerProcess = new LambdaManager(this.__services);
      await this.__lambdaManagerProcess.init();
    } else {
      Logging.logVerbose(`Secondary Main LAMBDA`);
    }

    await this.__spawnWorkers();
  }

  async __initWorker() {
    await Model.initCoreModels();

    let type = LambdaType.ALL;

    if (this.workerProcesses > 0) {
      const typeAssignment = new Promise((resolve) => {
        this.__nrp?.on('lambdaProcessMain:worker-type', (data: any) => {
          data = JSON.parse(data);

          if (data.id !== this.id) return;
          resolve(data.type);
        });
      });

      this.__nrp?.emit('lambdaProcessWorker:worker-initiated', this.id);
      type = (await typeAssignment) as LambdaType;
      Logging.logDebug(`Worker [${this.id}] assigned type: ${type}`);
    }

    this.__lambdaWorkerProcess = new LambdaRunner(this.__services, type);
    await this.__lambdaWorkerProcess.init();
  }

  __getLambdaWorkerType() {
    const APIWorkers = Number(Config.lambda.apiWorkers);
    const pathMutationWorkers = Number(Config.lambda.pathMutationWorkers);
    const cronWorkers = Number(Config.lambda.cronWorkers);

    let type = LambdaType.ALL;
    if (this.__apiWorkers < APIWorkers) {
      type = LambdaType.API_ENDPOINT;
      this.__apiWorkers++;
    } else if (this.__pathMutationWorkers < pathMutationWorkers) {
      type = LambdaType.PATH_MUTATION;
      this.__pathMutationWorkers++;
    } else if (this.__cronWorkers < cronWorkers) {
      type = LambdaType.CRON;
      this.__cronWorkers++;
    }

    return type;
  }
}
