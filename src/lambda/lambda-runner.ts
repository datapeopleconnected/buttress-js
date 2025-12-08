/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { exec as cpExec } from 'node:child_process';

import NodeRedisPubsub from '../services/nrp.js';

const exec = util.promisify(cpExec);

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import ivm from 'isolated-vm';
import { v4 as uuidv4 } from 'uuid';
import webpack from 'webpack';

import NodePolyfillPlugin from 'node-polyfill-webpack-plugin';

import Sugar from '../helpers/sugar.js';
import Logging from '../helpers/logging.js';
import Model from '../model/index.js';
import * as Helpers from '../helpers/index.js';
import lambdaHelpers from '../lambda-helpers/helpers.js';
import { ExecPriority, LambdaExecutionMessage } from './lambda-manager.js';
import LambdaSchemaModel, { Lambda } from '../model/core/lambda.js';
import LambdaExecutionSchemaModel, { LambdaExecution } from '../model/core/lambda-execution.js';
import AppSchemaModel, { App } from '../model/core/app.js';
import TokenSchemaModel from '../model/core/token.js';
import UserSchemaModel from '../model/core/user.js';
import DeploymentSchemaModel from '../model/core/deployment.js';
import SecureStoreSchemaModel from '../model/core/secure-store.js';

export enum LambdaType {
	API_ENDPOINT = 'API_ENDPOINT',
	PATH_MUTATION = 'PATH_MUTATION',
	CRON = 'CRON',
	ALL = 'ALL',
};

export interface ExecutionResultMessage {
	code: number;
	res?: any;
	err?: any;
	reqId: string;
	executionId: string;
};

/**
 * Queue up pending Lambdas and execute them
 *
 * @class LambdaRunner
 */
export default class LambdaRunner {

	id: string;
	name: string;
	lambdaType: LambdaType;

	working: boolean;

	_timeout?: NodeJS.Timeout;
	_lambdaExecution: any;

	_isolate?: ivm.Isolate;
	_context?: ivm.Context;
	_jail?: ivm.Reference;
	_registeredBundles: string[] = [];
	_compiledLambdas: any;

	private __nrp?: NodeRedisPubsub;

	constructor(services, type) {
		this.__nrp = services.get('nrp');

		this.id = uuidv4();
		this.name = `LAMBDAS RUNNER ${this.id}`;
		this.lambdaType = type;

		Logging.logDebug(`[${this.name}] Created instance`);

		this.working = false;

		this._lambdaExecution = null;
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
		Logging.logDebug('LambdaRunner:init');

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
		Logging.logDebug('LambdaRunner:clean');

		// Shutdown isolate
	}

	/**
	 * gets static values specific to the application
	 * @param {Object} app
	 */
	async _getAppLambdaEnvironment(app): Promise<{[key: string]: unknown} | null> {
		const secureStore = await Model.getCoreModel(SecureStoreSchemaModel).findOne({
			name: 'environment',
			_appId: Model.getCoreModel(AppSchemaModel).createId(app.id),
		});
		if (!secureStore) return null;

		return secureStore.storeData;
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
	async execute(lambda: Lambda, execution: LambdaExecution, app: App, type: string, data: { body?: string, query?: string, headers?: string, reqId?: string }) {
		if (!this._isolate) throw new Error('Isolate not initialised');
		if (!this._jail) throw new Error('Isolate Jail not initialised');
		if (!this._context) throw new Error('Isolate Context not initialised');

		if (!lambda.git || !lambda.git.url) {
			return Promise.reject(new Error(`Unable to find git repo for lambda ${lambda.name}`));
		}

		if (type === 'API_ENDPOINT' && !data.reqId) {
			return Promise.reject(new Error(`Missing reqId for API_ENDPOINT lambda ${lambda.name}, execution ${execution.id}`));
		}

		const reqBody = (data.body) ? JSON.parse(data.body) : {};
		const reqQuery = (data.query) ? JSON.parse(data.query) : {};
		const reqHeaders = (data.headers) ? JSON.parse(data.headers) : {};

		const appLambdaEnv = await this._getAppLambdaEnvironment(app);
		let userToken: string | undefined = reqHeaders?.authorization || reqQuery?.token;
		userToken = (userToken) ? userToken.replace('Bearer ', '') : userToken;
		const rxsLambdaToken = await Model.getCoreModel(TokenSchemaModel).find({
			_appId: Model.getCoreModel(AppSchemaModel).createId(app.id),
			_lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
		});
		const lambdaToken: any = await Helpers.streamFirst(rxsLambdaToken);
		if (!lambdaToken) {
			return Promise.reject(new Error(`Unable to find lambda token for lambda ${lambda.name}, execution ${execution.id}`));
		}

		let executionUserId = null;
		let executionToken = lambdaToken;
		if (execution._tokenId) {
			const rxsExecToken = await Model.getCoreModel(TokenSchemaModel).find({
				_id: Model.getCoreModel(TokenSchemaModel).createId(execution._tokenId),
			});
			const execToken: any = await Helpers.streamFirst(rxsExecToken);
			if (!execToken) {
				return Promise.reject(new Error(`Unable to find lambda token for lambda ${lambda.name}, execution ${execution.id}`));
			}
			executionToken = execToken;

			if (execToken.type === 'user') {
				const rxsUser = await Model.getCoreModel(UserSchemaModel).find({
					_id: Model.getCoreModel(UserSchemaModel).createId(execToken._userId),
				});
				const user: any = await Helpers.streamFirst(rxsUser);
				if (!user) {
					return Promise.reject(new Error(`Unable to find user for token ${execToken.id}`));
				}
				executionUserId = user.id.toString();
			}
		}

		const apiPath = app.apiPath;
		// const appAllowList = app.allowList;
		const trigger = lambda.trigger.find((t) => t.type === type);
		// trigger = trigger?.[Sugar.String.camelize(type, false)];
		const buttressOptions = {
			buttressUrl: `${Config.app.protocol}://${Config.app.host}`,
			appToken: executionToken.value,
			apiPath: apiPath,
			allowUnauthorized: true,
		};
		const lambdaModules = {};

		// ? This doesn't seem right
		lambdaHelpers.lambdaExecution = execution;
		await this._updateDBLambdaRunningExecution(execution);

		// TODO: Handle case where lambda code doesn't exist on file system. (Clone Repo)
		// TODO: Handle case where lambda code can't be cloned. (Inform Manager)

		// TODO: Handle case where repo code hash doesn't match lambda. (Update Repo)

		// const modulesNames = await this.installLambdaPackages(lambda, appAllowList); // not install packages on lambdas anymore
		const modulesNames = this._getLambdaModulesName(lambda);
		await this.bundleLambdaModules(modulesNames);
		await this._registerLambdaModules(modulesNames);
		modulesNames.forEach((m: any) => {
			lambdaModules[m.name] = m.name;
		});

		this._jail.setSync('buttressOptions', new ivm.ExternalCopy(buttressOptions).copyInto());

		// * Would be better to just group these under one namespace "lambda". Unless we're going.
		this._jail.setSync('lambdaModules', new ivm.ExternalCopy(lambdaModules).copyInto());
		this._jail.setSync('lambdaInfo', new ivm.ExternalCopy({
			env: (appLambdaEnv) ? appLambdaEnv.env : null,
			lambdaId: lambda.id.toString(),
			executionId: execution.id.toString(),
			gitHash: lambda.git.hash,
			metadata: lambda.metadata,
			lambdaToken: lambdaToken.value,
			userId: executionUserId,
			appApiPath: apiPath,
			fileName: `lambda_${lambda.id}`,
			entryPoint: lambda.git.entryPoint,
			developmentEmailAddress: Config.lambda.developmentEmailAddress,
			userToken: userToken,
		}).copyInto());
		this._jail.setSync('lambdaData', new ivm.ExternalCopy(reqBody).copyInto());
		this._jail.setSync('lambdaQuery', new ivm.ExternalCopy(reqQuery).copyInto());
		this._jail.setSync('lambdaRequestHeaders', new ivm.ExternalCopy(reqHeaders).copyInto());

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

					if (Buttress.default) {
						global.Buttress = Buttress.default;
					}

					// Clean up the global.
					Buttress.clean();

					if (Buttress.initialised) {
						throw new Error('Buttress already initialised');
					}

					await Buttress.init(buttressOptions, true);

					const lambdaBundle = require(lambdaInfo.fileName);
					const lambdaCode = new lambdaBundle();
					lambda.req.body = lambdaData;
					lambda.req.query = lambdaQuery;
					lambda.req.headers = lambdaRequestHeaders;
					await lambdaCode[lambdaInfo.entryPoint]();
				})();
			`);
			await hostile.run(this._context, { promise: true });
			// Maybe dispose isolate after executin the lambda?

			await this._updateDBLambdaFinishExecution(execution);

			if (type === 'API_ENDPOINT') {
				if (lambdaHelpers.lambdaResult && lambdaHelpers.lambdaResult.err) {
					throw new Error(lambdaHelpers.lambdaResult.errMessage);
				}

				if (!data.reqId) {
					throw new Error(`Missing reqId for API_ENDPOINT lambda ${lambda.name}, execution ${execution.id}`);
				}

				if (trigger && trigger.apiEndpoint.redirect && lambdaHelpers.lambdaResult) lambdaHelpers.lambdaResult.redirect = true;
				const result = (lambdaHelpers.lambdaResult) ? lambdaHelpers.lambdaResult : 'success';

				const message: ExecutionResultMessage = { code: 200, res: result, reqId: data.reqId, executionId: execution.id };
				const json = JSON.stringify(message);
				this.__nrp?.emit('lambda:worker:execution-result', json);
				Logging.logSilly(`[${this.name}] Lambda ${lambda.name} execution ${execution.id} completed successfully: ${json}`);
			}
		} catch (err: any) {
			await this._updateDBLambdaErrorExecution(lambda);
			Logging.logDebug(err);

			if (type === 'API_ENDPOINT') {
				let errMessage = 'Unknown error occurred';
				if (err instanceof Error) {
					errMessage = err.message;
				} else if (err && Object.prototype.hasOwnProperty.call(err, 'errMessage')) {
					errMessage = err.errMessage;
				}

				if (data.reqId) {
					const message: ExecutionResultMessage = { code: 400, err: errMessage, reqId: data.reqId, executionId: execution.id };
					const json = JSON.stringify(message);
					this.__nrp?.emit('lambda:worker:execution-result', json);
					Logging.logSilly(`[${this.name}] Lambda ${lambda.name} execution ${execution.id} errored: ${json}`);
				} else {
					throw new Error(`Missing reqId for API_ENDPOINT lambda ${lambda.name}, execution ${execution.id}, error: ${errMessage}`);
				}
			}

			return Promise.reject(new Error(`Failed to execute script for lambda:${lambda.name} - ${err}`));
		}
	}

	/**
	 * Fetch and run a lambda
	 * @param {object} payload
	 * @return {promise}
	 */
	async handleLambdaExecutionMessage(payload: LambdaExecutionMessage) {
		const lambdaId = payload.lambdaId;
		const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(lambdaId) as Lambda | null;
		// TODO add a meaningful error message & notify manager
		if (!lambda) return;

		const app = await Model.getCoreModel(AppSchemaModel).findById(lambda._appId) as App | null;
		// TODO add a meaningful error message & notify manager
		if (!app) return;

		const triggerType = payload.lambdaType;

		const executionId = payload.executionId;
		if (!executionId) throw new Error('unable to fetch execute lambda, missing executionId');

		const execution = await Model.getCoreModel(LambdaExecutionSchemaModel).findOne({
			id: Model.getCoreModel(LambdaExecutionSchemaModel).createId(executionId),
			status: 'PENDING',
		}) as LambdaExecution | null;
		if (!execution) throw new Error('Unable to find pending execution, with id: ' + executionId);

		const body = execution.metadata.find((m) => m.key === 'BODY')?.value || undefined;
		const query = execution.metadata.find((m) => m.key === 'QUERY')?.value || undefined;
		const headers = execution.metadata.find((m) => m.key === 'HEADERS')?.value || undefined;
		const reqId = execution.metadata.find((m) => m.key === 'REQ_ID')?.value || undefined;

		try {
			this._lambdaExecution = execution;
			await this.execute(lambda, execution, app, triggerType, {
				body,
				query,
				headers,
				reqId,
			});

			this.working = false;
			this.__nrp?.emit('lambda:worker:finished', JSON.stringify({
				workerId: this.id,
				lambdaId: lambdaId,
				executionId: payload.executionId,
				reqId: reqId,
			}));
		} catch (err: any) {
			this.working = false;
			Logging.logError(err.message);
			await this._updateDBLambdaErrorExecution(execution, {
				message: err.message,
				type: 'ERROR',
			});
			this.__nrp?.emit('lambda:worker:errored', JSON.stringify({
				workerId: payload.workerId,
				executionId: payload.executionId,
				reqId: reqId,
				lambdaId: lambdaId,
				lambdaType: triggerType,
				errMessage: err.message,
			}));
		}
	}

	/**
	 * Communicate with main process via Redis
	 */
	_subscribeToLambdaManager() {
		Logging.logDebug(`Registering ${this.name} to listen for lambda execution messages`);
		this.__nrp?.on('lambda:worker:announce', (json: string) => {
			Logging.logDebug(`[${this.name}] Received lambda execution message: ${json}, working status: ${this.working}`);
			if (this.working) return;

			const message = JSON.parse(json) as LambdaExecutionMessage;

			if (this.lambdaType && this.lambdaType !== LambdaType.ALL && message.lambdaType !== this.lambdaType) {
				Logging.logSilly(`Can not run a ${message.lambdaType} on ${this.lambdaType} worker`);
				return;
			}

			message.workerId = this.id;

			Logging.logSilly(`[${this.name}] Manager called out ${message.executionId}, announcing availability`);
			this.__nrp?.emit('lambda:worker:available', JSON.stringify(message));
		});

		this.__nrp?.on('lambda:worker:execute', (json) => {
			const message = JSON.parse(json) as LambdaExecutionMessage;

			if (message.workerId !== this.id) return;

			Logging.logDebug(`[${this.name}] Manager has told me to take task ${message.executionId}`);

			if (this.working) {
				Logging.logWarn(`[${this.name}] I've taken on too much work, releasing ${message.executionId}`);

				message.currentExecutionId = this._lambdaExecution ? this._lambdaExecution.id : null;

				this.__nrp?.emit('lambda:worker:overloaded', JSON.stringify(message));
				return;
			}

			this.working = true;

			this.handleLambdaExecutionMessage(message);
		});
	}

	async _updateDBLambdaRunningExecution(execution) {
		await Model.getCoreModel(LambdaExecutionSchemaModel).updateById(
			Model.getCoreModel(LambdaExecutionSchemaModel).createId(execution.id),
			{
				$set: {
					status: 'RUNNING',
					startedAt: Sugar.Date.create('now'),
				},
			}
		);

		// if (type === 'CRON') {
		// 	await Model.getCoreModel(LambdaSchemaModel).update({
		// 		'id': Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
		// 		'trigger.type': type,
		// 	}, {$set: {'trigger.$.cron.status': 'RUNNING'}});
		// }
	}

	async _updateDBLambdaFinishExecution(execution) {
		await Model.getCoreModel(LambdaExecutionSchemaModel).updateById(
			Model.getCoreModel(LambdaExecutionSchemaModel).createId(execution.id),
			{
				$set: {
					status: 'COMPLETE',
					endedAt: Sugar.Date.create('now'),
				},
			}
		);

		if (execution.nextCronExpression) {
			await Model.getCoreModel(LambdaExecutionSchemaModel).add({
				triggerType: 'CRON',
				priority: ExecPriority.CRON,
				lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(execution.lambdaId),
				deploymentId: Model.getCoreModel(DeploymentSchemaModel).createId(execution.deploymentId),
				executeAfter: Sugar.Date.create(execution.nextCronExpression),
				nextCronExpression: execution.nextCronExpression,
				_tokenId: (execution._tokenId) ? Model.getCoreModel(LambdaSchemaModel).createId(execution._tokenId) : null,
			}, execution._appId);

			// const completeTriggerObj = {
			// 	'trigger.$.cron.status': 'PENDING',
			// 	'trigger.$.cron.executionTime': Sugar.Date.create(trigger.periodicExecution),
			// };
			// await Model.getCoreModel(LambdaSchemaModel).update({
			// 	'id': Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
			// 	'trigger.type': type,
			// }, {
			// 	$set: completeTriggerObj,
			// });
		}
	}

	async _updateDBLambdaErrorExecution(execution, log: any = null) {
		await Model.getCoreModel(LambdaExecutionSchemaModel).updateById(
			Model.getCoreModel(LambdaExecutionSchemaModel).createId(execution.id),
			{
				$set: {
					status: 'ERROR',
					endedAt: Sugar.Date.create('now'),
				},
			}
		);
		// if (type === 'CRON') {
		// 	await Model.getCoreModel(LambdaSchemaModel).update({
		// 		'id': Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
		// 		'trigger.type': type,
		// 	}, {$set: {'trigger.$.cron.status': 'ERROR'}});
		// }
		if (log) {
			await Model.getCoreModel(LambdaExecutionSchemaModel).updateById(
				Model.getCoreModel(LambdaExecutionSchemaModel).createId(execution.id),
				{
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
		const modules: any[] = [];
		if (!fs.existsSync(packagePath)) return modules;

		const packages = require(`${Config.paths.lambda.code}/lambda-${lambda.id}/package.json`);
		for await (const packageKey of Object.keys(packages.dependencies)) {
			try {
				await exec(`npm ls ${packageKey}`);
			} catch (err: any) {
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
		const modules: any[] = [];
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
				import: (m.import) ? m.import : m.packageName,
				library: {
					name: m.name,
					type: 'var',
				},
			};
		});

		Logging.logDebug(`[${this.name}] Bundling lambda modules: ${Object.keys(entry).join(', ')}`);

		return new Promise<void>((resolve, reject) => {
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
			}, function (err: any, stats) {
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
			.catch((error: any) => {
				Logging.logError('Error whilst bundling lambda modules');
				if (Array.isArray(error)) {
					error.forEach((err) => {
						Logging.logError(err.message);
					});
				} else if (typeof error === 'string') {
					Logging.logError(error);
				} else {
					Logging.logError(error.message);
				}
			});
	}

	async _registerLambdaModules(lambdaModules) {
		if (!this._isolate) throw new Error('Isolate not initialised');
		if (!this._context) throw new Error('Isolate not initialised');

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
			try {
				this._isolate.compileScriptSync(fs.readFileSync(`${Config.paths.lambda.bundles}/${file}.js`, 'utf8'))
					.runSync(this._context);
			} catch (err) {
				Logging.logError(`Error registering lambda module ${mod.name}`);
				throw err;
			}
		}
	}
}