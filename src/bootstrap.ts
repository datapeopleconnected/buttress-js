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

import os from 'os';
import cluster, {Worker} from 'cluster';
import EventEmitter from 'events';
import NRP from 'node-redis-pubsub';

const Config = require('node-env-obj')();

const Logging = require('./helpers/logging');

interface WorkerHolder {
	initiated: boolean;
	worker: Worker;
}

interface LocalProcessMessage {
	type: string;
	payload: any;
}

class Bootstrap extends EventEmitter {
	id: string;

	workerProcesses: number;

	workers: WorkerHolder[] = [];

	protected __nrp?: NRP.NodeRedisPubSub;

	protected __shutdown: boolean = false;

	private _resolveWorkersInitialised?: Function;
	
	protected __services: Map<string, unknown> = new Map();

	constructor() {
		super();

		const ConfigWorkerCount = parseInt(Config.app.workers);
		this.workerProcesses = (isNaN(ConfigWorkerCount)) ? os.cpus().length : ConfigWorkerCount;

		this.id = (cluster.isWorker && cluster.worker) ? `${cluster.worker.id}` : 'MAIN';
	}

	async init() {
		this.__shutdown = false;

		this.__services.set('nrp', NRP(Config.redis));
		this.__nrp = this.__services.get('nrp') as NRP.NodeRedisPubSub;
	}

	async clean() {
		Logging.logDebug('Shutting down all connections');
		Logging.logSilly('Bootstrap:clean');

		this.__shutdown = true;

		// Kill worker processes
		for (let x = 0; x < this.workers.length; x++) {
			Logging.logSilly(`Killing worker ${x}`);
			this.workers[x].worker.kill();
		}

		// Close out the NRP connection
		if (this.__nrp) {
			Logging.logSilly('Closing node redis pubsub connection');
			this.__nrp.quit();
		}
	}

	protected async __createCluster() {
		if (cluster.isMaster) {
			Logging.log(`Init Main Process`);
			await this.__initMaster();
			process.on('unhandledRejection', (error) => Logging.logError(error));
		} else {
			Logging.log(`Init Worker Process [${cluster.worker?.id}]`);
			await this.__initWorker();
			if(process.send) process.send({
				type: 'worker:initiated',
				payload: null,
			} as LocalProcessMessage);

			process.on('message', (message: LocalProcessMessage) => this._handleMessageFromMain(message));
			process.on('unhandledRejection', (error) => Logging.logError(error));
		}

		return cluster.isMaster;
	}

	protected async __initMaster() {
		throw new Error('Not Yet Implemented');
	}

	protected async __initWorker() {
		throw new Error('Not Yet Implemented');
	}

	// Handle any logic needed for bootstrap before calling the main handler
	private async _handleMessageFromMain(message: LocalProcessMessage) {
		await this.__handleMessageFromMain(message);
	}
	private async _handleMessageFromWorker(idx: number, message: LocalProcessMessage) {
		if (message.type === 'worker:initiated') {
			this.workers[idx].initiated = true;
			this._checkWorkersInitiated();
		}

		await this.__handleMessageFromWorker(idx, message);
	}

	protected async __handleMessageFromMain(message: LocalProcessMessage) {
		Logging.logSilly(`Unhandled message from Main: ${JSON.stringify(message)}`);
	}
	protected async __handleMessageFromWorker(idx: number, message: LocalProcessMessage) {
		Logging.logSilly(`Unhandled message from Worker [${idx}]: ${JSON.stringify(message)}`);
	}

	async notifyWorkers(payload: LocalProcessMessage) {
		if (this.workerProcesses > 0) {
			Logging.logDebug(`notifying ${this.workers.length} Workers of ${payload.type}`);
			this.workers.forEach((w) => w.worker.send(payload));
		} else {
			Logging.logSilly(`single instance mode notification`);
			await this._handleMessageFromMain(payload);
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

	private _checkWorkersInitiated() {
		if (!this._resolveWorkersInitialised || this.workers.some((worker) => !worker.initiated)) return;
		this._resolveWorkersInitialised();
		delete this._resolveWorkersInitialised;
	}
}

module.exports = Bootstrap;
