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
import LambdaRun from './lambda-run.js';
import { LambdaValueError, MAX_LAMBDA_VALUE_BYTES, refusedValue, unfoldedSize } from './lambda-value.js';

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

const tooLargeToLog = (value: unknown) => {
  try {
    return unfoldedSize(value) > MAX_LAMBDA_VALUE_BYTES;
  } catch (err: unknown) {
    if (err instanceof LambdaValueError) return false;
    throw err;
  }
};

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

  /**
   * Constructor for Helpers
   */
  constructor() {
    this._plugins = {};
    this._pluginBootstrap = '';
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

  async setupPlugins(jail: IsolateJail, context: ivm.Context) {
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
          new ivm.Reference(async (onResolve: IsolateCallback, onReject: IsolateCallback, ...args: unknown[]) => {
            Logging.logVerbose(`${pluginName}_${method}`);
            const run = LambdaRun.in(context, `${pluginName}_${method}`);
            if (!run) return;
            const [resolve, reject] = [run.answer(onResolve), run.answer(onReject)];
            const refusal = refusedValue(args);
            if (refusal) return reject.applyIgnored(undefined, [refusal]);
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
			
			// WebCrypto's synchronous half, which the packages a lambda bundles read their randomness from. The bytes come
			// from the host, as the isolate has none of its own.
			const randomBytes = (size) => {
				const hex = _cryptoRandomBytesSync(size);
				const bytes = new Uint8Array(size);
				for (let i = 0; i < size; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
				return bytes;
			};
			global.crypto = {
				getRandomValues: (array) => {
					if (array.byteLength > 65536) throw new Error('getRandomValues: more than 65536 bytes requested');
					new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(randomBytes(array.byteLength));
					return array;
				},
				randomUUID: () => {
					const bytes = randomBytes(16);
					bytes[6] = (bytes[6] & 0x0f) | 0x40;
					bytes[8] = (bytes[8] & 0x3f) | 0x80;
					const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
					return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
				},
			};

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

  // Logged by the process and kept with the execution of the run that logged it, and refused once that run has finished
  setupLambdaLogs(jail: IsolateJail, context: ivm.Context) {
    const lambdaLog = (name: string, type: string, log: (args: LambdaLogArgs) => void) =>
      new ivm.Reference((...args: LambdaLogArgs) => {
        const run = LambdaRun.in(context, name);
        if (!run) return;
        // What the host couldn't write out is noted in its place. What refers to itself is written as before.
        args.forEach((arg, idx) => {
          if (tooLargeToLog(arg)) args[idx] = `[more than ${MAX_LAMBDA_VALUE_BYTES / 1024 / 1024} MB left out]`;
        });
        log(args);
        run.log(args[0], type);
      });

    jail.setSync(
      '_log',
      lambdaLog('_log', 'log', (args) => Logging.log(args[0], args[2], args[3])),
    );
    jail.setSync(
      '_logDebug',
      lambdaLog('_logDebug', 'debug', (args) => Logging.logDebug(args[0], args[2])),
    );
    jail.setSync(
      '_logSilly',
      lambdaLog('_logSilly', 'silly', (args) => Logging.logSilly(args[0], args[2])),
    );
    jail.setSync(
      '_logVerbose',
      lambdaLog('_logVerbose', 'verbose', (args) => Logging.logVerbose(args[0], args[2])),
    );
    jail.setSync(
      '_logWarn',
      lambdaLog('_logWarn', 'warn', (args) => Logging.logWarn(args[0], args[2])),
    );
    jail.setSync(
      '_logError',
      lambdaLog('_logError', 'error', (args) => Logging.logError(args[0], args[2])),
    );
  }
}
export default new IsolateBridge();
