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
import { URL } from 'node:url';
import Stream from 'node:stream';

import ivm from 'isolated-vm';
// import fetch from 'cross-fetch';
import crypto from 'crypto';
import randomstring from 'randomstring';
import puppeteer from 'puppeteer';

import lambdaMail from './mail.js';
import Model from '../model/index.js';
import Logging from '../helpers/logging.js';
import { Errors } from '../helpers/index.js';
import IsolateBridge from './isolate-bridge.js';

import createConfig from '@dpc/node-env-obj';
import LambdaSchemaModel from '../model/core/lambda.js';
const Config = createConfig() as unknown as Config;

/**
 * Helpers
 * @class
 */
class Helpers {
  lambdaExecution: any;
  lambdaResult: any;

  successfulHTTPScode: number[];
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

    jail.setSync(
      'global',
      jail.derefInto({
        release: false,
      }),
    );
    jail.setSync('_ivm', ivm);
    jail.setSync(
      '_setResult',
      new ivm.Reference((res) => {
        if (typeof res !== 'object' || Array.isArray(res)) {
          this.lambdaResult = {
            err: true,
            errMessage: 'lambda result must be an object',
          };
          return;
        }

        this.lambdaResult = res;
      }),
    );

    jail.setSync(
      '_getEmailTemplate',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          Logging.logVerbose(`Populating email body from template ${data.emailTemplate}`);

          const render = lambdaMail.getEmailTemplate(
            `${Config.paths.lambda.code}/lambda-${data.gitHash}/${data.emailTemplate}`,
            data.emailTemplate,
          );

          const output = await render(data.emailData);
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
          ]);
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoCreateSign',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          Logging.logVerbose(`Creating crypto signature ${data.signature}`);

          const signer = crypto.createSign(data.signature);
          if (data.preSignature) {
            signer.write(data.preSignature);
            signer.end();
          }
          const output = signer.sign(data.key, data.encodingType);

          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
          ]);
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_updateMetadata',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          Logging.logVerbose(
            `Updating metadata for ${data.id}:${data.idx} with key ${data.key} and value ${data.value}`,
          );

          if (data.idx === -1) {
            await Model.getCoreModel(LambdaSchemaModel).updateById(
              Model.getCoreModel(LambdaSchemaModel).createId(data.id),
              {
                $push: {
                  metadata: {
                    key: data.key,
                    value: data.value,
                  },
                },
              },
            );
          } else {
            await Model.getCoreModel(LambdaSchemaModel).updateById(
              Model.getCoreModel(LambdaSchemaModel).createId(data.id),
              {
                $set: {
                  [`metadata.${data.idx}.value`]: data.value,
                },
              },
            );
          }

          return resolve.applyIgnored(undefined);
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_fetch',
      new ivm.Reference(async (data, callback, resolve, reject) => {
        if (typeof data === 'string') {
          const url = new URL(data);
          data = {
            url,
          };
        } else if (data.url) {
          data.url = typeof data.url === 'string' ? new URL(data.url) : data.url;
        }

        Logging.logSilly(
          `Lambda Fetch - [${data.options?.method}] ${data.url.href} with options - ${JSON.stringify(data.options)}`,
        );

        try {
          if (
            data?.options?.body &&
            data.options.headers &&
            data.options.headers['Content-Type'] === 'application/x-www-form-urlencoded'
          ) {
            data.options.body = new URLSearchParams(data.options.body);
          }

          // Prevent keep-alive connections due to TCP issues in docker environments
          // Possibly due to the use of SEARCH method header.
          data.options = data.options || {};
          data.options.headers = data.options.headers || {};
          data.options.headers['Connection'] = 'close';

          const response: {
            ok?: boolean;
            status?: number | null;
            url?: string;
            redirected?: boolean;
            body?: any;
            text?: any;
            json?: any;
            statusText?: string;
          } = await fetch(data.url, data.options);
          const output: {
            ok?: boolean;
            status?: number | null;
            url?: string;
            redirected?: boolean;
            body?: any;
          } = {
            ok: response.ok,
            status: response.status ? response.status : null,
            url: response.url,
            redirected: response.redirected,
          };

          Logging.logDebug(`Lambda Fetch Response - [${data.options?.method}] ${data.url.href} - ${output.status}`);

          if (
            output.status &&
            !this.successfulHTTPScode.includes(output.status) &&
            response.url &&
            response.url !== data.url.href
          ) {
            return _resolve(output);
          }

          if (output.status && !this.successfulHTTPScode.includes(output.status)) {
            const text = response && response.text ? await response.text() : null;
            if (text && typeof text === 'string') {
              let message = text;
              let json: any = null;
              try {
                json = JSON.parse(text);
              } catch (_err) {
                // If we failed to parse the json we'll just treat it as a string.
              }

              if (json) {
                Logging.logDebug(text);

                if (json.error && json.error.status === 'UNAUTHENTICATED') {
                  throw new Errors.Unauthenticated(json.error.message, json.error.status, json.error.code);
                }
                if (json.error && json.error.status) {
                  throw new Error(`${data.url.pathname} error is ${json.error.status}`);
                }
                if (json.error && typeof json.error === 'string' && json.error.toUpperCase() === 'INVALID_TOKEN') {
                  throw new Errors.InvalidToken(json.error, 400);
                }
                if (json.error && typeof json.error === 'string' && json.error.toUpperCase() === 'INVALID_REQUEST') {
                  const msg = json && json.error ? json.error : json.error_description ? json.error_description : null;
                  throw new Errors.InvalidRequest(msg, 400);
                }
                if (json.message && json.code) {
                  const error: any = new Error(json.message);
                  error.code = json.code;
                  throw error;
                }

                if (json.error) message = json.error;
                if (json.error && json.error.message) message = json.error.message;
                if (json.message) message = json.message;
                if (json.statusMessage) message = json.statusMessage;
              }

              throw new Error(`${data.url.pathname} error is ${message}`);
            } else {
              const responseStatus = response.status ? response.status : 520;
              throw new Errors.CodedError(`${data.url.pathname} error is ${response.statusText}`, responseStatus);
            }
          }

          if (callback) {
            if (!response.body) {
              // Handle this
              throw new Error('No response body');
            }

            if (response.body instanceof Stream) {
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
              const text = response && response.text ? await response.text() : null;
              callback.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(text).copySync()).copyInto()]);
              return _resolve(output);
            }
          } else {
            const body = response && response.json ? await response.json() : null;
            output.body = output.status === 200 || output.status === 201 ? body : null;
            return _resolve(output);
          }
        } catch (err: any) {
          const error: any = {};
          if (err.message) {
            error.message = err.message;
          }
          if (err.code) {
            error.code = err.code;
          }
          if (err.status) {
            error.status = err.status;
          }
          const reference =
            Object.keys(error).length > 0 ? new ivm.Reference(error).copySync() : new ivm.Reference(err).copySync();
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(reference).copyInto()]);
        }

        function _resolve(output) {
          resolve.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoRandomBytes',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(crypto.randomBytes(data).toString('hex')).copySync()).copyInto(),
          ]);
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoCreateHash',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          data.message = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
          const hash = crypto.createHash(data.algorithm);
          hash.update(JSON.stringify(data.message), 'utf8');
          const output = hash.digest('hex');
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
          ]);
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoCreateCipheriv',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          const key = crypto.randomBytes(32); // 32 bytes
          const iv = crypto.randomBytes(12); // Generate random 12 bytes IV
          const cipher = crypto.createCipheriv(data.algorithm, key, iv);
          const message = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
          let ciphertext = cipher.update(message, 'utf8', 'hex');
          ciphertext += cipher.final('hex');
          const authTag = cipher.getAuthTag();
          const output = {
            key: key.toString('hex'),
            iv: iv.toString('hex'),
            authTag: authTag.toString('hex'),
            ciphertext,
          };
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
          ]);
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoCreateDecipheriv',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          const decipher = crypto.createDecipheriv(
            data.algorithm,
            Buffer.from(data.key, 'hex'),
            Buffer.from(data.iv, 'hex'),
          );
          decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));
          let message = decipher.update(data.message, 'hex', 'utf8');
          message += decipher.final('utf8');
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(message).copySync()).copyInto(),
          ]);
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_getCodeChallenge',
      new ivm.Reference(async (data, resolve, reject) => {
        try {
          const codeVerifier = randomstring.generate(128);
          const base64Digest = crypto.createHash('sha256').update(codeVerifier).digest('base64');
          const codeChallenge = base64Digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
          return _resolve({
            codeVerifier,
            codeChallenge,
          });
        } catch (err) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }

        function _resolve(output) {
          resolve.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_generatePDF',
      new ivm.Reference(async (htmlString, resolve, reject) => {
        try {
          if (!htmlString) throw new Error(`Missing HTML string for pdf generation`);
          const browser = await puppeteer.launch({ headless: true });
          const page = await browser.newPage();

          // Set the HTML content and wait for initial document load.
          await page.setContent(htmlString, { waitUntil: 'load' });

          // ! These lines should have tests written against them.
          const pdfResult = await page.pdf({ format: 'A4', printBackground: true });
          await browser.close();
          resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(Buffer.from(pdfResult).toString('base64')).copySync()).copyInto(),
          ]);
        } catch (err) {
          const reference = new ivm.Reference(err).copySync();
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(reference).copyInto()]);
        }
      }),
    );

    IsolateBridge.setupPlugins(jail);
    IsolateBridge.setupLambdaLogs(jail);
    IsolateBridge.createHostIsolateBridge(isolate, context);
  }

  // _encodeReqBody(body) {
  // 	if (typeof body === 'string') return encodeURIComponent(body);

  // 	const formBody: any[] = [];
  // 	Object.keys(body).forEach((key) => {
  // 		const encodedKey = encodeURIComponent(key);
  // 		const encodedValue = encodeURIComponent(body[key]);
  // 		formBody.push(encodedKey + '=' + encodedValue);
  // 	});
  // 	return formBody.join('&');
  // }
}

export default new Helpers();
