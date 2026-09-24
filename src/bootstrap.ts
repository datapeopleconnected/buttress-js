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

import sourceMapSupport from 'source-map-support';
sourceMapSupport.install();

import net from 'node:net';
import os from 'node:os';
import cluster, { Worker } from 'node:cluster';
import EventEmitter from 'node:events';
import NodeRedisPubsub from './services/nrp.js';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Logging from './helpers/logging.js';
import { getThrownErrorMessage } from './helpers/index.js';

export type Services = Map<string, unknown>;

interface WorkerHolder {
  initiated: boolean;
  worker: Worker;
}

export interface LocalProcessMessage {
  type: string;
  payload: unknown;
}

export default class Bootstrap extends EventEmitter {
  private static __unhandledRejectionHandlerRegistered = false;
  private static __onUnhandledRejection = (error: unknown) => Logging.logError(error);

  id: string;

  workerProcesses: number;

  workers: WorkerHolder[] = [];

  protected __nrp?: NodeRedisPubsub;

  protected __shutdown: boolean = false;

  private _resolveWorkersInitialised?: (value?: unknown) => void;

  protected __services: Services = new Map();

  constructor() {
    super();

    const ConfigWorkerCount = parseInt(Config.app.workers);
    this.workerProcesses = isNaN(ConfigWorkerCount) ? os.cpus().length : ConfigWorkerCount;

    this.id = cluster.isWorker && cluster.worker ? `${cluster.worker.id}` : 'MAIN';
  }

  async init(): Promise<boolean> {
    this.__shutdown = false;

    this.__services.set('nrp', new NodeRedisPubsub(Config.redis));
    this.__nrp = this.__services.get('nrp') as NodeRedisPubsub;
    this.__nrp.on('error', (data: string) => Logging.logError(data));
    await this.__nrp.connect();

    return true;
  }

  async clean() {
    Logging.logDebug('Shutting down all connections');
    Logging.logSilly('Bootstrap:clean');

    this.__shutdown = true;

    // Stop the worker processes, waiting for them to finish their in-flight work
    await this.__stopWorkers();

    // Close out the NRP connection, once it's sent anything still pending
    if (this.__nrp) {
      Logging.logSilly('Closing node redis pubsub connection');
      await this.__nrp.quit();
    }
  }

  /**
   * Shut down cleanly on SIGTERM or SIGINT, then exit. Only the entry scripts call this: the e2e tests
   * run several bootstraps in one process and call clean() themselves.
   */
  shutdownOnSignals() {
    const timeout = (parseInt(Config.timeout.shutdown) || 8) * 1000;

    const onSignal = async (signal: NodeJS.Signals) => {
      // The signal can arrive more than once: buttress.sh may send it twice, and Ctrl+C signals every process
      if (this.__shutdown) return;
      this.__shutdown = true;

      Logging.log(`Received ${signal}, shutting down`);

      // Don't let in-flight work hold up the exit for longer than a container's stop grace period
      setTimeout(() => {
        Logging.logError(`Shutdown didn't finish within ${timeout / 1000}s, exiting`);
        process.exit(1);
      }, timeout).unref();

      let code = 0;
      try {
        await this.clean();
      } catch (err: unknown) {
        Logging.logError(getThrownErrorMessage(err));
        code = 1;
      }

      process.exit(code);
    };

    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  protected async __createCluster() {
    if (!Bootstrap.__unhandledRejectionHandlerRegistered) {
      process.on('unhandledRejection', Bootstrap.__onUnhandledRejection);
      Bootstrap.__unhandledRejectionHandlerRegistered = true;
    }

    if (cluster.isPrimary) {
      Logging.log(`Init Main Process`);
      await this.__initMain();
    } else {
      Logging.log(`Init Worker Process [${cluster.worker?.id}]`);
      await this.__initWorker();
      if (process.send)
        process.send({
          type: 'worker:initiated',
          payload: null,
        } satisfies LocalProcessMessage);

      process.on('message', (message: LocalProcessMessage, handle: unknown) =>
        this._handleMessageFromMain(message, handle),
      );
    }

    return cluster.isPrimary;
  }

  protected async __initMain() {
    throw new Error('Not Yet Implemented');
  }

  protected async __initWorker() {
    throw new Error('Not Yet Implemented');
  }

  // Handle any logic needed for bootstrap before calling the main handler
  private async _handleMessageFromMain(message: LocalProcessMessage, handle?: unknown) {
    await this.__handleMessageFromMain(message, handle);
  }
  private async _handleMessageFromWorker(idx: number, message: LocalProcessMessage) {
    if (message.type === 'worker:initiated') {
      this.workers[idx].initiated = true;
      this._checkWorkersInitiated();
    }

    await this.__handleMessageFromWorker(idx, message);
  }

  protected async __handleMessageFromMain(message: LocalProcessMessage, _handle?: unknown) {
    Logging.logSilly(`Unhandled message from Main: ${JSON.stringify(message)}`);
  }
  protected async __handleMessageFromWorker(idx: number, message: LocalProcessMessage) {
    Logging.logSilly(`Unhandled message from Worker [${idx}]: ${JSON.stringify(message)}`);
  }

  async notifyWorker(idx: number, payload: LocalProcessMessage, handle?: net.Socket) {
    if (this.workers[idx]) {
      Logging.logDebug(`notifying Worker ${idx} of ${payload.type}`);
      this.workers[idx].worker.send(payload, handle);
    } else {
      Logging.logWarn(`Attempted to notify Worker ${idx} of ${payload.type}, but it does not exist`);
    }
  }

  async notifyWorkers(payload: LocalProcessMessage, handle?: net.Socket) {
    if (this.workerProcesses > 0) {
      Logging.logDebug(`notifying ${this.workers.length} Workers of ${payload.type}`);
      this.workers.forEach((w) => w.worker.send(payload, handle));
    } else {
      Logging.logSilly(`single instance mode notification`);
      await this._handleMessageFromMain(payload, handle);
    }
  }

  protected async __spawnWorkers() {
    if (this.workerProcesses === 0) {
      Logging.logWarn(`Running in SINGLE Instance mode, BUTTRESS_APP_WORKERS has been set to 0`);
      return await this.__initWorker();
    }

    Logging.logVerbose(`Spawning ${this.workerProcesses} Workers`);

    for (let x = 0; x < this.workerProcesses; x++) {
      this.workers[x] = {
        initiated: false,
        worker: cluster.fork(),
      };
      this.workers[x].worker.on('message', (message: LocalProcessMessage) => this._handleMessageFromWorker(x, message));
    }

    return new Promise((resolve) => {
      // Hand off the resolve function to the _checkWorkersInitiated function
      // this will be checked and called when all workers have sent the initiated message
      this._resolveWorkersInitialised = resolve;
    });
  }

  protected async __stopWorkers() {
    await Promise.all(
      this.workers.map(({ worker }, x) => {
        if (worker.isDead()) return;

        Logging.logSilly(`Stopping worker ${x}`);
        const exited = new Promise((resolve) => worker.once('exit', resolve));
        // Signal the worker directly: worker.kill() disconnects it first, which closes its servers before
        // its shutdown code runs, and so waits for any keep-alive connections to time out.
        worker.process.kill('SIGTERM');
        return exited;
      }),
    );
  }

  private _checkWorkersInitiated() {
    if (!this._resolveWorkersInitialised || this.workers.some((worker) => !worker.initiated)) return;
    this._resolveWorkersInitialised();
    delete this._resolveWorkersInitialised;
  }
}
