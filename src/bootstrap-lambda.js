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
const morgan = require('morgan');

const Config = require('node-env-obj')();

const Bootstrap = require('./bootstrap');
const Datastore = require('./datastore');
const Logging = require('./helpers/logging');
const Model = require('./model');

const LambdaManager = require('./lambda/lambda-manager');
const LambdaRunner = require('./lambda/lambda-runner');

morgan.token('id', (req) => req.id);
class BootstrapLambda extends Bootstrap {
	constructor() {
		super();

		this.routes = null;

		this.primaryDatastore = Datastore.createInstance(Config.datastore, true);

		this.__apiWorkers = 0;
		this.__pathMutationWorkers = 0;
		this.__cronWorkers = 0;

		// This need to be seperate incase the user is running in single instance mode.
		this.__lambdaManagerProcess = null;
		this.__lambdaWorkerProcess = null;
	}

	async init() {
		await super.init();

		Logging.log(`Connecting to primary datastore...`);
		await this.primaryDatastore.connect();

		// Register some services.
		this.__services.set('modelManager', Model);

		// Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
		await Model.init(this.__services);

		return await this.__createCluster();
	}

	async clean() {
		await super.clean();

		Logging.logDebug('BootstrapLambda:clean');

		// Clean up lambda process.
		if (this.__lambdaManagerProcess) this.__lambdaManagerProcess.clean();
		if (this.__lambdaWorkerProcess) this.__lambdaWorkerProcess.clean();

		// Close Datastore connections
		Logging.logSilly('Closing down all datastore connections');
		Datastore.clean();
	}

	async __initMaster() {
		// Lambda workers config
		const isPrimary = Config.rest.app === 'primary';

		if (isPrimary) {
			Logging.logVerbose(`Primary Main LAMBDA`);
			await Model.initCoreModels();

			this.__nrp.on('lambdaProcessWorker:worker-initiated', (id) => {
				const type = this.__getLambdaWorkerType();
				this.__nrp.emit('lambdaProcessMaster:worker-type', {id, type});
			});

			this.__lambdaManagerProcess = new LambdaManager(this.__services);
		} else {
			Logging.logVerbose(`Secondary Main LAMBDA`);
		}

		await this.__spawnWorkers();
	}

	async __initWorker() {
		await Model.initCoreModels();

		const type = await new Promise((resolve) => {
			this.__nrp.on('lambdaProcessMaster:worker-type', (data) => {
				if (data.id !== this.id) return;
				resolve(data.type);
			}, () => {
				this.__nrp.emit('lambdaProcessWorker:worker-initiated', this.id);
			});
		});

		this.__lambdaWorkerProcess = new LambdaRunner(this.__services, type);
	}

	__getLambdaWorkerType() {
		const APIWorkers = Number(Config.lambda.apiWorkers);
		const pathMutationWorkers = Number(Config.lambda.pathMutationWorkers);
		const cronWorkers = Number(Config.lambda.cronWorkers);

		let type = null;
		if (this.__apiWorkers < APIWorkers) {
			type = 'API_ENDPOINT';
			this.__apiWorkers++;
		} else if (this.__pathMutationWorkers < pathMutationWorkers) {
			type = 'PATH_MUTATION';
			this.__pathMutationWorkers++;
		} else if (this.__cronWorkers < cronWorkers) {
			type = 'CRON';
			this.__cronWorkers++;
		}

		return type;
	}
}

module.exports = BootstrapLambda;
