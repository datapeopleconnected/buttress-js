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

import ivm from 'isolated-vm';
import fs from 'fs';

import Model from '../model';
import Logging from '../helpers/logging';

import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;


/**
 * IsolateBridge
 * @class
 */
class IsolateBridge {
	_plugins: {
		[key: string]: {
			plugin: any;
			methods: string[];
		};
	};
	_pluginBootstrap: string;

	/**
	 * Constructor for Helpers
	 */
	constructor() {
		this._plugins = {};
		this._pluginBootstrap = '';
	}

	registerPlugins() {
		const getClassesList = (dirName) => {
			let files: NodeRequire[] = [];
			const items = fs.readdirSync(dirName, {withFileTypes: true});
			for (const item of items) {
				if (item.name === '.git') continue;

				if (item.isDirectory()) {
					files = [...files, ...getClassesList(`${dirName}/${item.name}`)];
				} else {
					files.push(require(`${dirName}/${item.name}`));
				}
			}

			return files;
		};

		this._plugins = {};
		const classes: any = getClassesList(Config.paths.lambda.plugins);
		const plugins = classes.filter((c) => c.startUp);
		const prot = ['constructor', 'startUp'];
		plugins.forEach((p) => {
			const className = p.constructor.name;

			const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(p)).filter((n) => prot.indexOf(n) === -1 && /^_/.exec(n) === null);
			this._plugins[className] = {plugin: p, methods: methods};

			Logging.logVerbose(`Plugin '${className}' Methods: ${methods.join(',')}`);
			p.startUp();
		});
		Logging.log(`Registered: ${Object.keys(this._plugins).length} lambda plugins`);
	}

	async setupPlugins(jail) {
		this._pluginBootstrap = '';

		for (const [pluginName, pluginMeta] of Object.entries(this._plugins)) {
			for (const method of pluginMeta.methods) {
				this._pluginBootstrap += `
					let ${pluginName}_${method} = _${pluginName}_${method};
					delete _${pluginName}_${method};
					global.${pluginName}_${method} = (args) => {
						return new Promise((resolve, reject) => {
							${pluginName}_${method}.applyIgnored(
								undefined,
								[new ivm.ExternalCopy(args).copyInto(), new ivm.Reference(resolve), new ivm.Reference(reject)],
							);
						});
					}
				`;
				jail.setSync(`_${pluginName}_${method}`, new ivm.Reference(async (args, resolve, reject) => {
					Logging.logVerbose(`${pluginName}_${method}`);
					const outcome = await pluginMeta.plugin[method](args);
					resolve.applyIgnored(undefined, [
						new ivm.ExternalCopy(new ivm.Reference(outcome).copySync()).copyInto(),
					]);
				}));
			}
		}
	}

	createHostIsolateBridge(isolate, context) {
		const bootstrap = isolate.compileScriptSync(`new function() {
			let ivm = _ivm;
			delete _ivm;

			${this._pluginBootstrap}

			let log = _log;
			delete _log;
			let logSilly = _logSilly;
			delete _logSilly;
			let logDebug = _logDebug;
			delete _logDebug;
			let logVerbose = _logVerbose;
			delete _logVerbose;
			let logWarn = _logWarn;
			delete _logWarn;
			let logError = _logError;
			delete _logError;

			let setResult = _setResult;
			delete _setResult;

			let fetch = _fetch;
			delete _fetch;

			let cryptoRandomBytes = _cryptoRandomBytes;
			delete _cryptoRandomBytes;

			let getEmailTemplate = _getEmailTemplate;
			delete _getEmailTemplate;

			let lambdaAPI = _lambdaAPI;
			delete _lambdaAPI;

			let getCodeChallenge = _getCodeChallenge;
			delete _getCodeChallenge;

			let generatePDF = _generatePDF;
			delete _generatePDF;

			global.log = (...args) => {
				log.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logSilly = (...args) => {
				logSilly.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logDebug = (...args) => {
				logDebug.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logVerbose = (...args) => {
				logVerbose.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logWarn = (...args) => {
				logWarn.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logError = (...args) => {
				logError.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}

			global.setResult = (...args) => {
				setResult.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}

			global.lambdaAPI = (key, value) => {
				return new Promise((resolve) => {
					lambdaAPI.applyIgnored(
						undefined,
						[new ivm.ExternalCopy(key).copyInto(), new ivm.ExternalCopy(value).copyInto(), new ivm.Reference(resolve)],
					);
				});
			}

			global.fetch = (data, callback = null) => {
				return new Promise((resolve, reject) => {
					if (!callback) {
						callback = new ivm.ExternalCopy(callback).copyInto();
					} else {
						callback = new ivm.Reference(callback)
					}
					fetch.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(data).copyInto(),
							callback,
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			global.cryptoRandomBytes = (data) => {
				return new Promise((resolve, reject) => {
					cryptoRandomBytes.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(data).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			global.getEmailTemplate = (data) => {
				return new Promise((resolve, reject) => {
					getEmailTemplate.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(data).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			global.getCodeChallenge = (data) => {
				return new Promise((resolve, reject) => {
					getCodeChallenge.applyIgnored(
						undefined,
						[new ivm.ExternalCopy(data).copyInto(), new ivm.Reference(resolve), new ivm.Reference(reject)],
					);
				});
			}

			global.generatePDF = (htmlString) => {
				return new Promise((resolve, reject) => {
					generatePDF.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(htmlString).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			return new ivm.Reference(function forwardMainPromise(mainFunc, resolve) {
				const derefMainFunc = mainFunc.deref();

				derefMainFunc().then((value) => {
					resolve.applyIgnored(
							undefined,
							[new ivm.ExternalCopy(value).copyInto()],
						);
					});
				});
			}`);

		bootstrap.runSync(context);
	}


	async setupLambdaLogs(jail) {
		jail.setSync('_log', new ivm.Reference((...args) => {
			Logging.log(args[0], args[2], args[3]);
			this._pushLambdaExecutionLog(args[0], 'log');
		}));

		jail.setSync('_logDebug', new ivm.Reference((...args) => {
			Logging.logDebug(args[0], args[2]);
			this._pushLambdaExecutionLog(args[0], 'debug');
		}));

		jail.setSync('_logSilly', new ivm.Reference((...args) => {
			Logging.logSilly(args[0], args[2]);
			this._pushLambdaExecutionLog(args[0], 'silly');
		}));

		jail.setSync('_logVerbose', new ivm.Reference((...args) => {
			Logging.logVerbose(args[0], args[2]);
			this._pushLambdaExecutionLog(args[0], 'verbose');
		}));

		jail.setSync('_logWarn', new ivm.Reference((...args) => {
			Logging.logWarn(args[0], args[2]);
			this._pushLambdaExecutionLog(args[0], 'warn');
		}));

		jail.setSync('_logError', new ivm.Reference((...args) => {
			Logging.logError(args[0], args[2]);
			this._pushLambdaExecutionLog(args[0], 'error');
		}));
	}

	_pushLambdaExecutionLog(log, type) {
		throw new Error('Need to resolve where this.lambdaExecution.id is coming from');
		// Model.getModel('Lambda').Execution.update({
		// 	id: Model.getModel('Lambda').Execution.createId(this.lambdaExecution.id),
		// }, {
		// 	$push: {
		// 		logs: {
		// 			log,
		// 			type,
		// 		},
		// 	},
		// });
	}

	createLambdaNameSpace(isolate, context) {
		isolate.compileScriptSync(`
			const lambda = {
				log: (...args) => log(...args),
				logDebug: (...args) => logDebug(...args),
				logSilly: (...args) => logSilly(...args),
				logVerbose: (...args) => logVerbose(...args),
				logWarn: (...args) => logWarn(...args),
				logError: (...args) => logError(...args),
				setResult: (...args) => setResult(...args),
				fetch: async (...args) => fetch(...args),
				cryptoRandomBytes: async (...args) => cryptoRandomBytes(...args),
				getEmailTemplate: async(...args) => getEmailTemplate(...args),
				getCodeChallenge: async (...args) => getCodeChallenge(...args),
				generatePDF: async (...args) => generatePDF(...args),
				req: {
					body: {},
					query: {},
				},
				env: '${new ivm.Reference(Config.env.toUpperCase()).copySync()}',
				developmentEmailAddress: '${new ivm.Reference(Config.lambda.developmentEmailAddress).copySync()}',
			};
			console = {
				log: lambda.log,
				debug: lambda.logDebug,
				silly: lambda.logSilly,
				verbose: lambda.logVerbose,
				warn: lambda.logWarn,
				error: lambda.logError,
				assert: (condition, ...data) => {
					if (!condition) {
						lambda.logError('Assertion failed:', ...data);
					}
				},
				time: (label = 'default') => {
					if (!console.timers) {
						console.timers = {};
					}
					console.timers[label] = Date.now();
				},
				timeEnd: (label = 'default') => {
					if (console.timers && console.timers[label]) {
						const duration = Date.now() - console.timers[label];
						lambda.log(\`\${label}: \${duration}ms\`);
						delete console.timers[label];
					}
				},
			};
		`).runSync(context);
	}
}
module.exports = new IsolateBridge();
