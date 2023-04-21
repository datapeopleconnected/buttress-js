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
const os = require('os');
const cluster = require('cluster');
const morgan = require('morgan');

const Config = require('node-env-obj')();
const Datastore = require('./datastore');
const Logging = require('./logging');
const Model = require('./model');

const LambdaManager = require('./lambda/lambda-manager');
const LambdaRunner = require('./lambda/lambda-runner');

morgan.token('id', (req) => req.id);
class BootstrapLambda {
	constructor() {
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

		if (isPrimary) {
			Logging.logVerbose(`Primary Main LAMB`);
			await Model.initCoreModels();
			new LambdaManager();
		} else {
			Logging.logVerbose(`Secondary Main LAMB`);
		}

		if (this.workerProcesses === 0) {
			Logging.logWarn(`Running in SINGLE Instance mode, BUTTRESS_APP_WORKERS has been set to 0`);
			await this.__initWorker();
		} else {
			await this.__spawnWorkers();
		}
	}

	async __initWorker() {
		await Model.initCoreModels();
		new LambdaRunner();
	}

	__spawnWorkers() {
		Logging.logVerbose(`Spawning ${this.workerProcesses} LAMB Workers`);

		const __spawn = (idx) => {
			this.workers[idx] = cluster.fork();
		};

		for (let x = 0; x < this.workerProcesses; x++) {
			__spawn(x);
		}
	}
}

module.exports = BootstrapLambda;
