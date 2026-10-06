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
import https from 'node:https';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import ivm from 'isolated-vm';
// import fetch from 'cross-fetch';
import crypto from 'crypto';
import randomstring from 'randomstring';
import puppeteer from 'puppeteer';

import lambdaMail from './mail.js';
import Model from '../model/index.js';
import Logging from '../helpers/logging.js';
import { redactUrl } from '../helpers/redact.js';
import { allowedAddressLookup, checkDestination, parseAllowedHosts } from '../helpers/egress.js';
import { Errors } from '../helpers/index.js';
import { isGitHash } from '../helpers/git.js';
import IsolateBridge from './isolate-bridge.js';
import type { IsolateCallback, IsolateJail } from './isolate-bridge.js';
import LambdaRun from './lambda-run.js';
import type { LambdaResult, RunCallback } from './lambda-run.js';

import createConfig from '@dpc/node-env-obj';
import LambdaSchemaModel from '../model/core/lambda.js';
const Config = createConfig() as unknown as Config;

// Node's built-in fetch() has an internal bug that occasionally leaves a lambda's outbound call
// stuck forever with no trace of it anywhere below the JS layer (no packet sent, no libuv request
// queued, event loop otherwise idle) — reproducible via the isolated-vm bridge, never in isolation.
// The classic http/https module doesn't hit it, so _fetch below uses that instead of global fetch().
interface NodeHttpFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function nodeHttpFetch(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: unknown },
  lookup?: ReturnType<typeof allowedAddressLookup>,
  signal?: AbortSignal,
): Promise<NodeHttpFetchResponse> {
  return new Promise((resolve, reject) => {
    // Recompute Content-Length from the actual bytes rather than trust the caller-supplied header
    // — a mismatch there causes the server to hang waiting for body bytes that never arrive.
    const bodyBuffer =
      options.body !== undefined && options.body !== null
        ? Buffer.from(typeof options.body === 'string' ? options.body : String(options.body), 'utf8')
        : undefined;
    const headers = { ...options.headers };
    if (bodyBuffer) {
      headers['Content-Length'] = String(bodyBuffer.byteLength);
    } else {
      delete headers['Content-Length'];
    }

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: options.method || 'GET',
        headers,
        // agent:false forces a fresh socket per request — pooled keep-alive sockets get reset by the
        // far end in docker environments, possibly by a proxy that doesn't know a method like SEARCH or QUERY.
        agent: false,
        ...(lookup ? { lookup } : {}),
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText: res.statusMessage || http.STATUS_CODES[status] || '',
            url: url.href,
            redirected: false,
            headers: {
              get: (name: string) => {
                const value = res.headers[name.toLowerCase()];
                if (value === undefined) return null;
                return Array.isArray(value) ? value.join(', ') : value;
              },
            },
            text: async () => bodyText,
            json: async () => JSON.parse(bodyText) as unknown,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

// A host function called from the isolate, which settles the lambda's promise through resolve/reject. It acts for the run
// that called it.
type HostFunction<TData> = (data: TData, resolve: RunCallback, reject: RunCallback, run: LambdaRun) => Promise<void>;

// What lambdas pass to the host functions. It's untrusted and unchecked, these describe what the host expects.
interface EmailTemplateRequest {
  // Unused: templates come from the executing lambda's own code folder
  gitHash?: string;
  emailTemplate: string;
  emailData?: Record<string, unknown>;
}

interface CreateSignRequest {
  signature: string;
  preSignature?: string;
  key: string;
  encodingType: crypto.BinaryToTextEncoding;
}

interface UpdateMetadataRequest {
  // Must be the executing lambda's id, when given
  id?: string;
  idx: number;
  key: string;
  value: string;
}

// A url string, or the url and the options for nodeHttpFetch(). The url is replaced with a URL in place.
interface FetchRequest {
  url?: string | URL;
  options?: Parameters<typeof nodeHttpFetch>[1];
}

type FetchHostFunction = (
  data: string | FetchRequest,
  callback: ivm.Reference<(text: string | null) => void> | null,
  resolve: IsolateCallback,
  reject: IsolateCallback,
) => Promise<void>;

interface CreateHashRequest {
  algorithm: string;
  message: unknown;
}

// The host generates a 12 byte IV and reads an auth tag, i.e. a GCM cipher.
interface EncryptRequest {
  algorithm: crypto.CipherGCMTypes;
  message: unknown;
}

interface EncryptWithKeyRequest extends EncryptRequest {
  key: string;
}

interface DecryptRequest {
  algorithm: crypto.CipherGCMTypes;
  key: string;
  iv: string;
  authTag: string;
  message: string;
}

/**
 * Helpers
 * @class
 */
/**
 * What a lambda that runs as its caller has as its default token. A request that sends it is made as the caller,
 * and one that sends any other token, such as the lambda's own, is made as that token.
 */
export const CALLER_TOKEN_PLACEHOLDER = 'BUTTRESS_CALLER';

/**
 * Makes a request to this Buttress instance as the caller when it carries the placeholder token, in its place.
 * Any other request is left as it is, so the caller's token only ever goes to this instance.
 */
export const asCaller = (
  url: URL,
  headers: Record<string, string> | undefined,
  caller: { token: string; origin: string },
): { url: URL; headers: Record<string, string> } => {
  const asIs = { url, headers: headers ?? {} };
  if (url.origin !== caller.origin) return asIs;

  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization');
  if (!entry || entry[1].replace(/^Bearer /, '') !== CALLER_TOKEN_PLACEHOLDER) return asIs;

  // The deprecated ?token= would otherwise let the request say a different token than its header
  const asCallerUrl = new URL(url);
  asCallerUrl.searchParams.delete('token');
  return { url: asCallerUrl, headers: { ...headers, [entry[0]]: `Bearer ${caller.token}` } };
};

class Helpers {
  successfulHTTPScode: number[];
  /**
   * Constructor for Helpers
   */
  constructor() {
    this.successfulHTTPScode = [200, 201, 202];
  }

  async _createIsolateContext(isolate: ivm.Isolate, context: ivm.Context, jail: IsolateJail) {
    IsolateBridge.registerPlugins();

    // A host function acts for the run going in this context when it's called, see LambdaRun. It answers the isolate
    // only while that run is going, and is refused when there's none.
    const forRun = <TData>(name: string, hostFunction: HostFunction<TData>) =>
      new ivm.Reference(async (data: TData, resolve: IsolateCallback, reject: IsolateCallback) => {
        const run = LambdaRun.in(context, name);
        if (run) await hostFunction(data, run.answer(resolve), run.answer(reject), run);
      });

    jail.setSync(
      'global',
      jail.derefInto({
        release: false,
      }),
    );
    jail.setSync('_ivm', ivm);
    jail.setSync(
      '_setResult',
      new ivm.Reference((res: unknown) => {
        const run = LambdaRun.in(context, '_setResult');
        if (!run) return;

        if (typeof res !== 'object' || Array.isArray(res)) {
          run.result = {
            err: true,
            errMessage: 'lambda result must be an object',
          };
          return;
        }

        run.result = res as LambdaResult | null;
      }),
    );

    jail.setSync(
      '_getEmailTemplate',
      forRun<EmailTemplateRequest>('_getEmailTemplate', async (data, resolve, reject, run) => {
        try {
          Logging.logVerbose(`Populating email body from template ${data.emailTemplate}`);

          if (!isGitHash(run.lambdaGitHash)) throw new Error('no_executing_lambda');

          // The isolate runs the template's render function, see getEmailTemplate in isolate-bridge
          const output = lambdaMail.getEmailTemplateSource(
            `${Config.paths.lambda.code}/lambda-${run.lambdaGitHash}`,
            String(data.emailTemplate),
          );
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
          ]);
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoCreateSign',
      forRun<CreateSignRequest>('_cryptoCreateSign', async (data, resolve, reject) => {
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
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_updateMetadata',
      forRun<UpdateMetadataRequest>('_updateMetadata', async (data, resolve, reject, run) => {
        try {
          Logging.logVerbose(
            `Updating metadata for ${data.id}:${data.idx} with key ${data.key} and value ${data.value}`,
          );

          // Only the executing lambda's metadata can be updated
          const lambdaId = run.lambdaId;
          if (data.id !== undefined && String(data.id) !== lambdaId) throw new Error('invalid_lambda_id');
          if (!Number.isInteger(data.idx) || data.idx < -1) throw new Error('invalid_metadata_index');

          if (data.idx === -1) {
            await Model.getCoreModel(LambdaSchemaModel).updateById(
              Model.getCoreModel(LambdaSchemaModel).createId(lambdaId),
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
              Model.getCoreModel(LambdaSchemaModel).createId(lambdaId),
              {
                $set: {
                  [`metadata.${data.idx}.value`]: data.value,
                },
              },
            );
          }

          return resolve.applyIgnored(undefined);
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_fetch',
      new ivm.Reference<FetchHostFunction>(async (data, onText, onResolve, onReject) => {
        const run = LambdaRun.in(context, '_fetch');
        if (!run) return;
        const [callback, resolve, reject] = [onText && run.answer(onText), run.answer(onResolve), run.answer(onReject)];

        if (typeof data === 'string') {
          const url = new URL(data);
          data = {
            url,
          };
        } else if (data.url) {
          data.url = typeof data.url === 'string' ? new URL(data.url) : data.url;
        }

        // data.url is a URL from here on, unless a request object had no url (then this line throws).
        // Not the options or the whole URL, whose headers, body and query can carry the lambda's credentials
        Logging.logSilly(`Lambda Fetch - [${data.options?.method}] ${redactUrl(data.url)}`);

        try {
          if (
            data?.options?.body &&
            data.options.headers &&
            data.options.headers['Content-Type'] === 'application/x-www-form-urlencoded'
          ) {
            data.options.body = new URLSearchParams(data.options.body as string | Record<string, string>);
          }

          data.options = data.options || {};

          if (run.caller) {
            const request = asCaller(data.url as URL, data.options.headers, run.caller);
            data.url = request.url;
            data.options.headers = request.headers;
          }

          // Only to a host the operator allows, when they've set a list, and never to the instance's own network then
          const allowedHosts = parseAllowedHosts(Config.lambda.allowedHosts);
          const problem = await checkDestination(data.url as URL, allowedHosts);
          if (problem) throw new Errors.CodedError(`fetch_${problem}`, 403);

          // Aborted if the run ends first
          const response = await nodeHttpFetch(
            data.url as URL,
            data.options,
            allowedAddressLookup(allowedHosts),
            run.signal,
          );

          const output: {
            ok?: boolean;
            status?: number | null;
            url?: string;
            redirected?: boolean;
            body?: unknown;
          } = {
            ok: response.ok,
            status: response.status ? response.status : null,
            url: response.url,
            redirected: response.redirected,
          };

          Logging.logDebug(
            `Lambda Fetch Response - [${data.options?.method}] ${redactUrl(data.url)} - ${output.status}`,
          );

          if (
            output.status &&
            !this.successfulHTTPScode.includes(output.status) &&
            response.url &&
            response.url !== (data.url as URL).href
          ) {
            return _resolve(output);
          }

          if (output.status && !this.successfulHTTPScode.includes(output.status)) {
            const text = response && response.text ? await response.text() : null;
            if (text && typeof text === 'string') {
              type ParsedErrorObject = {
                status?: string;
                message?: string;
                code?: string | number;
                error_description?: string;
              };

              type ParsedErrorEntry = {
                code?: string;
                message?: string;
                path?: string;
              };

              type ParsedErrorPayload = {
                error?: string | ParsedErrorObject;
                message?: string;
                code?: string | number;
                statusMessage?: string;
                error_description?: string;
                errors?: ParsedErrorEntry[];
              };

              const isRecord = (value: unknown): value is Record<string, unknown> => {
                return typeof value === 'object' && value !== null && !Array.isArray(value);
              };

              let message = text;
              let json: ParsedErrorPayload | null = null;

              try {
                const parsed: unknown = JSON.parse(text);
                if (isRecord(parsed)) {
                  const parsedError = parsed.error;
                  const normalizedError =
                    typeof parsedError === 'string'
                      ? parsedError
                      : isRecord(parsedError)
                        ? {
                            status: typeof parsedError.status === 'string' ? parsedError.status : undefined,
                            message: typeof parsedError.message === 'string' ? parsedError.message : undefined,
                            code:
                              typeof parsedError.code === 'string' || typeof parsedError.code === 'number'
                                ? parsedError.code
                                : undefined,
                            error_description:
                              typeof parsedError.error_description === 'string'
                                ? parsedError.error_description
                                : undefined,
                          }
                        : undefined;

                  const normalizedErrors = Array.isArray(parsed.errors)
                    ? parsed.errors.filter(isRecord).map((entry) => ({
                        code: typeof entry.code === 'string' ? entry.code : undefined,
                        message: typeof entry.message === 'string' ? entry.message : undefined,
                        path: typeof entry.path === 'string' ? entry.path : undefined,
                      }))
                    : undefined;

                  json = {
                    error: normalizedError,
                    message: typeof parsed.message === 'string' ? parsed.message : undefined,
                    code: typeof parsed.code === 'string' || typeof parsed.code === 'number' ? parsed.code : undefined,
                    statusMessage: typeof parsed.statusMessage === 'string' ? parsed.statusMessage : undefined,
                    error_description:
                      typeof parsed.error_description === 'string' ? parsed.error_description : undefined,
                    errors: normalizedErrors,
                  };
                }
              } catch (_err) {
                // If we failed to parse the json we'll just treat it as a string.
              }

              if (json) {
                Logging.logDebug(text);
                const httpStatus = output.status as number;

                if (typeof json.error === 'string') {
                  if (json.error.toUpperCase() === 'INVALID_TOKEN') {
                    throw new Errors.InvalidToken(json.error, 400);
                  }
                  if (json.error.toUpperCase() === 'INVALID_REQUEST') {
                    const msg = json.error_description || json.error;
                    throw new Errors.InvalidRequest(msg, 400);
                  }

                  throw new Errors.UpstreamApiError(
                    json.error_description || json.error,
                    json.error.toUpperCase(),
                    httpStatus,
                    { retryable: false },
                  );
                } else if (json.error) {
                  if (json.error.status === 'UNAUTHENTICATED') {
                    const unauthenticatedCode = Number(json.error.code ?? 401);
                    throw new Errors.Unauthenticated(
                      json.error.message || 'Unauthenticated',
                      json.error.status,
                      Number.isNaN(unauthenticatedCode) ? 401 : unauthenticatedCode,
                    );
                  }
                  if (json.error.status) {
                    const statusMessage = `${(data.url as URL).pathname} error is ${json.error.status}`;
                    if (typeof json.error.code === 'string') {
                      throw new Errors.UpstreamApiError(statusMessage, json.error.code, httpStatus, {
                        retryable: false,
                      });
                    }
                    if (typeof json.error.code === 'number') {
                      throw new Errors.CodedError(statusMessage, json.error.code);
                    }
                    throw new Error(statusMessage);
                  }
                }

                if (json.message && json.code !== undefined) {
                  if (typeof json.code === 'string') {
                    throw new Errors.UpstreamApiError(json.message, json.code, httpStatus, {
                      errors: json.errors,
                    });
                  }

                  throw new Errors.CodedError(json.message, json.code);
                }

                if (json.error && json.error.error_description) message = json.error.error_description;
                if (json.error && json.error.message) message = json.error.message;
                if (json.error && json.error.status) message = json.error.status;
                if (json.error_description) message = json.error_description;
                if (json.message) message = json.message;
                if (json.statusMessage) message = json.statusMessage;
              }

              Logging.logError(`${(data.url as URL).pathname} error is ${message}`);
              throw new Errors.CodedError(message, output.status ?? 520);
            } else {
              const responseStatus = response.status ? response.status : 520;
              Logging.logError(`${(data.url as URL).pathname} error is ${response.statusText}`);
              throw new Errors.CodedError(response.statusText, responseStatus);
            }
          }

          if (callback) {
            const text = response && response.text ? await response.text() : null;
            callback.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(text).copySync()).copyInto()]);
            return _resolve(output);
          } else {
            const contentType = response?.headers?.get ? response.headers.get('content-type') : null;
            const isJson = contentType ? contentType.includes('application/json') : false;
            let body: unknown = null;
            if (output.status === 200 || output.status === 201) {
              if (isJson && response.json) {
                body = await response.json();
              } else if (response.text) {
                body = await response.text();
              }
            }
            output.body = body;
            return _resolve(output);
          }
        } catch (err: unknown) {
          const error: Record<string, unknown> = {};
          if (err && typeof err === 'object') {
            const unknownErr = err as Record<string, unknown>;
            // Presence checks, not truthy checks - a falsy-but-valid value (retryable: false,
            // httpStatus: 0) must survive the isolate boundary just as much as a truthy one.
            if (unknownErr.message !== undefined) {
              error.message = unknownErr.message;
            }
            if (unknownErr.code !== undefined) {
              error.code = unknownErr.code;
            }
            if (unknownErr.status !== undefined) {
              error.status = unknownErr.status;
            }
            if (unknownErr.httpStatus !== undefined) {
              error.httpStatus = unknownErr.httpStatus;
            }
            if (unknownErr.retryable !== undefined) {
              error.retryable = unknownErr.retryable;
            }
            if (unknownErr.errors !== undefined) {
              error.errors = unknownErr.errors;
            }
          }
          const reference =
            Object.keys(error).length > 0 ? new ivm.Reference(error).copySync() : new ivm.Reference(err).copySync();
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(reference).copyInto()]);
        }

        function _resolve(output: unknown) {
          resolve.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoRandomBytes',
      forRun<number>('_cryptoRandomBytes', async (data, resolve, reject) => {
        try {
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(crypto.randomBytes(data).toString('hex')).copySync()).copyInto(),
          ]);
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    // Called from the isolate and answered at once, as the isolate's crypto.getRandomValues and randomUUID are
    // synchronous. The isolate has no source of randomness of its own.
    jail.setSync(
      '_cryptoRandomBytesSync',
      new ivm.Callback((size: number) => {
        if (!Number.isInteger(size) || size < 0 || size > 65536) throw new RangeError('invalid_random_size');
        return crypto.randomBytes(size).toString('hex');
      }),
    );
    jail.setSync(
      '_cryptoCreateHash',
      forRun<CreateHashRequest>('_cryptoCreateHash', async (data, resolve, reject) => {
        try {
          data.message = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
          const hash = crypto.createHash(data.algorithm);
          hash.update(JSON.stringify(data.message), 'utf8');
          const output = hash.digest('hex');
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
          ]);
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoCreateCipheriv',
      forRun<EncryptRequest>('_cryptoCreateCipheriv', async (data, resolve, reject) => {
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
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoCreateDecipheriv',
      forRun<DecryptRequest>('_cryptoCreateDecipheriv', async (data, resolve, reject) => {
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
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoEncryptWithKey',
      forRun<EncryptWithKeyRequest>('_cryptoEncryptWithKey', async (data, resolve, reject) => {
        try {
          const key = Buffer.from(data.key, 'hex'); // caller-supplied, hex-encoded
          const iv = crypto.randomBytes(12); // IV must still be fresh per call — reusing an IV with a fixed key breaks GCM
          const cipher = crypto.createCipheriv(data.algorithm, key, iv);
          const message = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
          let ciphertext = cipher.update(message, 'utf8', 'hex');
          ciphertext += cipher.final('hex');
          const authTag = cipher.getAuthTag();
          const output = { iv: iv.toString('hex'), authTag: authTag.toString('hex'), ciphertext };
          return resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto(),
          ]);
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_cryptoDecryptWithKey',
      forRun<DecryptRequest>('_cryptoDecryptWithKey', async (data, resolve, reject) => {
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
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_getCodeChallenge',
      forRun<unknown>('_getCodeChallenge', async (data, resolve, reject) => {
        try {
          const codeVerifier = randomstring.generate(128);
          const base64Digest = crypto.createHash('sha256').update(codeVerifier).digest('base64');
          const codeChallenge = base64Digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
          return _resolve({
            codeVerifier,
            codeChallenge,
          });
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }

        function _resolve(output: unknown) {
          resolve.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(output).copySync()).copyInto()]);
        }
      }),
    );
    jail.setSync(
      '_generatePDF',
      forRun<string>('_generatePDF', async (htmlString, resolve, reject) => {
        try {
          if (!htmlString) throw new Error(`Missing HTML string for pdf generation`);
          const browser = await puppeteer.launch({ headless: true });
          const page = await browser.newPage();

          // What the HTML loads goes only where a lambda's fetch() may, when the operator has set a list
          const allowedHosts = parseAllowedHosts(Config.lambda.allowedHosts);
          if (allowedHosts.length > 0) {
            await page.setRequestInterception(true);
            page.on('request', (request) => {
              const url = request.url();
              if (url.startsWith('data:') || url === 'about:blank') return void request.continue();
              checkDestination(url, allowedHosts).then(
                (problem) => void (problem ? request.abort() : request.continue()),
                () => void request.abort(),
              );
            });
          }

          // Set the HTML content and wait for initial document load.
          await page.setContent(htmlString, { waitUntil: 'load' });

          // ! These lines should have tests written against them.
          const pdfResult = await page.pdf({ format: 'A4', printBackground: true });
          await browser.close();
          resolve.applyIgnored(undefined, [
            new ivm.ExternalCopy(new ivm.Reference(Buffer.from(pdfResult).toString('base64')).copySync()).copyInto(),
          ]);
        } catch (err: unknown) {
          const reference = new ivm.Reference(err).copySync();
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(reference).copyInto()]);
        }
      }),
    );

    jail.setSync(
      '_sleep',
      forRun<number>('_sleep', async (ms, resolve, reject, run) => {
        try {
          // Cancelled if the run ends first
          await sleep(ms, undefined, { signal: run.signal });
          return resolve.applyIgnored(undefined);
        } catch (err: unknown) {
          reject.applyIgnored(undefined, [new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto()]);
        }
      }),
    );

    IsolateBridge.setupPlugins(jail, context);
    IsolateBridge.setupLambdaLogs(jail, context);
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
