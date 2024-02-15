const ivm = require('isolated-vm');
const fetch = require('cross-fetch');
const crypto = require('crypto');
const fs = require('fs');
const URL = require('url').URL;
const randomstring = require('randomstring');
const base64url = require('base64url');

const lambdaMail = require('./mail');
const Model = require('../model');
const Logging = require('../helpers/logging');
const {Errors} = require('../helpers');
// const { Object } = require('sugar');

const Config = require('node-env-obj')();


/**
 * Helpers
 * @class
 */
class Helpers {
	/**
	 * Constructor for Helpers
	 */
	constructor() {
		this.lambdaExecution = null;
		this.lambdaResult = null;
		this._plugins = {};
		this._pluginBootstrap = '';

		this.successfulHTTPScode = [200, 201, 202];
	}

	async _createIsolateContext(isolate, context, jail) {
		this.registerPlugins();

		jail.setSync('global', jail.derefInto());
		jail.setSync('_ivm', ivm);
		jail.setSync('_setResult', new ivm.Reference((res) => {
			if (typeof res !== 'object' || Array.isArray(res)) {
				this.lambdaResult = {
					err: true,
					errMessage: 'lambda result must be an object',
				};
				return;
			}

			this.lambdaResult = res;
		}));

		jail.setSync('_getEmailTemplate', new ivm.Reference(async (data, resolve, reject) => {
			try {
				Logging.logVerbose(`[${this.name}] Populating email body from template ${data.emailTemplate}`);

				const render = lambdaMail.getEmailTemplate(
					`${Config.paths.lambda.code}/lambda-${data.gitHash}/${data.emailTemplate}`, data.emailTemplate,
				);

				const output = await render(data.emailData);
				return resolve.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
				]);
			} catch (err) {
				reject.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto(),
				]);
			}
		}));
		jail.setSync('_lambdaAPI', new ivm.Reference(async (api, data, resolve) => {
			const lambdaAPIs = {
				cryptoCreateSign: () => {
					const signer = crypto.createSign(data.signature);
					if (data.preSignature) {
						signer.write(data.preSignature);
						signer.end;
					}
					return signer.sign(data.key, data.encodingType);
				},
				updateMetadata: async () => {
					if (data.idx === -1) {
						await Model.Lambda.updateById(Model.Lambda.createId(data.id), {
							$push: {
								metadata: {
									key: data.key,
									value: data.value,
								},
							},
						});
					} else {
						await Model.Lambda.updateById(Model.Lambda.createId(data.id), {
							$set: {
								[`metadata.${data.idx}.value`]: data.value,
							},
						});
					}
				},
			};

			const outcome = await lambdaAPIs[api]();

			resolve.applyIgnored(undefined, [
				new ivm.ExternalCopy(new ivm.Reference(outcome).copySync()).copyInto(),
			]);
		}));
		jail.setSync('_fetch', new ivm.Reference(async (data, callback, resolve, reject) => {
			if (typeof data === 'string') {
				const url = new URL(data);
				data = {
					url,
				};
			} else if (data.url) {
				data.url = (typeof data.url === 'string') ? new URL(data.url) : data.url;
			}
			try {
				if (data?.options?.body && data.options.headers && data.options.headers['Content-Type'] === 'application/x-www-form-urlencoded') {
					data.options.body = this._encodeReqBody(data.options.body);
				}
				const response = await fetch(data.url, data.options);
				const output = {};
				output.ok = response.ok;
				output.status = (response.status) ? response.status : null;
				output.url = response.url;
				output.redirected = response.redirected;

				if (!this.successfulHTTPScode.includes(output.status) && response.url && response.url !== data.url.href) {
					return _resolve(output);
				}

				if (!this.successfulHTTPScode.includes(output.status)) {
					const text = await response.text();
					if (text && typeof text === 'string') {
						let message = text;
						let json = null;
						try {
							json = JSON.parse(text);
						} catch (err) {
							// If we failed to parse the json we'll just treat it as a string.
						}

						if (json) {
							if (json.error && json.error.status === 'UNAUTHENTICATED') {
								throw new Errors.Unauthenticated(json.error.message, json.error.status, json.error.code);
							}
							if (json.error && json.error.status) {
								throw new Error(`${data.url.pathname} error is ${json.error.status}`);
							}
							if (json.error && json.error.toUpperCase() === 'INVALID_TOKEN') {
								throw new Errors.InvalidToken(text.error, 400);
							}
							if (json.error && json.error.toUpperCase() === 'INVALID_REQUEST') {
								throw new Errors.InvalidRequest(text.error, 400);
							}

							message = (json.error) ? json.error : (json.message) ? json.message : json.statusMessage;
						}

						throw new Error(`${data.url.pathname} error is ${message}`);
					} else {
						throw new Errors.CodedError(`${data.url.pathname} error is ${response.statusText}`, response.status);
					}
				}

				if (callback) {
					response.body.on('data', (chunk) => {
						chunk = chunk.toString();
						callback.applyIgnored(undefined, [
							new ivm.ExternalCopy(new ivm.Reference(chunk).copySync()).copyInto(),
						]);
					});
					response.body.on('end', () => {
						return _resolve(output);
					});
					response.body.on('error', (err) => {
						throw new Error(err);
					});
				} else {
					output.body = (output.status === 200 || output.status === 201) ? await response.json() : null;
					return _resolve(output);
				}
			} catch (err) {
				const error = {};
				if (err.message) {
					error.message = err.message;
				}
				if (err.code) {
					error.code = err.code;
				}
				if (err.status) {
					error.status = err.status;
				}
				const reference = (Object.keys(error).length > 0) ? new ivm.Reference(error).copySync() : new ivm.Reference(err).copySync();
				reject.applyIgnored(undefined, [
					new ivm.ExternalCopy(reference).copyInto(),
				]);
			}

			function _resolve(output) {
				resolve.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
				]);
			}
		}));
		jail.setSync('_cryptoRandomBytes', new ivm.Reference(async (data, resolve, reject) => {
			try {
				return resolve.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(crypto.randomBytes(data)).copySync()).copyInto(),
				]);
			} catch (err) {
				reject.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto(),
				]);
			}
		}));
		jail.setSync('_getCodeChallenge', new ivm.Reference(async (data, resolve, reject) => {
			try {
				const codeVerifier = randomstring.generate(128);
				const base64Digest = crypto.createHash('sha256').update(codeVerifier).digest('base64');
				const codeChallenge = base64url.fromBase64(base64Digest);
				return _resolve({
					codeVerifier,
					codeChallenge,
				});
			} catch (err) {
				reject.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto(),
				]);
			}

			function _resolve(output) {
				resolve.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
				]);
			}
		}));

		this._setupPlugins(jail);
		this._setupLambdaLogs(jail);
		this._createHostIsolateBridge(isolate, context);
		this._createLambdaNameSpace(isolate, context);
	}

	async _createHostIsolateBridge(isolate, context) {
		const bootstrap = await isolate.compileScript(`new function() {
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

		await bootstrap.run(context);
	}


	async _setupLambdaLogs(jail) {
		jail.setSync('_log', new ivm.Reference((...args) => {
			Logging.log(...args);
			this._pushLambdaExecutionLog(...args, 'log');
		}));

		jail.setSync('_logDebug', new ivm.Reference((...args) => {
			Logging.logDebug(...args);
			this._pushLambdaExecutionLog(...args, 'debug');
		}));

		jail.setSync('_logSilly', new ivm.Reference((...args) => {
			Logging.logSilly(...args);
			this._pushLambdaExecutionLog(...args, 'silly');
		}));

		jail.setSync('_logVerbose', new ivm.Reference((...args) => {
			Logging.logVerbose(...args);
			this._pushLambdaExecutionLog(...args, 'verbose');
		}));

		jail.setSync('_logWarn', new ivm.Reference((...args) => {
			Logging.logWarn(...args);
			this._pushLambdaExecutionLog(...args, 'warn');
		}));

		jail.setSync('_logError', new ivm.Reference((...args) => {
			Logging.logError(...args);
			this._pushLambdaExecutionLog(...args, 'error');
		}));
	}

	async _setupPlugins(jail) {
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

	_createLambdaNameSpace(isolate, context) {
		isolate.compileScriptSync(`
			const lambda = {
				log: (...args) => {
					log(...args);
				},
				logDebug: (...args) => {
					logDebug(...args);
				},
				logSilly: (...args) => {
					logSilly(...args);
				},
				logVerbose: (...args) => {
					logVerbose(...args);
				},
				logWarn: (...args) => {
					logWarn(...args);
				},
				logError: (...args) => {
					logError(...args);
				},
				setResult: (...args) => {
					setResult(...args);
				},
				fetch: async (...args) => {
					return fetch(...args);
				},
				cryptoRandomBytes: async (...args) => {
					return cryptoRandomBytes(...args);
				},
				getEmailTemplate: async(...args) => {
					return getEmailTemplate(...args);
				},
				getCodeChallenge: async (...args) => {
					return getCodeChallenge(...args);
				},
				req: {
					body: {},
					query: {},
				},
				env: '${new ivm.Reference(Config.env.toUpperCase()).copySync()}',
				developmentEmailAddress: '${new ivm.Reference(Config.lambda.developmentEmailAddress).copySync()}',
			};
		`).runSync(context);
	}

	_pushLambdaExecutionLog(log, type) {
		Model.LambdaExecution.update({
			id: Model.LambdaExecution.createId(this.lambdaExecution.id),
		}, {
			$push: {
				logs: {
					log,
					type,
				},
			},
		});
	}

	_encodeReqBody(body) {
		const formBody = [];
		Object.keys(body).forEach((key) => {
			const encodedKey = encodeURIComponent(key);
			const encodedValue = encodeURIComponent(body[key]);
			formBody.push(encodedKey + '=' + encodedValue);
		});
		return formBody.join('&');
	}

	registerPlugins() {
		const getClassesList = (dirName) => {
			let files = [];
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
		const classes = getClassesList(Config.paths.lambda.plugins);
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
}

module.exports = new Helpers();
