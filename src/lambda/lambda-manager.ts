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

import fs from 'node:fs';
import util from 'node:util';
import {exec as cpExec} from 'node:child_process';

import { v4 as uuidv4 } from 'uuid';
import hash from 'object-hash';
import NRP from 'node-redis-pubsub';

import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;

import Logging from '../helpers/logging';
import Model from '../model';
import * as Helpers from '../helpers';


const exec = util.promisify(cpExec);

/**
 * @class LambdaManager
 */
export default class LambdaManager {
	name: string;

	private __nrp?: NRP.NodeRedisPubSub;

	private _workerMap: any;
	private _lambdaMap: any;
	private _lambdaAPI: any[];
	private _lambdaPathsMutation: any[];
	private _lambdaPathsMutationExec: any[];
	private _maximumRetry: number;
	private _lambdaPathMutationTimeout: number;

	private __haltQueue: boolean;

	private _isPrimary: boolean;

	private _timeout?: NodeJS.Timeout;

	constructor(services) {
		this.name = 'LAMBDA MANAGER';

		this.__nrp = services.get('nrp');

		this._workerMap = {};
		this._lambdaMap = {};
		this._lambdaAPI = [];
		this._lambdaPathsMutation = [];
		this._lambdaPathsMutationExec = [];
		this._maximumRetry = 500;
		this._lambdaPathMutationTimeout = 5000;

		this.__haltQueue = false;

		Logging.logDebug(`[${this.name}] Created instance`);

		// TODO: Check to see if there is already a lambda manager in the network
		this._isPrimary = true;

		this.init();
	}

	/**
	 * @readonly
	 * @static
	 */
	static get Constants() {
		let timeout = parseInt(Config.timeout.lambdaManager);
		if (!timeout) timeout = 10;

		return {
			TIMEOUT: (timeout * 1000),
		};
	}

	async init() {
		Logging.logDebug('LambdaManager:init');

		this._loadLambdaPathsMutation();
		this._manageLambdaFolders();
		this._subscribeToLambdaWorkers();
		this._handleLambdaAPIExecution();
		this._notifyLambdaPathChange();
		this._executePendingPathMutation();
		this._setTimeoutCheck();

		this.__nrp?.on('app-lambda:path-mutation-bust-cache', async (lambda) => {
			lambda = JSON.parse(lambda);
			this.__populateLambdaPathsMutation(lambda);
		});
	}

	async clean() {
		Logging.logDebug('LambdaManager:clean');

		this.__haltQueue = true;

		if (this._timeout) clearTimeout(this._timeout);
		this._timeout = undefined;

		// TODO: Could do stuff here with dumping queue to cache.

		// TODO: Could hold until current task is completed.
	}

	/**
	 * Call queue after a specified timeout
	 * @param {Boolean} [force=false]
	 */
	_setTimeoutCheck(force = false) {
		if (this.__haltQueue) {
			Logging.logWarn(`[${this.name}]: Attempted to check lambda queue but queue is halted`);
			return;
		}

		if (this._timeout && !force) {
			Logging.logWarn(`[${this.name}]: Check is already queued`);
			return;
		}

		Logging.logSilly(`[${this.name}]: Queueing Check ${LambdaManager.Constants.TIMEOUT}`);

		if (!this._isPrimary) {
			Logging.logWarn(`[${this.name}]: Lambda manager timeout was called but we're not primary, shutting down`);
			return;
		}

		this._timeout = setTimeout(() => this.__checkQueue(), LambdaManager.Constants.TIMEOUT);
	}

	async __checkQueue() {
		try {
			const lambdaExec = await this.__getPendingLambdaExec();
			// TODO: Handle pausing lambdas due to READ / WRITE access
			await this.__announcePendingExecutions(lambdaExec);
		} catch (err: any) {
			let message = err;
			if (err.statusMessage) message = err.statusMessage;
			if (err.message) message = err.message;
			Logging.logError(`[${this.name}]: Error: ${message}`);
			if (err.stack) console.error(err.stack);

			if (err.response && err.response.data) {
				console.error(err.response.data);
			}
		}

		this._setTimeoutCheck(true);
	}

	/**
	 * Check to see if there are any pending cron lambda
	 * @return {Promise}
	 */
	async __getPendingLambdaExec() {
		// We need to unify the way we check for lambdas
		//  - Get transient executions (API, Path Mutation)
		//  - Get pending executions (Scheduled / Cron)
		//  - Mix the priorities, pick and announce.

		// The announcement process should be optimised to only to stop the announcements if nobody is listening.
		// Instead of look at the lambda triggers witn the Lambda model we should look at the executions for anything that is scheduled and PENDING.

		// TODO: Could just return the lambda id, instead of the whole lambda object
		// TODO: Move the date filter to the query if possible?
		// Not sure why this isn't happening inside the model.
		const query = Model.getModel('LambdaExecution').parseQuery({
			'status': {
				$eq: 'PENDING',
			},
			'executeAfter': {
				$lteDate: new Date().toISOString(),
			},
		}, {}, Model.getModel('LambdaExecution').flatSchemaData);

		const rxLambdas = await Model.getModel('LambdaExecution').find(query);
		const lambdas = await Helpers.streamAll(rxLambdas);
		Logging.logSilly(`Got ${lambdas.length} pending cron lambdas`);

		return lambdas;

		// TODO: Optimise, we don't need to build an array here. We could just filter the items as and when we procss them.
		// that way the whole stream isn't dumped into memory.
		// return lambdas.filter((lambda) => {
		// 	const now = Sugar.Date.create();
		// 	const cronTrigger = lambda.trigger.find((t) => t.type === 'CRON');
		// 	const cronExecutionTime = Sugar.Date.create(cronTrigger.cron.executionTime);
		// 	return cronTrigger && (cronTrigger.cron.executionTime === 'now' || Sugar.Date.isAfter(now, cronExecutionTime));
		// });
	}

	/**
	 * Populate paths mutations array to trigger lambdas accordingly
	 * @return {Promise}
	 */
	async _loadLambdaPathsMutation() {
		const rxsLambdas = await Model.getModel('Lambda').find({
			'executable': {
				$eq: true,
			},
			'trigger.type': {
				$eq: 'PATH_MUTATION',
			},
		});

		const lambdas = await Helpers.streamAll(rxsLambdas);

		if (lambdas.length < 1) return;

		for await (const lambda of lambdas) {
			await this.__populateLambdaPathsMutation(lambda);
		}
	}

	__populateLambdaPathsMutation(lambda) {
		const trigger = lambda.trigger.find((t) => t.type === 'PATH_MUTATION');
		if (!trigger) return;

		Logging.logSilly(`Pushing a new path mutation lambda (${lambda.name}) into the path mutation cached array`);
		this._lambdaPathsMutation.push({
			lambdaId: lambda.id,
			git: lambda.git,
			type: trigger.type,
			paths: trigger.pathMutation.paths,
		});
	}

	/**
	 * Annouce to workers that the manager has some lambdas
	 * @param {Array} lambdaExecs
	 * @return {Promise}
	 */
	async __announcePendingExecutions(lambdaExecs) {
		let count = 0;
		for await (const lambdaExec of lambdaExecs) {
			const messagePayload: {
				executionId: string;
				lambdaId: string;
				lambdaType: string;
				restWorkerId?: string;
				query?: any;
				headers?: any;
				body?: any;
				workerExecID?: string;
			} = {
				executionId: (lambdaExec.id) ? lambdaExec.id : null,
				lambdaId: (lambdaExec.lambdaId) ? lambdaExec.lambdaId : lambdaExec.id,
				lambdaType: (lambdaExec.triggerType) ? lambdaExec.triggerType : 'CRON',
			};

			const isAPILambda = lambdaExec.restWorkerId;
			const isPathMutation = lambdaExec.pathMutation;
			if (isAPILambda || isPathMutation) {
				messagePayload.body = lambdaExec.body;
				messagePayload.workerExecID = lambdaExec.workerExecID;
			}

			if (isAPILambda) {
				messagePayload.restWorkerId = lambdaExec.restWorkerId;
				messagePayload.query = lambdaExec.query;
				messagePayload.headers = lambdaExec.headers;

				const lambdaIdx = this._lambdaAPI.findIndex((lambda) => messagePayload.lambdaId === lambda.lambdaId);
				if (this._lambdaAPI[lambdaIdx].announced) return;

				this._lambdaAPI[lambdaIdx].announced = true;
			}

			this.__nrp?.emit('lambda:worker:announce', JSON.stringify(messagePayload));
			count++;
		}

		if (count > 0) Logging.log(`[${this.name}]: announced ${count} lambda`);
	}

	async _createLambdaExecution(lambda, type, metadata: {key: string, value: string}[] = []) {
		const deployment = await Model.getModel('Deployment').findOne({
			lambdaId: Model.getModel('Lambda').createId(lambda.id),
			hash: lambda.git.hash,
		});

		// TODO add a meaningful error message
		if (!deployment) return;

		const lambdaExecution = await Model.getModel('LambdaExecution').add({
			triggerType: type,
			lambdaId: Model.getModel('Lambda').createId(lambda.id),
			deploymentId: Model.getModel('Deployment').createId(deployment.id),
			metadata: metadata,
		}, lambda._appId);

		return lambdaExecution;
	}

	/**
	 * Track a worker lambda
	 * @param {Object} payload
	 */
	trackWorkerLambda(payload) {
		this._workerMap[payload.workerId] = payload.data.lambdaId;
		this._lambdaMap[payload.data.lambdaId] = (payload.data.body) ? hash(payload.data.body) : payload.workerId;
	}

	/**
	 * Untrack a worker lambda
	 * @param {string} workerId
	 * @param {string} lambdaId
	 * @param {string} workerExecID
	 */
	untrackWorkerLambda(workerId, lambdaId, workerExecID = null) {
		delete this._workerMap[workerId];
		delete this._lambdaMap[lambdaId];

		if (!workerExecID) return;

		const apiLambdaIdx = this._lambdaAPI.findIndex((l) => l.lambdaId.toString() === lambdaId.toString() && l.workerExecID === workerExecID);
		if (apiLambdaIdx !== -1) {
			this._lambdaAPI.splice(apiLambdaIdx, 1);
			return;
		}

		const pathMutationLambdaIdx = this._lambdaPathsMutationExec.findIndex((l) => {
			return l.lambdaId.toString() === lambdaId.toString() && l.workerExecID === workerExecID;
		});
		if (pathMutationLambdaIdx === -1) {
			throw new Error(`Lambda worker exec ID: ${workerExecID} is not found on api or path mutation queue`);
		}

		this._lambdaPathsMutationExec.splice(pathMutationLambdaIdx, 1);
	}

	/**
	 * Communicate with worker processes via Redis
	 */
	_subscribeToLambdaWorkers() {
		Logging.logDebug(`[${this.name}] Subscribing to worker network`);

		if (!this.__nrp) throw new Error('No NRP instance found');

		this.__nrp.on('lambda-worker-available', (payload: any) => {
			payload = JSON.parse(payload);
			Logging.logSilly(`[${this.name}] ${payload.workerId} prepared to take on ${payload.data.lambdaId}`);
			const lambdaMapHash = this._lambdaMap[payload.data.lambdaId];
			const lambdaBodyHash = (payload.data.body) ? hash(payload.data.body) : lambdaMapHash;

			// There is too much work going on here, we want to track and check if the id is already processed
			// if not then we releace the lambda to the worker.

			if (lambdaMapHash && lambdaMapHash === lambdaBodyHash) {
				// Another worker has already accepted this lambda so we'll just ignore it
				Logging.logSilly(`[${this.name}] ${payload.data.lambdaId} is already registered in the lambda queue`);
				return;
			}
			if (this._workerMap[payload.workerId]) {
				// This worker has already taken a lambda in the pool so ignore it's response
				Logging.logSilly(`[${this.name}] ${payload.workerId} is already doing somthing`);
				return;
			}

			this.trackWorkerLambda(payload);

			Logging.logDebug(`[${this.name}] ${payload.data.lambdaId} assigning to ${payload.workerId}`);

			// Tell the worker to execute the task
			this.__nrp?.emit('lambda:worker:execute', JSON.stringify(payload));
		});

		this.__nrp.on('lambda-worker-overloaded', (payload: any) => {
			payload = JSON.parse(payload);
			Logging.logDebug(`[${this.name}] ${payload.workerId} was oversubscribed releasing ${payload.lambdaId}`);
			this.untrackWorkerLambda(payload.workerId, payload.lambdaId);
		});

		this.__nrp.on('lambda-worker-errored', (payload: any) => {
			payload = JSON.parse(payload);
			Logging.logError(`[${this.name}] ${payload.lambdaId} errored while running on ${payload.workerId}`);
			this.untrackWorkerLambda(payload.workerId, payload.lambdaId, payload.workerExecID);
			this._checkAPIAndPathMutationQueue();
		});

		this.__nrp.on('lambda-worker-finished', (payload: any) => {
			payload = JSON.parse(payload);
			Logging.logDebug(`[${this.name}] ${payload.lambdaId} was completed by ${payload.workerId}`);
			this.untrackWorkerLambda(payload.workerId, payload.lambdaId, payload.workerExecID);
			this._checkAPIAndPathMutationQueue();
		});
	}

	async _handleLambdaAPIExecution() {
		this.__nrp?.on('rest:worker:exec-lambda-api', async (data: any) => {
			data = JSON.parse(data);

			data.workerExecID = uuidv4();
			Logging.log(`Manager is queuing API lambda ${data.lambdaId} to be executed`);
			let index = this._lambdaAPI.length;
			if (data.lambdaExecBehavior === 'SYNC' && index > 0) {
				const lambdaIdx = index = this._lambdaAPI.findIndex((item) => item.lambdaExecBehavior !== 'SYNC') - 1;
				index = (lambdaIdx !== -1) ? lambdaIdx : index;
			}

			this._lambdaAPI.splice(index, 0, data);
			this.__announcePendingExecutions(this._lambdaAPI);
		});
	}

	async _checkAPIAndPathMutationQueue() {
		const arr = this._lambdaAPI.concat(this._lambdaPathsMutationExec.filter((i) => i.id));
		if (arr.length > 0) {
			this.__announcePendingExecutions(arr);
		}
	}

	async _executePendingPathMutation() {
		const rxsLambdaExecs = await Model.getModel('LambdaExecution').find({
			'status': {
				$eq: 'PENDING',
			},
			'triggerType': {
				$eq: 'PATH_MUTATION',
			},
		});

		const lambdaExecs = await Helpers.streamAll(rxsLambdaExecs);
		if (lambdaExecs.length < 1) return;
		for await (const lambdaExec of lambdaExecs) {
			const crMetadata = lambdaExec.metadata.find((m) => m.key === 'CR');
			if (!crMetadata) continue;

			const cr = JSON.parse(crMetadata.value);
			if (!cr) continue;
			const [data] = cr;
			await this._handleLambdaPathMutationExecution(data, false, lambdaExec.id);
		}
	}

	/**
	 * Listening on redis event to handle the execution of the path mutations lambda
	 */
	_notifyLambdaPathChange() {
		this.__nrp?.on('notifyLambdaPathChange', async (data) => {
			data = JSON.parse(data);
			await this._handleLambdaPathMutationExecution(data);
		});
	}

	/**
	 * Handle lambda path mutation execution
	 * @param {Object} data
	 * @param {Boolean} addExecution
	 * @param {string} executionId
	 */
	async _handleLambdaPathMutationExecution(data, addExecution = true, executionId = null) {
		const paths = data.paths;
		const schema = data.collection;
		const values = data.values;

		Logging.logDebug(`Manager is announcing path mutation lambda to be executed for ${schema} on paths ${paths}`);
		const lambdas = this._lambdaPathsMutation.filter((item) => {
			return item.paths.some((itemPath) => paths.some((path) => this._checkMatchingPaths(path, itemPath, schema)));
		}).map((item) => {
			return {
				id: item.lambdaId,
				git: item.git,
				type: item.type,
			};
		});

		const cr = [{
			paths,
			values,
			schema,
		}];

		this._debounceLambdaTriggers(lambdas, cr, addExecution, executionId);
	}

	/**
	 * Checking matching root paths and absolute paths
	 * @param {String} path
	 * @param {String} itemPath
	 * @param {String} schema
	 * @return {Boolean}
	 */
	_checkMatchingPaths(path, itemPath, schema) {
		const isWildedCardRootPath = itemPath.split(`${schema}.*`).join('');
		if (!isWildedCardRootPath || (isWildedCardRootPath !== itemPath && path === schema)) return true;

		const lambdaPathId = itemPath.split(`${schema}.`).filter((v) => v).join('').split('.').shift();
		const crPathId = path.split(`${schema}.`).filter((v) => v).join('').split('.').shift();
		if (lambdaPathId !== crPathId && lambdaPathId !== '*') return false;

		const lambdaRelativePath = itemPath.split(`${schema}.${lambdaPathId}`).pop();
		const crRelativePath = path.split(`${crPathId}`).pop();
		return this._checkMatchingRelativePaths(lambdaRelativePath, crRelativePath);
	}

	/**
	 * Checking matching relative paths
	 * @param {String} lambdaPath
	 * @param {String} crPath
	 * @return {Boolean}
	 */
	_checkMatchingRelativePaths(lambdaPath, crPath) {
		lambdaPath = lambdaPath.replace('.length', '');
		if (lambdaPath === '*' || lambdaPath === crPath || !crPath) return true;
		if (lambdaPath.includes('*')) {
			const wildCardedPath = lambdaPath.split('.*').shift();
			if (!wildCardedPath) return true;
			if (!crPath.includes(wildCardedPath)) return false;
			const lambdaObservedPath = lambdaPath.split(`${wildCardedPath}.*`).pop();
			const crObservedPath = crPath.split(`${wildCardedPath}`).pop();

			if (!lambdaObservedPath && crObservedPath) return true;
			if (lambdaObservedPath.includes('*')) {
				return this._checkMatchingRelativePaths(lambdaObservedPath, crObservedPath);
			}

			const isSamePath = crObservedPath.split(lambdaObservedPath).pop();
			if (!isSamePath) return true;
		}

		return false;
	}

	/**
	 * Debounces checks for based path lambdas
	 * @param {Array} lambdas
	 * @param {Array} body
	 * @param {Boolean} addExecution
	 * @param {string} executionId
	 */
	async _debounceLambdaTriggers(lambdas, body, addExecution, executionId) {
		// We'll make a hash of the body so we can use it to compare in the debouncer
		const bodyHash = hash(body);

		for await (const lambda of lambdas) {
			// Check to see if there is a path mutation for the same lambda & body
			let debouncedLambdaIdx = this._lambdaPathsMutationExec.findIndex(
				(item) => (item.lambdaId.toString() === lambda.id.toString() && item.bodyHash === bodyHash));

			const retry = this._lambdaPathsMutationExec[debouncedLambdaIdx]?.retry || 0;

			if (retry > this._maximumRetry) {
				// TODO: Clean up exec records
				Logging.logError(`[${this.name}] Lambda ${lambda.id} has reached the maximum retry of ${this._maximumRetry}`);
				return;
			}

			if (debouncedLambdaIdx === -1) {
				const execID = uuidv4();
				debouncedLambdaIdx = this._lambdaPathsMutationExec.push({
					id: executionId,
					timer: setTimeout(() => this._announcePathMutationLambda(execID), this._lambdaPathMutationTimeout),
					pathMutation: true,
					triggerType: lambda.type,
					lambdaId: lambda.id,
					workerExecID: execID,
					body,
					bodyHash,
					retry: 1,
				}) - 1;
			}

			if (addExecution && debouncedLambdaIdx === -1) {
				const lambdaExecMetadata = [{key: 'CR', value: JSON.stringify(body)}];
				const execution = await this._createLambdaExecution(lambda, lambda.type, lambdaExecMetadata);
				this._lambdaPathsMutationExec[debouncedLambdaIdx].id = execution.id;
				return;
			}

			const pmExecRecord = this._lambdaPathsMutationExec[debouncedLambdaIdx];

			clearTimeout(pmExecRecord?.timer);
			pmExecRecord.timer = setTimeout(() => this._announcePathMutationLambda(pmExecRecord.workerExecID), this._lambdaPathMutationTimeout);
			pmExecRecord.body = pmExecRecord.body.concat(body);
			pmExecRecord.retry = pmExecRecord.retry + 1;
			return;
		}
	}

	/**
	 * announce path mutation lambda
	 * @param {String} execID
	 */
	async _announcePathMutationLambda(execID) {
		const pathMutationLambdaIdx = this._lambdaPathsMutationExec.findIndex((item) => item.workerExecID.toString() === execID.toString());

		const pathMutationLambda = this._lambdaPathsMutationExec[pathMutationLambdaIdx];
		delete this._lambdaPathsMutationExec[pathMutationLambdaIdx].timer;

		// Fetch the lambda by id
		const lambda = await Model.getModel('Lambda').findById(pathMutationLambda.lambdaId);

		// Create an execution if one doesn't exist
		if (!pathMutationLambda.id) {
			const lambdaExecMetadata = [{key: 'CR', value: JSON.stringify(pathMutationLambda.body)}];
			const {id} = await this._createLambdaExecution(lambda, pathMutationLambda.triggerType, lambdaExecMetadata);
			pathMutationLambda.id = id;
		}

		this.__announcePendingExecutions([pathMutationLambda]);
	}

	/**
	 * Manages lambda folders
	 */
	async _manageLambdaFolders() {
		if (!fs.existsSync(Config.paths.lambda.code)) {
			await exec(`mkdir -p ${Config.paths.lambda.code}`);
		}

		if (!fs.existsSync(Config.paths.lambda.plugins)) {
			await exec(`mkdir -p ${Config.paths.lambda.plugins}`);
		}

		if (fs.existsSync(Config.paths.lambda.bundles)) {
			await exec(`rm -rf ${Config.paths.lambda.bundles}`);
		}
	}
}