const ivm = require('isolated-vm');
const fetch = require('cross-fetch');
const crypto = require('crypto');
const URL = require('url').URL;
const randomstring = require('randomstring');
const base64url = require('base64url');
const puppeteer = require('puppeteer');

const lambdaMail = require('./mail');
const Model = require('../model');
const Logging = require('../helpers/logging');
const {Errors} = require('../helpers');
const IsolateBridge = require('./isolate-bridge');
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

		this.successfulHTTPScode = [200, 201, 202];
	}

	async _createIsolateContext(isolate, context, jail) {
		IsolateBridge.registerPlugins();

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
							if (json.error && (typeof json.error === 'string' && json.error.toUpperCase() === 'INVALID_TOKEN')) {
								throw new Errors.InvalidToken(json.error, 400);
							}
							if (json.error && (typeof json.error === 'string' && json.error.toUpperCase() === 'INVALID_REQUEST')) {
								const msg = (text && text.error) ? text.error : (json.error_description) ? json.error_description : null;
								throw new Errors.InvalidRequest(msg, 400);
							}
							if (json.message && json.code) {
								const error = new Error(json.message);
								error.code = json.code;
								throw error;
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
		jail.setSync('_generatePDF', new ivm.Reference(async (htmlString, resolve, reject) => {
			try {
				if (!htmlString) throw new Error(`Missing HTML string for pdf generation`);
				const browser = await puppeteer.launch({headless: true});
				const page = await browser.newPage();

				// Set the HTML content
				await page.setContent(htmlString, {waitUntil: 'networkidle2'});
				const buffer = await page.pdf({format: 'A4', printBackground: true});
				await browser.close();
				resolve.applyIgnored(undefined, [
					new ivm.ExternalCopy(new ivm.Reference(buffer.toString('base64')).copySync()).copyInto(),
				]);
			} catch (err) {
				const reference = new ivm.Reference(err).copySync();
				reject.applyIgnored(undefined, [
					new ivm.ExternalCopy(reference).copyInto(),
				]);
			}
		}));

		IsolateBridge.setupPlugins(jail);
		IsolateBridge.setupLambdaLogs(jail);
		IsolateBridge.createHostIsolateBridge(isolate, context);
		IsolateBridge.createLambdaNameSpace(isolate, context);
	}

	_encodeReqBody(body) {
		if (typeof body === 'string') return encodeURIComponent(body);

		const formBody = [];
		Object.keys(body).forEach((key) => {
			const encodedKey = encodeURIComponent(key);
			const encodedValue = encodeURIComponent(body[key]);
			formBody.push(encodedKey + '=' + encodedValue);
		});
		return formBody.join('&');
	}
}

module.exports = new Helpers();
