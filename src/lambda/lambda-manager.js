const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const uuid = require('uuid');
const hash = require('object-hash');
const Sugar = require('sugar');
const Config = require('node-env-obj')();
const NRP = require('node-redis-pubsub');
const nrp = new NRP(Config.redis);

const Logging = require('../helpers/logging');
const Model = require('../model');
const Helpers = require('../helpers');

/**
 * @class LambdaManager
 */
class LambdaManager {
	/**
	 * Creates an instance of LambdaManager.
	 */
	constructor() {
		this.name = 'LAMBDA MANAGER';

		this._workerMap = {};
		this._lambdaMap = {};
		this._lambdaAPI = [];
		this._lambdaPathsMutation = [];
		this._lambdaPathsMutationExec = [];
		this._maximumRetry = 500;
		this._lambdaPathMutationTimeout = 5000;

		Logging.logDebug(`[${this.name}] Created instance`);

		// TODO: Check to see if there is already a lambda manager in the network
		this._isPrimary = true;

		this._loadLambdaPathsMutation();
		this._manageLambdaFolders();
		this._subscribeToLambdaWorkers();
		this._handleLambdaAPIExecution();
		this._handleLambdaPathMutationExecution();
		this._setTimeoutCheck();

		nrp.on('app-lambda:path-mutation-bust-cache', async (lambda) => {
			this.__populateLambdaPathsMutation(lambda);
		});
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

	/**
	 * Call queue after a specified timeout
	 * @param {Boolean} [force=false]
	 */
	_setTimeoutCheck(force = false) {
		if (this._timeout && !force) {
			Logging.logWarn(`[${this.name}]: Check is already queued`);
			return;
		}

		Logging.logSilly(`[${this.name}]: Queueing Check ${LambdaManager.Constants.TIMEOUT}`);

		if (!this._isPrimary) {
			Logging.logWarn(`[${this.name}]: Lambda manager timeout was called but we're not primary, shutting down`);
			return;
		}

		this._timeout = setTimeout(async () => {
			// TODO: Reset long running lambda
			try {
				const lambdas = await this._getPendingLambda();
				// TODO: Handle pausing lambdas due to READ / WRITE access
				await this._announceLambdas(lambdas);
				this._setTimeoutCheck(true);
			} catch (err) {
				let message = err;
				if (err.statusMessage) message = err.statusMessage;
				if (err.message) message = err.message;
				Logging.logError(`[${this.name}]: Error: ${message}`);
				if (err.stack) console.error(err.stack);

				if (err.response && err.response.data) {
					console.error(err.response.data);
				}

				this._setTimeoutCheck(true);
			}
		}, LambdaManager.Constants.TIMEOUT);
	}

	/**
	 * Check to see if there are any pending cron lambda
	 * @return {Promise}
	 */
	async _getPendingLambda() {
		// TODO: Could just return the lambda id, instead of the whole lambda object
		// TODO: Move the date filter to the query if possible?
		const rxsLambdas = await Model.Lambda.find({
			'executable': {
				$eq: true,
			},
			'trigger.cron.status': {
				$eq: 'PENDING',
			},
			'trigger.cron.periodicExecution': {
				$ne: null,
			},
		});
		const lambdas = await Helpers.streamAll(rxsLambdas);
		Logging.logSilly(`Got ${lambdas.length} pending cron lambdas`);

		// TODO when creating a lambda exeuctionTime should be converted to a date!

		// TODO: Optimise, we don't need to build an array here. We could just filter the items as and when we procss them.
		// that way the whole stream isn't dumped into memory.
		return lambdas.filter((lambda) => {
			const now = Sugar.Date.create();
			const cronTrigger = lambda.trigger.find((t) => t.type === 'CRON');
			const cronExecutionTime = Sugar.Date.create(cronTrigger.cron.executionTime);
			return cronTrigger && (cronTrigger.cron.executionTime === 'now' || Sugar.Date.isAfter(now, cronExecutionTime));
		});
	}

	/**
	 * Populate paths mutations array to trigger lambdas accordingly
	 * @return {Promise}
	 */
	async _loadLambdaPathsMutation() {
		const rxsLambdas = await Model.Lambda.find({
			'executable': {
				$eq: true,
			},
			'trigger.type': {
				$eq: 'PATH_MUTATION',
			},
		});

		const lambdas = await Helpers.streamAll(rxsLambdas);

		if (lambdas.length < 1) return;

		lambdas.forEach((lambda) => {
			this.__populateLambdaPathsMutation(lambda);
		});
	}

	__populateLambdaPathsMutation(lambda) {
		const trigger = lambda.trigger.find((t) => t.type === 'PATH_MUTATION');
		if (!trigger) return;

		Logging.logSilly(`Pushing a new path mutation lambda (${lambda.name}) into the path mutation cached array`);
		this._lambdaPathsMutation.push({
			lambdaId: lambda.id,
			type: trigger.type,
			paths: trigger.pathMutation.paths,
		});
	}

	/**
	 * Annouce to workers that the manager has some lambdas
	 * @param {Array} lambdas
	 * @return {Promise}
	 */
	_announceLambdas(lambdas) {
		if (lambdas.length > 0) {
			Logging.log(`[${this.name}]: Got ${lambdas.length} lambdas to announce`);
		}

		const execLambdas = lambdas.map((lambda) => {
			const output = {
				lambdaId: (lambda.lambdaId) ? lambda.lambdaId : lambda.id,
				lambdaType: (lambda.triggerType) ? lambda.triggerType : 'CRON',
			};

			const isAPILambda = lambda.restWorkerId;
			const isPathMutation = lambda.pathMutation;
			if (isAPILambda || isPathMutation) {
				output.body = lambda.body;
				output.workerExecID = lambda.workerExecID;
			}

			if (isAPILambda) {
				output.restWorkerId = lambda.restWorkerId;
				output.query = lambda.query;
				output.headers = lambda.headers;
			}

			return output;
		});

		return execLambdas.reduce((prev, next) => {
			// Call out to workers to see who can run this lambda
			return prev.then(() => {
				const isAPILambda = next.restWorkerId;
				if (isAPILambda) {
					const lambdaIdx = this._lambdaAPI.findIndex((lambda) => next.lambdaId === lambda.lambdaId);
					if (this._lambdaAPI[lambdaIdx].announced) return;

					this._lambdaAPI[lambdaIdx].announced = true;
				}

				nrp.emit('lambda-manager-announce', next);
			});
		}, Promise.resolve());
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

		nrp.on('lambda-worker-available', (payload) => {
			Logging.logSilly(`[${this.name}] ${payload.workerId} prepared to take on ${payload.data.lambdaId}`);
			const lambdaMapHash = this._lambdaMap[payload.data.lambdaId];
			const lambdaBodyHash = (payload.data.body) ? hash(payload.data.body) : lambdaMapHash;

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
			nrp.emit('lambda-worker-execute', payload);
		});

		nrp.on('lambda-worker-overloaded', (payload) => {
			Logging.logDebug(`[${this.name}] ${payload.workerId} was oversubscribed releasing ${payload.lambdaId}`);
			this.untrackWorkerLambda(payload.workerId, payload.lambdaId);
		});

		nrp.on('lambda-worker-errored', (payload) => {
			Logging.logError(`[${this.name}] ${payload.lambdaId} errored while running on ${payload.workerId}`);
			this.untrackWorkerLambda(payload.workerId, payload.lambdaId, payload.workerExecID);
			this._checkAPIAndPathMutationQueue();
		});

		nrp.on('lambda-worker-finished', (payload) => {
			Logging.logDebug(`[${this.name}] ${payload.lambdaId} was completed by ${payload.workerId}`);
			this.untrackWorkerLambda(payload.workerId, payload.lambdaId, payload.workerExecID);
			this._checkAPIAndPathMutationQueue();
		});
	}

	async _handleLambdaAPIExecution() {
		nrp.on('executeLambdaAPI', async (data) => {
			data.workerExecID = uuid.v4();
			Logging.log(`Manager is queuing API lambda ${data.lambdaId} to be executed`);
			let index = this._lambdaAPI.length;
			if (data.lambdaExecBehavior === 'SYNC' && index > 0) {
				const lambdaIdx = index = this._lambdaAPI.findIndex((item) => item.lambdaExecBehavior !== 'SYNC') - 1;
				index = (lambdaIdx !== -1) ? lambdaIdx : index;
			}

			this._lambdaAPI.splice(index, 0, data);
			this._announceLambdas(this._lambdaAPI);
		});
	}

	async _checkAPIAndPathMutationQueue() {
		const arr = this._lambdaAPI.concat(this._lambdaPathsMutationExec);
		if (arr.length > 0) {
			this._announceLambdas(arr);
		}
	}

	/**
	 * Listening on redis event to handle the execution of the path mutations lambda
	 */
	async _handleLambdaPathMutationExecution() {
		nrp.on('notifyLambdaPathChange', async (data) => {
			const paths = data.paths;
			const schema = data.collection;

			Logging.logDebug(`Manager is announcing path mutation lambda to be executed for ${schema} on paths ${paths}`);

			const lambdas = this._lambdaPathsMutation.filter((item) => {
				return item.paths.some((itemPath) => paths.some((path) => this._checkMatchingPaths(path, itemPath, schema)));
			}).map((item) => {
				return {
					id: item.lambdaId,
					type: item.type,
				};
			});

			const cr = [{
				paths,
				values: data.values,
			}];

			this._debounceLambdaTriggers(lambdas, cr, this._lambdaPathMutationTimeout);
		});
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
	 * @param {String} timeout
	 */
	async _debounceLambdaTriggers(lambdas, body, timeout) {
		// We'll make a hash of the body so we can use it to compare in the debouncer
		const bodyHash = hash(body);

		lambdas.forEach((lambda) => {
			// Check to see if there is an path mutation for the same lambda & body
			const debouncedLambdaIdx = this._lambdaPathsMutationExec.findIndex(
				(item) => (item.lambdaId.toString() === lambda.id.toString() && item.bodyHash === bodyHash));

			const retry = this._lambdaPathsMutationExec[debouncedLambdaIdx]?.retry || 0;

			if (debouncedLambdaIdx === -1 || retry > this._maximumRetry) {
				const execID = uuid.v4();
				this._lambdaPathsMutationExec.push({
					timer: setTimeout(() => {
						this._announcePathMutationLambda(execID);
					}, timeout),
					pathMutation: true,
					triggerType: lambda.type,
					lambdaId: lambda.id,
					workerExecID: execID,
					body,
					bodyHash,
					retry: 1,
				});

				return;
			}

			clearTimeout(this._lambdaPathsMutationExec[debouncedLambdaIdx]?.timer);
			this._lambdaPathsMutationExec[debouncedLambdaIdx].timer = setTimeout(() => {
				this._announcePathMutationLambda(lambda.id, bodyHash);
			}, timeout);
			this._lambdaPathsMutationExec[debouncedLambdaIdx].body = this._lambdaPathsMutationExec[debouncedLambdaIdx].body.concat(body);
			this._lambdaPathsMutationExec[debouncedLambdaIdx].retry = this._lambdaPathsMutationExec[debouncedLambdaIdx].retry + 1;

			return;
		});
	}

	/**
	 * announce path mutation lambda
	 * @param {String} lambdaId
	 * @param {String} bodyHash
	 */
	async _announcePathMutationLambda(lambdaId, bodyHash) {
		const pathMutationLambdaIdx = this._lambdaPathsMutationExec.findIndex(
			(item) => (item.lambdaId.toString() === lambdaId.toString() && item.bodyHash === bodyHash));

		const pathMutationLambda = this._lambdaPathsMutationExec[pathMutationLambdaIdx];
		delete this._lambdaPathsMutationExec[pathMutationLambdaIdx].timer;

		this._announceLambdas([pathMutationLambda]);
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

module.exports = LambdaManager;
