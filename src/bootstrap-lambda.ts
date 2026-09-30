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

import Bootstrap, { WorkerHolder } from './bootstrap.js';
import Logging from './helpers/logging.js';
import { getThrownErrorMessage } from './helpers/index.js';
import Model from './model/index.js';
import Routes from './routes/index.js';
import DatastoreManager, { Datastore } from './datastore/index.js';

import { PolicyCache } from './services/policy-cache.js';

import LambdaManager from './lambda/lambda-manager.js';
import LambdaRunner, { LambdaType } from './lambda/lambda-runner.js';

export interface WorkerTypeMessage {
  id: string;
  type: string;
}

/**
 * The message published on `lambdaProcessMain:worker-exited`.
 */
export interface WorkerExitedMessage {
  id: string;
}

morgan.token('id', (req: Request) => req.context.id);
export default class BootstrapLambda extends Bootstrap {
  routes?: Routes;
  primaryDatastore: Datastore;

  private _redisClient?: RedisClientType;

  __apiWorkers: number;
  __pathMutationWorkers: number;
  __cronWorkers: number;
  // The type handed to each worker, by the id it asked with, so a worker that exits can give its type back
  private _lambdaWorkerTypes = new Map<string, LambdaType>();

  __lambdaManagerProcess?: LambdaManager;
  __lambdaWorkerProcess?: LambdaRunner;

  constructor() {
    super();

    this.primaryDatastore = DatastoreManager.createInstance(Config.datastore, true);

    this.__apiWorkers = 0;
    this.__pathMutationWorkers = 0;
    this.__cronWorkers = 0;
  }

  override async init() {
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

  override async clean() {
    // Clean up lambda process, first so a running lambda can finish while its connections are still open.
    if (this.__lambdaManagerProcess) await this.__lambdaManagerProcess.clean();
    if (this.__lambdaWorkerProcess) await this.__lambdaWorkerProcess.clean();

    await super.clean();

    Logging.logDebug('BootstrapLambda:clean');

    if (this._redisClient) {
      this._redisClient.quit();
    }

    // Close Datastore connections
    Logging.logSilly('Closing down all datastore connections');
    await DatastoreManager.clean();
  }

  override async __initMain() {
    // Lambda workers config
    const isPrimary = Config.rest.app === 'primary';

    if (isPrimary) {
      Logging.logVerbose(`Primary Main LAMBDA`);
      await Model.initCoreModels();

      await this.__nrp?.on('lambdaProcessWorker:worker-initiated', (id) => {
        const type = this.__getLambdaWorkerType(id);
        this.__nrp?.emit('lambdaProcessMain:worker-type', JSON.stringify({ id, type } satisfies WorkerTypeMessage));
      });
      // The worker that replaces one that exited asks for a type too, so it gets the one given back
      await this.__nrp?.on('lambdaProcessMain:worker-exited', (json) => {
        const { id } = JSON.parse(json) as WorkerExitedMessage;
        this.__releaseLambdaWorkerType(id);
      });

      this.__lambdaManagerProcess = new LambdaManager(this.__services);
      await this.__lambdaManagerProcess.init();
    } else {
      Logging.logVerbose(`Secondary Main LAMBDA`);
    }

    await this.__spawnWorkers();
  }

  override async __initWorker() {
    await Model.initCoreModels();

    let type = LambdaType.ALL;

    if (this.workerProcesses > 0) {
      let resolveType: (type: LambdaType) => void;
      const typeAssignment = new Promise<LambdaType>((resolve) => (resolveType = resolve));
      // Listen before asking, as the primary main answers straight away
      await this.__nrp?.on('lambdaProcessMain:worker-type', (json: string) => {
        const data = JSON.parse(json) as WorkerTypeMessage;

        if (data.id !== this.id) return;
        resolveType(data.type as LambdaType);
      });

      this.__nrp?.emit('lambdaProcessWorker:worker-initiated', this.id);
      type = await typeAssignment;
      Logging.logDebug(`Worker [${this.id}] assigned type: ${type}`);
    }

    this.__lambdaWorkerProcess = new LambdaRunner(this.__services, type);
    await this.__lambdaWorkerProcess.init();
  }

  /**
   * Gives a worker that exited back its type, which is kept by the primary main, from this main or another's.
   */
  protected override __onWorkerExit(_idx: number, holder: WorkerHolder) {
    if (!holder.processId) return;

    this.__nrp
      ?.emit('lambdaProcessMain:worker-exited', JSON.stringify({ id: holder.processId } satisfies WorkerExitedMessage))
      .catch((err: unknown) =>
        Logging.logError(`Failed to give back worker ${holder.processId}'s type: ${getThrownErrorMessage(err)}`),
      );
  }

  __getLambdaWorkerType(id: string) {
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

    this._lambdaWorkerTypes.set(id, type);
    return type;
  }

  __releaseLambdaWorkerType(id: string) {
    const type = this._lambdaWorkerTypes.get(id);
    this._lambdaWorkerTypes.delete(id);

    if (type === LambdaType.API_ENDPOINT) this.__apiWorkers--;
    else if (type === LambdaType.PATH_MUTATION) this.__pathMutationWorkers--;
    else if (type === LambdaType.CRON) this.__cronWorkers--;
  }
}
