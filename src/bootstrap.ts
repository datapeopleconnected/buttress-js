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

	constructor() {
		super();

		const ConfigWorkerCount = parseInt(Config.app.workers);
		this.workerProcesses = (isNaN(ConfigWorkerCount)) ? os.cpus().length : ConfigWorkerCount;

		this.id = (cluster.isWorker && cluster.worker) ? `${cluster.worker.id}` : 'MAIN';
	}

	async init() {
		this.__shutdown = false;

		this.__nrp = NRP(Config.redis);
	}

	async clean() {
		Logging.logDebug('Shutting down all connections');
		Logging.logSilly('BootstrapRest:clean');

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
		console.log('Call me maybe');
		if (cluster.isPrimary) {
			await this.__initMaster();
			process.on('message', (message: LocalProcessMessage) => this._handleMessageFromMain(message));
			process.on('unhandledRejection', (error) => Logging.logError(error));
		} else {
			await this.__initWorker();
			if(process.send) process.send({
				type: 'worker:initiated',
				payload: null,
			} as LocalProcessMessage);
		}

		return cluster.isPrimary;
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
		}

		await this.__handleMessageFromWorker(idx, message);
	}

	protected async __handleMessageFromMain(message: LocalProcessMessage) {
		Logging.logWarn(`Unhandled message from Main: ${JSON.stringify(message)}`);
	}
	protected async __handleMessageFromWorker(idx: number, message: LocalProcessMessage) {
		Logging.logWarn(`Unhandled message from Worker [${idx}]: ${JSON.stringify(message)}`);
	}

	async notifyWorkers(payload: LocalProcessMessage) {
		if (this.workerProcesses > 0) {
			Logging.logDebug(`notifying ${this.workers.length} Workers`);
			this.workers.forEach((w) => w.worker.send(payload));
		} else {
			Logging.logSilly(`single instance mode notification`);
			await this._handleMessageFromMain(payload);
		}
	}

	protected async __spawnWorkers() {
		if (this.workerProcesses === 0) {
			Logging.logWarn(`Running in SINGLE Instance mode, BUTTRESS_APP_WORKERS has been set to 0`);
			await this.__initWorker();
		} else {
			Logging.logVerbose(`Spawning ${this.workerProcesses} Workers`);

			for (let x = 0; x < this.workerProcesses; x++) {
				this.workers[x] = {
					initiated: false,
					worker: cluster.fork(),
				};
				this.workers[x].worker.on('message', (message: LocalProcessMessage) => this._handleMessageFromWorker(x, message));
			}
		}
	}
}

module.exports = Bootstrap;
