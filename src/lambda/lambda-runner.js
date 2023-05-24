const fs = require('fs');
const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const Config = require('node-env-obj')();
const Sugar = require('sugar');
const NRP = require('node-redis-pubsub');
const nrp = new NRP(Config.redis);
const ivm = require('isolated-vm');
const {v4: uuidv4} = require('uuid');
const webpack = require('webpack');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

const Logging = require('../logging');
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
	 * Creates an instance of LambdasRunner.
	 */
	constructor() {
		this.id = uuidv4();
		this.name = `LAMBDAS RUNNER ${this.id}`;

		Logging.logDebug(`[${this.name}] Created instance`);

		this.working = false;

		this._timeout = null;
		this._lambdaExecution = null;

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

		const appToken = await Model.Token.findById(app._tokenId);
		if (!appToken) {
			return Promise.reject(new Error(`Unable to find app token for app ${app.name}`));
		}

		const rxsLambdaToken = await Model.Token.find({
			_appId: Model.App.createId(app._id),
			_lambdaId: Model.User.createId(lambda._id),
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
		await this._updateDBLambdaRunningExecution(lambda, execution, type);

		// const modulesNames = await this.installLambdaPackages(lambda, appAllowList); // not install packages on lambdas anymore
		const modulesNames = this._getLambdaModulesName(lambda);
		await this.bundleLambdaModules(modulesNames);
		await this._registerLambdaModules(modulesNames);
		modulesNames.forEach((m) => {
			lambdaModules[m.name] = m.name;
		});

		this._jail.setSync('buttressOptions', new ivm.ExternalCopy(buttressOptions).copyInto());
		this._jail.setSync('lambdaModules', new ivm.ExternalCopy(lambdaModules).copyInto());
		this._jail.setSync('lambdaInfo', new ivm.ExternalCopy({
			lambdaId: lambda._id.toString(),
			metadata: lambda.metadata,
			lambdaToken: lambdaToken.value,
			appApiPath: apiPath,
			fileName: `lambda_${lambda._id}`,
			entryPoint: lambda.git.entryPoint,
		}).copyInto());
		this._jail.setSync('lambdaData', new ivm.ExternalCopy(data.body).copyInto());
		this._jail.setSync('lambdaQuery', new ivm.ExternalCopy(data.query).copyInto());
		this._jail.setSync('lambdaRequestHeaders', new ivm.ExternalCopy(data.headers).copyInto());

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

			await this._updateDBLambdaFinishExecution(lambda, execution, type, trigger);

			if (type === 'API_ENDPOINT') {
				if (lambdaHelpers.lambdaResult && lambdaHelpers.lambdaResult.err) {
					throw new Error(lambdaHelpers.lambdaResult.errMessage);
				}

				if (trigger.redirect && lambdaHelpers.lambdaResult) lambdaHelpers.lambdaResult.redirect = true;
				const result = (lambdaHelpers.lambdaResult) ? lambdaHelpers.lambdaResult : 'success';
				nrp.emit('lambda-execution-finish', {code: 200, res: result, restWorkerId: data.restWorkerId});
			}
		} catch (err) {
			await this._updateDBLambdaErrorExecution(lambda, execution, type);

			Logging.logDebug(err);

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
		// TODO add a meaningful error message
		if (!lambda) return;

		const app = await Model.App.findById(lambda._appId);
		// TODO add a meaningful error message
		if (!app) return;

		const cronTrigger = lambda.trigger.findIndex((t) => t.type === 'CRON');
		const apiEndpointTrigger = lambda.trigger.findIndex((t) => t.type === 'API_ENDPOINT');
		const pathMutationTrigger = lambda.trigger.findIndex((t) => t.type === 'PATH_MUTATION');

		let triggerType = null;
		if (cronTrigger !== -1) {
			triggerType = lambda.trigger[cronTrigger].type;
		} else if (apiEndpointTrigger !== -1) {
			triggerType = lambda.trigger[apiEndpointTrigger].type;
		} else if (pathMutationTrigger !== -1) {
			triggerType = lambda.trigger[pathMutationTrigger].type;
		}

		let execution = await Model.LambdaExecution.findOne({
			lambdaId: Model.Lambda.createId(lambda._id),
			status: 'PENDING',
		});

		if (!execution && apiEndpointTrigger !== -1) return;

		try {
			execution = (execution) ? execution : await this._createLambdaExecution(lambda);

			this._lambdaExecution = execution;
			await this.execute(lambda, execution, app, triggerType, payload.data);

			this.working = false;
			nrp.emit('lambda-worker-finished', {
				workerId: this.id,
				lambdaId: lambdaId,
				restWorkerId: payload.data.restWorkerId,
				workerExecID: payload.data.workerExecID,
			});
		} catch (err) {
			this.working = false;
			Logging.logError(err.message);
			await this._updateDBLambdaErrorExecution(lambda, execution, triggerType, {
				message: err.message,
				type: 'ERROR',
			});
			nrp.emit('lambda-worker-errored', {
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
		nrp.on('lambda-manager-announce', (payload) => {
			if (this.working) return;

			Logging.logSilly(`[${this.name}] Manager called out ${payload.lambdaId}, attempting to acquire lambda`);
			nrp.emit('lambda-worker-available', {
				workerId: this.id,
				data: payload,
			});
		});

		nrp.on('lambda-worker-execute', (payload) => {
			if (payload.workerId !== this.id) return;

			Logging.logDebug(`[${this.name}] Manager has told me to take task ${payload.data.lambdaId}`);

			if (this.working) {
				Logging.logWarn(`[${this.name}] I've taken on too much work, releasing ${payload.data.lambdaId}`);
				nrp.emit('lambda-worker-overloaded', payload);
				return;
			}

			this.working = true;

			this.fetchExecuteLambda(payload);
		});
	}

	async _createLambdaExecution(lambda) {
		const deployment = await Model.Deployment.findOne({
			lambdaId: Model.Lambda.createId(lambda._id),
			hash: lambda.git.hash,
		});

		// TODO add a meaningful error message
		if (!deployment) return;

		const lambdaExecution = await Model.LambdaExecution.add({
			lambdaId: Model.Lambda.createId(lambda._id),
			deploymentId: Model.Deployment.createId(deployment._id),
		});

		return lambdaExecution;
	}

	async _updateDBLambdaRunningExecution(lambda, execution, type) {
		await Model.LambdaExecution.updateById(Model.LambdaExecution.createId(execution._id), {
			$set: {
				status: 'RUNNING',
				startedAt: Sugar.Date.create('now'),
			},
		});
		if (type === 'CRON') {
			await Model.Lambda.update({
				'_id': Model.Lambda.createId(lambda._id),
				'trigger.type': type,
			}, {$set: {'trigger.$.cron.status': 'RUNNING'}});
		}
	}

	async _updateDBLambdaFinishExecution(lambda, execution, type, trigger) {
		await Model.LambdaExecution.updateById(Model.LambdaExecution.createId(execution._id), {
			$set: {
				status: 'COMPLETE',
				endedAt: Sugar.Date.create('now'),
			},
		});

		if (type === 'CRON') {
			const completeTriggerObj = {
				'trigger.$.cron.status': 'PENDING',
				'trigger.$.cron.executionTime': Sugar.Date.create(trigger.periodicExecution),
			};
			await Model.Lambda.update({
				'_id': Model.Lambda.createId(lambda._id),
				'trigger.type': type,
			}, {
				$set: completeTriggerObj,
			});
		}
	}

	async _updateDBLambdaErrorExecution(lambda, execution, type, log = null) {
		await Model.LambdaExecution.updateById(Model.LambdaExecution.createId(execution._id), {
			$set: {
				status: 'ERROR',
				endedAt: Sugar.Date.create('now'),
			},
		});
		if (type === 'CRON') {
			await Model.Lambda.update({
				'_id': Model.Lambda.createId(lambda._id),
				'trigger.type': type,
			}, {$set: {'trigger.$.cron.status': 'ERROR'}});
		}
		if (log) {
			await Model.LambdaExecution.update({
				_id: Model.LambdaExecution.createId(execution._id),
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
		const packagePath = `${Config.paths.lambda.code}/lambda-${lambda._id}/package.json`;
		const modules = [];
		if (!fs.existsSync(packagePath)) return modules;

		const packages = require(`${Config.paths.lambda.code}/lambda-${lambda._id}/package.json`);
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
		const lambdaDir = `${Config.paths.lambda.code}/lambda-${lambda._id}/./${entryDir}`; // Again ugly /./ because... indolence

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
			name: `lambda_${lambda._id}`,
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
