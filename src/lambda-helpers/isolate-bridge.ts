/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import ivm from 'isolated-vm';

import Logging from '../helpers/logging.js';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

/**
 * The isolate's global object, which the host sets its functions and values on.
 */
export type IsolateJail = ivm.Reference<Record<string, unknown>>;

/**
 * A function in the isolate passed to the host by reference, e.g. a promise's resolve or reject.
 */
export type IsolateCallback = ivm.Reference<(value?: unknown) => void>;

// A plugin module's default export: an instance whose public methods are exposed to lambdas.
interface LambdaPlugin {
  startUp: () => unknown;
  [method: string]: (...args: unknown[]) => unknown;
}

// A lambda's log call arguments. Only the first is logged, the third and fourth go to Logging's level/id parameters.
type LambdaLogArgs = [unknown, unknown?, string?, string?];

export interface LambdaExecutionLog {
  log: string;
  type: string;
}

// How much of a run's logging is kept with its execution, which Mongo caps at 16 MB with everything else it holds
const MAX_EXECUTION_LOG_BYTES = 1024 * 1024;

/**
 * IsolateBridge
 * @class
 */
class IsolateBridge {
  _plugins: {
    [key: string]: {
      plugin: LambdaPlugin;
      methods: string[];
    };
  };
  _pluginBootstrap: string;

  // What the executing lambda has logged, kept with its execution when it finishes
  _executionLogs: LambdaExecutionLog[] = [];
  _executionLogBytes = 0;
  _droppedExecutionLogs = 0;

  /**
   * Constructor for Helpers
   */
  constructor() {
    this._plugins = {};
    this._pluginBootstrap = '';
  }

  /**
   * Starts collecting a run's logs afresh.
   */
  startExecutionLogs() {
    this._executionLogs = [];
    this._executionLogBytes = 0;
    this._droppedExecutionLogs = 0;
  }

  /**
   * Gives the run's logs, with a note of how many were left out past the limit, and starts afresh.
   */
  takeExecutionLogs(): LambdaExecutionLog[] {
    const logs = this._executionLogs;
    if (this._droppedExecutionLogs > 0) {
      logs.push({ log: `${this._droppedExecutionLogs} more log lines were left out`, type: 'warn' });
    }
    this.startExecutionLogs();
    return logs;
  }

  registerPlugins() {
    const getClassesList = (dirName: string): Partial<LambdaPlugin>[] => {
      let files: Partial<LambdaPlugin>[] = [];

      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(dirName, { withFileTypes: true });
      } catch (e: unknown) {
        Logging.logError(`Error reading directory: ${dirName}`);
        Logging.logError(e);
        return [];
      }

      for (const item of items) {
        if (item.name === '.git') continue;

        if (item.isDirectory()) {
          files = [...files, ...getClassesList(`${dirName}/${item.name}`)];
        } else {
          files.push((require(`${dirName}/${item.name}`) as { default: Partial<LambdaPlugin> }).default);
        }
      }

      return files;
    };

    this._plugins = {};
    const classes = getClassesList(Config.paths.lambda.plugins);
    const plugins = classes.filter((c) => c.startUp) as LambdaPlugin[];
    const prot = ['constructor', 'startUp'];
    Logging.logSilly('Plugins to register:', plugins.map((p) => p.constructor.name).join(','));
    plugins.forEach((p) => {
      const className = p.constructor.name;

      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(p)).filter(
        (n) => prot.indexOf(n) === -1 && /^_/.exec(n) === null,
      );
      this._plugins[className] = { plugin: p, methods: methods };

      Logging.logVerbose(`Plugin '${className}' Methods: ${methods.join(',')}`);
      p.startUp();
    });
    Logging.log(`Registered: ${Object.keys(this._plugins).length} lambda plugins`);
  }

  async setupPlugins(jail: IsolateJail) {
    this._pluginBootstrap = '';

    for (const [pluginName, pluginMeta] of Object.entries(this._plugins)) {
      for (const method of pluginMeta.methods) {
        this._pluginBootstrap += `
					let ${pluginName}_${method} = _${pluginName}_${method};
					delete _${pluginName}_${method};
					global.${pluginName}_${method} = (...args) => {
						return new Promise((resolve, reject) => {
							${pluginName}_${method}.applyIgnored(
								undefined,
								[new ivm.Reference(resolve), new ivm.Reference(reject)].concat(args.map(arg => new ivm.ExternalCopy(arg).copyInto())),
							);
						});
					}
				`;
        jail.setSync(
          `_${pluginName}_${method}`,
          new ivm.Reference(async (resolve: IsolateCallback, reject: IsolateCallback, ...args: unknown[]) => {
            Logging.logVerbose(`${pluginName}_${method}`);
            try {
              const outcome = await pluginMeta.plugin[method](...args);
              resolve.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(outcome).copySync()).copyInto()]);
            } catch (error: unknown) {
              const statusCode =
                (error as { status?: number | string } | null | undefined)?.status?.toString() || 'UNKNOWN_ERROR';
              reject.applyIgnored(undefined, [new ivm.ExternalCopy(`ERROR: ${statusCode}`).copyInto()]);
            }
          }),
        );
      }
    }
  }

  createHostIsolateBridge(isolate: ivm.Isolate, context: ivm.Context) {
    isolate
      .compileScriptSync(
        `new function() {
			let ivm = _ivm;
			delete _ivm;

			${this._pluginBootstrap}

			global.log = (...args) => {
				_log.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logSilly = (...args) => {
				_logSilly.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logDebug = (...args) => {
				_logDebug.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logVerbose = (...args) => {
				_logVerbose.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logWarn = (...args) => {
				_logWarn.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}
			global.logError = (...args) => {
				_logError.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}

			global.setResult = (...args) => {
				_setResult.applyIgnored(undefined, args.map(arg => new ivm.ExternalCopy(arg).copyInto()));
			}

			global.fetch = (data, callback = null) => {
				return new Promise((resolve, reject) => {
					if (!callback) {
						callback = new ivm.ExternalCopy(callback).copyInto();
					} else {
						callback = new ivm.Reference(callback)
					}
					_fetch.applyIgnored(
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
					_cryptoRandomBytes.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(data).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}
			
			global.cryptoCreateSign = (data) => {
				return new Promise((resolve, reject) => {
					_cryptoCreateSign.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(data).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			global.cryptoEncryptWithKey = (data) => {
				return new Promise((resolve, reject) => {
					_cryptoEncryptWithKey.applyIgnored(
						undefined,
						[new ivm.ExternalCopy(data).copyInto(), new ivm.Reference(resolve), new ivm.Reference(reject)],
					);
				});
			}

			global.cryptoDecryptWithKey = (data) => {
				return new Promise((resolve, reject) => {
					_cryptoDecryptWithKey.applyIgnored(
						undefined,
						[new ivm.ExternalCopy(data).copyInto(), new ivm.Reference(resolve), new ivm.Reference(reject)],
					);
				});
			}

			global.updateMetadata = (data) => {
				return new Promise((resolve, reject) => {
					_updateMetadata.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(data).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			// The host compiles the template to a render function's source, which runs here in the isolate
			global.getEmailTemplate = (data) => {
				return new Promise((resolve, reject) => {
					_getEmailTemplate.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(data).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				}).then((source) => new Function(source + ';return template;')()(data && data.emailData));
			}

			global.getCodeChallenge = (data) => {
				return new Promise((resolve, reject) => {
					_getCodeChallenge.applyIgnored(
						undefined,
						[new ivm.ExternalCopy(data).copyInto(), new ivm.Reference(resolve), new ivm.Reference(reject)],
					);
				});
			}

			global.generatePDF = (htmlString) => {
				return new Promise((resolve, reject) => {
					_generatePDF.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(htmlString).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			global.sleep = (ms) => {
				return new Promise((resolve, reject) => {
					_sleep.applyIgnored(
						undefined,
						[
							new ivm.ExternalCopy(ms).copyInto(),
							new ivm.Reference(resolve),
							new ivm.Reference(reject),
						],
					);
				});
			}

			return new ivm.Reference(function forwardMainPromise(mainFunc, resolve) {
				const derefMainFunc = mainFunc.deref();

				derefMainFunc()
					.then((value) => {
						resolve.applyIgnored(
							undefined,
							[new ivm.ExternalCopy(value).copyInto()],
						);
					});
			});
		}

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
			cryptoCreateSign: async (...args) => cryptoCreateSign(...args),
			cryptoEncryptWithKey: async (...args) => cryptoEncryptWithKey(...args),
			cryptoDecryptWithKey: async (...args) => cryptoDecryptWithKey(...args),
			getEmailTemplate: async(...args) => getEmailTemplate(...args),
			getCodeChallenge: async (...args) => getCodeChallenge(...args),
			generatePDF: async (...args) => generatePDF(...args),
			sleep: async (...args) => sleep(...args),
			req: {
				body: {},
				query: {},
			},
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
		`,
      )
      .runSync(context);

    // bootstrap.runSync(context);
  }

  async setupLambdaLogs(jail: IsolateJail) {
    jail.setSync(
      '_log',
      new ivm.Reference((...args: LambdaLogArgs) => {
        Logging.log(args[0], args[2], args[3]);
        this._pushLambdaExecutionLog(args[0], 'log');
      }),
    );

    jail.setSync(
      '_logDebug',
      new ivm.Reference((...args: LambdaLogArgs) => {
        Logging.logDebug(args[0], args[2]);
        this._pushLambdaExecutionLog(args[0], 'debug');
      }),
    );

    jail.setSync(
      '_logSilly',
      new ivm.Reference((...args: LambdaLogArgs) => {
        Logging.logSilly(args[0], args[2]);
        this._pushLambdaExecutionLog(args[0], 'silly');
      }),
    );

    jail.setSync(
      '_logVerbose',
      new ivm.Reference((...args: LambdaLogArgs) => {
        Logging.logVerbose(args[0], args[2]);
        this._pushLambdaExecutionLog(args[0], 'verbose');
      }),
    );

    jail.setSync(
      '_logWarn',
      new ivm.Reference((...args: LambdaLogArgs) => {
        Logging.logWarn(args[0], args[2]);
        this._pushLambdaExecutionLog(args[0], 'warn');
      }),
    );

    jail.setSync(
      '_logError',
      new ivm.Reference((...args: LambdaLogArgs) => {
        Logging.logError(args[0], args[2]);
        this._pushLambdaExecutionLog(args[0], 'error');
      }),
    );
  }

  _pushLambdaExecutionLog(log: unknown, type: string) {
    let text: string;
    try {
      text = typeof log === 'string' ? log : (JSON.stringify(log) ?? String(log));
    } catch {
      text = String(log);
    }

    const bytes = Buffer.byteLength(text);
    if (this._executionLogBytes + bytes > MAX_EXECUTION_LOG_BYTES) {
      this._droppedExecutionLogs++;
      return;
    }
    this._executionLogBytes += bytes;
    this._executionLogs.push({ log: text, type });
  }
}
export default new IsolateBridge();
