const fs = require('fs');
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const Config = require('node-env-obj')();
const Sugar = require('sugar');
const ivm = require('isolated-vm');
const {v4: uuidv4} = require('uuid');
const webpack = require('webpack');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

const Logging = require('../helpers/logging');
const Model = require('../model');
const Helpers = require('../helpers');
const lambdaHelpers = require('../lambda-helpers/helpers');

/**
 * Queue up pending Lambdas and execute them
 *
 * @class LambdasRunner
 */
class LambdasRunner {
	/**
	 * @param {Object} services - service registry
	 * @param {String} type
	 * Creates an instance of LambdasRunner.
	 */
	constructor(services, type) {
		this.__nrp = services.get('nrp');

		this.id = uuidv4();
		this.name = `LAMBDAS RUNNER ${this.id}`;
		this.lambdaType = type;

		Logging.logDebug(`[${this.name}] Created instance`);

		this.working = false;

		this._timeout = null;
		this._lambdaExecution = null;

		this.init();
	}

	/**
	 * @readonly
	 * @static
	 */
	static get Constants() {
		let timeout = parseInt(Config.timeout.lambdasRunner);
		if (!timeout) timeout = 10;

		return {
			TIMEOUT: (timeout * 1000),
		};
	}

	async init() {
		Logging.logDebug('LambdasRunner:init');

		this._isolate = new ivm.Isolate({
			inspector: false,
			onCatastrophicError: () => {
				Logging.logError('v8 has lost all control over the isolate, and all resources in use are totally unrecoverable');
				process.abort();
			},
		});
		this._context = this._isolate.createContextSync();
		this._jail = this._context.global;
		this._registeredBundles = [];
		this._compiledLambdas = [];

		lambdaHelpers._createIsolateContext(this._isolate, this._context, this._jail);
		this._subscribeToLambdaManager();
	}

	async clean() {
		Logging.logDebug('LambdasRunner:clean');

		// Shutdown isolate
	}

	/**
	 * execute a single lambda
	 * @param {object} lambda
	 * @param {object} execution
	 * @param {object} app
	 * @param {object} type
	 * @param {object} data
	 * @return {Promise}
	 */
	async execute(lambda, execution, app, type, data) {
		if (!lambda.git || !lambda.git.url) {
			return Promise.reject(new Error(`Unable to find git repo for lambda ${lambda.name}`));
		}

		const rxsLambdaToken = await Model.Token.find({
			_appId: Model.App.createId(app.id),
			_lambdaId: Model.User.createId(lambda.id),
		});
		const lambdaToken = await Helpers.streamFirst(rxsLambdaToken);
		if (!lambdaToken) {
			return Promise.reject(new Error(`Unable to find lambda token for lambda ${lambda.name}`));
		}

		const apiPath = app.apiPath;
		// const appAllowList = app.allowList;
		let trigger = lambda.trigger.find((t) => t.type === type);
		trigger = trigger?.[Sugar.String.camelize(type, false)];
		const buttressOptions = {
			buttressUrl: `${Config.app.protocol}://${Config.app.host}`,
			appToken: lambdaToken.value,
			apiPath: apiPath,
			allowUnauthorized: true,
		};
		const lambdaModules = {};

		lambdaHelpers.lambdaExecution = execution;
		await this._updateDBLambdaRunningExecution(execution);

		// TODO: Handle case where lambda code doesn't exist on file system. (Clone Repo)
		// TODO: Handle case where lambda code can't be cloned. (Inform Manager)

		// TODO: Handle case where repo code hash doesn't match lambda. (Update Repo)

		// const modulesNames = await this.installLambdaPackages(lambda, appAllowList); // not install packages on lambdas anymore
		const modulesNames = this._getLambdaModulesName(lambda);
		await this.bundleLambdaModules(modulesNames);
		await this._registerLambdaModules(modulesNames);
		modulesNames.forEach((m) => {
			lambdaModules[m.name] = m.name;
		});

		this._jail.setSync('buttressOptions', new ivm.ExternalCopy(buttressOptions).copyInto());

		// Would be better to just group these under one namespace "lambda". Unless we're going.
		this._jail.setSync('lambdaModules', new ivm.ExternalCopy(lambdaModules).copyInto());
		this._jail.setSync('lambdaInfo', new ivm.ExternalCopy({
			lambdaId: lambda.id.toString(),
			metadata: lambda.metadata,
			lambdaToken: lambdaToken.value,
			appApiPath: apiPath,
			fileName: `lambda_${lambda.id}`,
			entryPoint: lambda.git.entryPoint,
		}).copyInto());
		this._jail.setSync('lambdaData', new ivm.ExternalCopy(data.body).copyInto());
		this._jail.setSync('lambdaQuery', new ivm.ExternalCopy(data.query).copyInto());
		this._jail.setSync('lambdaRequestHeaders', new ivm.ExternalCopy(data.headers).copyInto());

		// Just exposing a few properties of exeuction
		this._jail.setSync('lambdaExecution', new ivm.ExternalCopy({
			id: execution.id.toString(),
			lambdaId: execution.lambdaId.toString(),
			deploymentId: execution.deploymentId.toString(),
			triggerType: execution.triggerType,
			executeAfter: execution.executeAfter,
			nextCronExpression: execution.nextCronExpression,
			status: execution.status,
			startedAt: execution.startedAt,
			endedAt: execution.endedAt,
			// Can we copy arrays?
			metadata: execution.metadata,
		}).copyInto());

		try {
			const hostile = this._isolate.compileScriptSync(`
				(async function() {
					function require(data) {
						const moduleName = lambdaModules[data];
						return global[moduleName];
					}

					if (!Buttress._initialised) {
						await Buttress.init(buttressOptions, true);
					} else {
						Buttress.setAuthToken(buttressOptions.appToken);
					}

					const lambdaBundle = require(lambdaInfo.fileName);
					const lambdaCode = new lambdaBundle();
					lambda.req.body = lambdaData;
					lambda.req.query = lambdaQuery;
					lambda.req.headers = lambdaRequestHeaders;
					await lambdaCode[lambdaInfo.entryPoint]();
				})();
			`);
			await hostile.run(this._context, {promise: true});
			// Maybe dispose isolate after executin the lambda?

			await this._updateDBLambdaFinishExecution(execution);

			if (type === 'API_ENDPOINT') {
				if (lambdaHelpers.lambdaResult && lambdaHelpers.lambdaResult.err) {
					throw new Error(lambdaHelpers.lambdaResult.errMessage);
				}

				if (trigger.redirect && lambdaHelpers.lambdaResult) lambdaHelpers.lambdaResult.redirect = true;
				const result = (lambdaHelpers.lambdaResult) ? lambdaHelpers.lambdaResult : 'success';
				this.__nrp.emit('lambda-execution-finish', {code: 200, res: result, restWorkerId: data.restWorkerId});
			}
		} catch (err) {
			await this._updateDBLambdaErrorExecution(lambda);
			Logging.logDebug(err);

			if (type === 'API_ENDPOINT') {
				const message = (err.message) ? err.message : err.errMessage;
				this.__nrp.emit('lambda-execution-finish', {code: 400, err: message, restWorkerId: data.restWorkerId});
			}

			return Promise.reject(new Error(`Failed to execute script for lambda:${lambda.name} - ${err}`));
		}
	}

	/**
	 * Fetch and run a lambda
	 * @param {object} payload
	 * @return {promise}
	 */
	async fetchExecuteLambda(payload) {
		const lambdaId = payload.data.lambdaId;
		const lambda = await Model.Lambda.findById(lambdaId);
		// TODO add a meaningful error message & notify manager
		if (!lambda) return;

		const app = await Model.App.findById(lambda._appId);
		// TODO add a meaningful error message & notify manager
		if (!app) return;

		const triggerType = payload.data.lambdaType;

		const executionId = payload.data.executionId;
		if (!executionId) throw new Error('unable to fetch execute lambda, missing executionId');

		const execution = await Model.LambdaExecution.findOne({
			id: Model.LambdaExecution.createId(executionId),
			status: 'PENDING',
		});
		if (!execution) throw new Error('Unable to find pending execution, with id: ' + executionId);

		try {
			this._lambdaExecution = execution;
			await this.execute(lambda, execution, app, triggerType, payload.data);

			this.working = false;
			this.__nrp.emit('lambda-worker-finished', {
				workerId: this.id,
				lambdaId: lambdaId,
				restWorkerId: payload.data.restWorkerId,
				workerExecID: payload.data.workerExecID,
			});
		} catch (err) {
			this.working = false;
			Logging.logError(err.message);
			await this._updateDBLambdaErrorExecution(execution, {
				message: err.message,
				type: 'ERROR',
			});
			this.__nrp.emit('lambda-worker-errored', {
				workerId: payload.workerId,
				workerExecID: payload.data.workerExecID,
				restWorkerId: payload.data.restWorkerId,
				lambdaId: lambdaId,
				lambdaType: triggerType,
				errMessage: err.message,
			});
		}
	}

	/**
	 * Communicate with main process via Redis
	 */
	_subscribeToLambdaManager() {
		this.__nrp.on('lambda:worker:announce', (payload) => {
			if (this.working) return;

			if (this.lambdaType && payload.lambdaType !== this.lambdaType) {
				Logging.logSilly(`Can not run a ${payload.lambdaType} on ${this.lambdaType} worker`);
				return;
			}

			Logging.logSilly(`[${this.name}] Manager called out ${payload.lambdaId}, attempting to acquire lambda`);
			this.__nrp.emit('lambda-worker-available', {
				workerId: this.id,
				data: payload,
			});
		});

		this.__nrp.on('lambda:worker:execute', (payload) => {
			if (payload.workerId !== this.id) return;

			Logging.logDebug(`[${this.name}] Manager has told me to take task ${payload.data.lambdaId}`);

			if (this.working) {
				Logging.logWarn(`[${this.name}] I've taken on too much work, releasing ${payload.data.lambdaId}`);
				this.__nrp.emit('lambda-worker-overloaded', payload);
				return;
			}

			this.working = true;

			this.fetchExecuteLambda(payload);
		});
	}

	async _updateDBLambdaRunningExecution(execution) {
		await Model.LambdaExecution.updateById(Model.LambdaExecution.createId(execution.id), {
			$set: {
				status: 'RUNNING',
				startedAt: Sugar.Date.create('now'),
			},
		});

		// if (type === 'CRON') {
		// 	await Model.Lambda.update({
		// 		'id': Model.Lambda.createId(lambda.id),
		// 		'trigger.type': type,
		// 	}, {$set: {'trigger.$.cron.status': 'RUNNING'}});
		// }
	}

	async _updateDBLambdaFinishExecution(execution) {
		await Model.LambdaExecution.updateById(Model.LambdaExecution.createId(execution.id), {
			$set: {
				status: 'COMPLETE',
				endedAt: Sugar.Date.create('now'),
			},
		});

		if (execution.nextCronExpression) {
			await Model.LambdaExecution.add({
				triggerType: 'CRON',
				lambdaId: Model.Lambda.createId(execution.lambdaId),
				deploymentId: Model.Deployment.createId(execution.deploymentId),
				executeAfter: Sugar.Date.create(execution.nextCronExpression),
				nextCronExpression: execution.nextCronExpression,
			}, execution._appId);

			// const completeTriggerObj = {
			// 	'trigger.$.cron.status': 'PENDING',
			// 	'trigger.$.cron.executionTime': Sugar.Date.create(trigger.periodicExecution),
			// };
			// await Model.Lambda.update({
			// 	'id': Model.Lambda.createId(lambda.id),
			// 	'trigger.type': type,
			// }, {
			// 	$set: completeTriggerObj,
			// });
		}
	}

	async _updateDBLambdaErrorExecution(execution, log = null) {
		await Model.LambdaExecution.updateById(Model.LambdaExecution.createId(execution.id), {
			$set: {
				status: 'ERROR',
				endedAt: Sugar.Date.create('now'),
			},
		});
		// if (type === 'CRON') {
		// 	await Model.Lambda.update({
		// 		'id': Model.Lambda.createId(lambda.id),
		// 		'trigger.type': type,
		// 	}, {$set: {'trigger.$.cron.status': 'ERROR'}});
		// }
		if (log) {
			await Model.LambdaExecution.update({
				id: Model.LambdaExecution.createId(execution.id),
			}, {
				$push: {
					logs: {
						log: log.message,
						type: log.type,
					},
				},
			});
		}
	}

	async installLambdaPackages(lambda, packageAllowList) {
		const packagePath = `${Config.paths.lambda.code}/lambda-${lambda.id}/package.json`;
		const modules = [];
		if (!fs.existsSync(packagePath)) return modules;

		const packages = require(`${Config.paths.lambda.code}/lambda-${lambda.id}/package.json`);
		for await (const packageKey of Object.keys(packages.dependencies)) {
			try {
				await exec(`npm ls ${packageKey}`);
			} catch (err) {
				let packageVersion = packages.dependencies[packageKey];
				const matchedPattern = packageVersion.match(/(^\D)/);
				const [removedPattern] = (matchedPattern) ? matchedPattern : [];
				packageVersion = packageVersion.replace(removedPattern, '');
				const packageIsInAllowList = packageAllowList.some((item) => {
					return item.packageName === packageKey && packageVersion === item.packageVersion;
				});

				if (err.code === 1 && packageIsInAllowList) {
					try {
						Logging.log(`Installing ${packageKey}@${packageVersion} for lambda ${lambda.name}`);
						await exec(`npm install ${packageKey}@${packageVersion}`);
						modules.push({
							name: packageKey,
						});
					} catch (err) {
						Logging.logError(err);
					}

					continue;
				}

				throw new Error(`Some of the lambda packages are not included on the allow list or mismatched package version`);
			}

			modules.push({
				name: packageKey,
			});
		}

		return modules;
	}

	_getLambdaModulesName(lambda) {
		const modules = [];
		const entryDir = path.dirname(lambda.git.entryFile);
		const entryFile = path.basename(lambda.git.entryFile);
		const lambdaDir = `${Config.paths.lambda.code}/lambda-${lambda.git.hash}/./${entryDir}`; // Again ugly /./ because... indolence

		modules.push({
			packageName: '@buttress/api',
			name: 'Buttress',
		}, {
			packageName: '@buttress/snippets',
			name: 'LambdaSnippet',
		}, {
			packageName: 'sugar',
			name: 'Sugar',
		}, {
			name: `lambda_${lambda.id}`,
			import: `${lambdaDir}/${entryFile}`,
		});

		return modules;
	}

	bundleLambdaModules(modules) {
		const entry = {};
		modules.forEach((m) => {
			const moduleName = (m.packageName) ? m.packageName.replace('/', '_') : m.name;
			if (m.packageName && fs.existsSync(`${Config.paths.lambda.bundles}/${moduleName}.js`)) return;

			entry[moduleName] = {
				import: (m.import)? m.import : m.packageName,
				library: {
					name: m.name,
					type: 'var',
				},
			};
		});

		return new Promise((resolve, reject) => {
			webpack({
				target: 'es2020',
				mode: 'development',
				entry: entry,
				resolve: {
					fallback: {
						crypto: require.resolve('crypto-browserify'),
					},
				},
				plugins: [
					new NodePolyfillPlugin(),
				],
				output: {
					path: path.resolve(Config.paths.lambda.bundles),
					chunkFormat: 'commonjs',
				},
			}, function(err, stats) {
				if (err && err.details) {
					reject(err.details);
				}

				if (stats) {
					const info = stats.toJson();
					if (stats.hasErrors()) {
						reject(info.errors);
					}

					if (stats.hasWarnings()) {
						reject(info.warnings);
					}
				}

				resolve();
			});
		})
			.catch((err) => {
				console.error(err);
			});
	}

	async _registerLambdaModules(lambdaModules) {
		for await (const mod of lambdaModules) {
			if (this._registeredBundles.includes(mod.packageName) || this._registeredBundles.includes(mod.name)) continue;

			let file = null;
			if (mod.packageName) {
				file = mod.packageName.replace('/', '_');
				this._registeredBundles.push(mod.packageName);
			} else {
				file = mod.name;
				this._registeredBundles.push(mod.name);
			}
			this._isolate.compileScriptSync(fs.readFileSync(`${Config.paths.lambda.bundles}/${file}.js`, 'utf8')).runSync(this._context);
		}
	}
}
module.exports = LambdasRunner;
