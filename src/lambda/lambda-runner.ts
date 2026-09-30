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

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import type { IncomingHttpHeaders } from 'node:http';
import { execFile as cpExecFile } from 'node:child_process';

import NodeRedisPubsub from '../services/nrp.js';
import type { Services } from '../bootstrap.js';

const execFile = util.promisify(cpExecFile);

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

// A lambda that runs for longer than the runner's timeout
class LambdaTimeoutError extends Error {
  constructor() {
    super('lambda_execution_timed_out');
    this.name = 'LambdaTimeoutError';
  }
}

// A lambda that has been turned off, whose executions are skipped
class LambdaNotExecutableError extends Error {
  constructor() {
    super('lambda_is_not_executable');
    this.name = 'LambdaNotExecutableError';
  }
}

// A lambda that failed while running, whose execution has already been recorded as errored
class LambdaExecutionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LambdaExecutionFailedError';
  }
}

import ivm from 'isolated-vm';
import { v4 as uuidv4 } from 'uuid';
import webpack from 'webpack';

import NodePolyfillPlugin from 'node-polyfill-webpack-plugin';

import Sugar from '../helpers/sugar.js';
import Logging from '../helpers/logging.js';
import Model from '../model/index.js';
import * as Helpers from '../helpers/index.js';
import lambdaHelpers from '../lambda-helpers/helpers.js';
import type { LambdaResult } from '../lambda-helpers/helpers.js';
import IsolateBridge, { type IsolateJail } from '../lambda-helpers/isolate-bridge.js';
import { ExecPriority, LambdaExecutionMessage } from './lambda-manager.js';
import LambdaSchemaModel, { Lambda } from '../model/core/lambda.js';
import LambdaExecutionSchemaModel, { LambdaExecution, LambdaExecutionAddBody } from '../model/core/lambda-execution.js';
import AppSchemaModel, { App } from '../model/core/app.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';
import UserSchemaModel, { User } from '../model/core/user.js';
import DeploymentSchemaModel from '../model/core/deployment.js';
import SecureStoreSchemaModel from '../model/core/secure-store.js';
import { withoutCredentialHeaders } from '../helpers/redact.js';

export enum LambdaType {
  API_ENDPOINT = 'API_ENDPOINT',
  PATH_MUTATION = 'PATH_MUTATION',
  CRON = 'CRON',
  ALL = 'ALL',
}

// A module bundled into the isolate: an npm package, or (with an import path) the lambda's own code.
interface LambdaModule {
  packageName?: string;
  name: string;
  import?: string;
  // For a lambda's own code, the lambda's id
  lambdaId?: string;
  // Built and loaded again for every run, rather than once
  reload?: boolean;
}

export interface ExecutionResultMessage {
  code: number;
  res?: unknown;
  err?: unknown;
  errDetails?: Helpers.ThrownErrorDetails;
  reqId: string;
  executionId: string;
}

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

  private _shutdown = false;

  _timeout?: NodeJS.Timeout;
  _lambdaExecution: LambdaExecution | null;

  _isolate?: ivm.Isolate;
  _context?: ivm.Context;
  _jail?: IsolateJail;
  _registeredBundles: string[] = [];
  _compiledLambdas: unknown[] = [];

  // A context for each app whose lambdas have run, most recently used last, so one app's lambdas never share globals or
  // loaded modules with another's. _context, _jail and _registeredBundles are those of the app executing.
  _appContexts: Map<string, { context: ivm.Context; jail: IsolateJail; registeredBundles: string[] }> = new Map();
  // Bundle scripts compiled in the isolate, to run in each app's context
  _compiledBundles: Map<string, ivm.Script> = new Map();

  private __nrp?: NodeRedisPubsub;

  constructor(services: Services, type: LambdaType) {
    this.__nrp = services.get('nrp') as NodeRedisPubsub;

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
      TIMEOUT: timeout * 1000,
      // How many apps' contexts a runner keeps
      APP_CONTEXTS: 32,
    };
  }

  async init() {
    Logging.logDebug('LambdaRunner:init');

    this._createIsolate();
    this._subscribeToLambdaManager();
  }

  // A new isolate and context with the host functions lambdas use. Bundles are registered in it as they're needed.
  _createIsolate() {
    this._isolate = new ivm.Isolate({
      inspector: false,
      onCatastrophicError: () => {
        Logging.logError(
          'v8 has lost all control over the isolate, and all resources in use are totally unrecoverable',
        );
        process.abort();
      },
    });
    this._appContexts = new Map();
    this._compiledBundles = new Map();
    this._compiledLambdas = [];
    ({ context: this._context, jail: this._jail, registeredBundles: this._registeredBundles } = this._newContext());
  }

  // A context with the host functions lambdas use
  _newContext() {
    if (!this._isolate) throw new Error('Isolate not initialised');

    const context = this._isolate.createContextSync();
    const jail = context.global;
    lambdaHelpers._createIsolateContext(this._isolate, context, jail);
    return { context, jail, registeredBundles: [] as string[] };
  }

  /**
   * Makes the app's context the one lambdas run in, creating it the first time. The least recently used context is let
   * go once there are more than LambdaRunner.Constants.APP_CONTEXTS.
   * @param {string} appId
   */
  _useAppContext(appId: string) {
    let appContext = this._appContexts.get(appId);
    if (appContext) {
      this._appContexts.delete(appId);
    } else {
      appContext = this._newContext();
    }
    this._appContexts.set(appId, appContext);

    while (this._appContexts.size > LambdaRunner.Constants.APP_CONTEXTS) {
      const [oldestId, oldest] = this._appContexts.entries().next().value as [string, { context: ivm.Context }];
      this._appContexts.delete(oldestId);
      oldest.context.release();
    }

    ({ context: this._context, jail: this._jail, registeredBundles: this._registeredBundles } = appContext);
  }

  /**
   * Runs a lambda's script for at most Constants.TIMEOUT. isolated-vm's timeout only stops code that runs without
   * awaiting, so when the time is up the isolate is disposed, which stops whatever is still running in it, and the
   * runner starts a new one.
   * @param {ivm.Script} script
   * @return {Promise}
   */
  async _runLambdaScript(script: ivm.Script) {
    if (!this._context) throw new Error('Isolate Context not initialised');

    const timeout = LambdaRunner.Constants.TIMEOUT;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new LambdaTimeoutError()), timeout);
    });

    try {
      await Promise.race([script.run(this._context, { promise: true, timeout }), timedOut]);
    } catch (err: unknown) {
      const isolateTimedOut = err instanceof Error && err.message === 'Script execution timed out.';
      if (!(err instanceof LambdaTimeoutError) && !isolateTimedOut) throw err;

      Logging.logError(`[${this.name}] Lambda execution timed out after ${timeout}ms, starting a new isolate`);
      this._isolate?.dispose();
      this._createIsolate();
      throw new LambdaTimeoutError();
    } finally {
      clearTimeout(timer);
    }
  }

  async clean() {
    Logging.logDebug('LambdaRunner:clean');

    // Stop taking on lambdas, and let the running one finish
    this._shutdown = true;
    while (this.working) await new Promise((resolve) => setTimeout(resolve, 100));

    // Shutdown isolate
  }

  /**
   * gets static values specific to the application
   * @param {Object} app
   */
  async _getAppLambdaEnvironment(app: App): Promise<{ [key: string]: unknown } | null> {
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
  async execute(
    lambda: Lambda,
    execution: LambdaExecution,
    app: App,
    type: string,
    data: { body?: string; query?: string; headers?: string; reqId?: string },
  ) {
    if (!this._isolate) throw new Error('Isolate not initialised');
    if (!this._jail) throw new Error('Isolate Jail not initialised');
    if (!this._context) throw new Error('Isolate Context not initialised');

    if (!lambda.git || !lambda.git.url) {
      return Promise.reject(new Error(`Unable to find git repo for lambda ${lambda.name}`));
    }

    if (type === 'API_ENDPOINT' && !data.reqId) {
      return Promise.reject(
        new Error(`Missing reqId for API_ENDPOINT lambda ${lambda.name}, execution ${execution.id}`),
      );
    }

    // The app's own context, apart from other apps' lambdas
    this._useAppContext(String(app.id));
    IsolateBridge.startExecutionLogs();
    // Reset lambdaHelpers lambdaResult
    lambdaHelpers.lambdaResult = null;
    // Host functions act for this lambda: metadata updates go to it, email templates come from its code folder
    lambdaHelpers.lambdaId = lambda.id.toString();
    lambdaHelpers.lambdaGitHash = lambda.git.hash;

    const reqBody: unknown = data.body ? JSON.parse(data.body) : {};
    const reqQuery = (data.query ? JSON.parse(data.query) : {}) as Record<string, unknown>;
    // Without the caller's credentials, which executions stored before they were left out may still have
    const reqHeaders = withoutCredentialHeaders(
      (data.headers ? JSON.parse(data.headers) : {}) as IncomingHttpHeaders,
    ) as IncomingHttpHeaders;

    const appLambdaEnv = await this._getAppLambdaEnvironment(app);
    const rxsLambdaToken = await Model.getCoreModel(TokenSchemaModel).find({
      _appId: Model.getCoreModel(AppSchemaModel).createId(app.id),
      _lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
    });
    const lambdaToken = await Helpers.streamFirst<Token>(rxsLambdaToken);
    if (!lambdaToken) {
      return Promise.reject(
        new Error(`Unable to find lambda token for lambda ${lambda.name}, execution ${execution.id}`),
      );
    }

    let executionUserId: string | null = null;
    let userToken: string | undefined;
    let executionToken = lambdaToken;
    if (execution._tokenId) {
      const rxsExecToken = await Model.getCoreModel(TokenSchemaModel).find({
        _id: Model.getCoreModel(TokenSchemaModel).createId(execution._tokenId),
      });
      const execToken = await Helpers.streamFirst<Token>(rxsExecToken);
      if (!execToken) {
        return Promise.reject(
          new Error(`Unable to find lambda token for lambda ${lambda.name}, execution ${execution.id}`),
        );
      }
      executionToken = execToken;
      // Only an endpoint that uses the caller's token is given it
      const callerTrigger = this._executionTrigger(lambda, execution, type);
      if (type === 'API_ENDPOINT' && callerTrigger?.apiEndpoint?.useCallerToken) userToken = execToken.value;

      if (execToken.type === 'user') {
        const rxsUser = await Model.getCoreModel(UserSchemaModel).find({
          _id: Model.getCoreModel(UserSchemaModel).createId(execToken._userId),
        });
        const user = await Helpers.streamFirst<User>(rxsUser);
        if (!user) {
          return Promise.reject(new Error(`Unable to find user for token ${execToken.id}`));
        }
        executionUserId = user.id.toString();
      }
    }

    const apiPath = app.apiPath;
    // const appAllowList = app.allowList;
    const trigger = this._executionTrigger(lambda, execution, type);
    const buttressOptions = {
      buttressUrl: `${Config.app.protocol}://${Config.app.host}`,
      appToken: executionToken.value,
      apiPath: apiPath,
      allowUnauthorized: true,
    };
    const lambdaModules: Record<string, string> = {};

    // ? This doesn't seem right
    // lambdaHelpers.lambdaExecution = execution;
    await this._updateDBLambdaRunningExecution(execution);

    // TODO: Handle case where lambda code doesn't exist on file system. (Clone Repo)
    // TODO: Handle case where lambda code can't be cloned. (Inform Manager)

    // TODO: Handle case where repo code hash doesn't match lambda. (Update Repo)

    // const modulesNames = await this.installLambdaPackages(lambda, appAllowList); // not install packages on lambdas anymore
    // Inside the try so a lambda that fails to bundle or load is reported back to an API caller
    // waiting on its result, like one that throws while running.
    try {
      const modulesNames = this._getLambdaModulesName(lambda);
      await this.bundleLambdaModules(modulesNames);
      await this._registerLambdaModules(modulesNames);
      modulesNames.forEach((m: { name: string }) => {
        lambdaModules[m.name] = m.name;
      });
      const ownCode = modulesNames.find((m) => !m.packageName);

      this._jail.setSync('buttressOptions', new ivm.ExternalCopy(buttressOptions).copyInto());

      // * Would be better to just group these under one namespace "lambda". Unless we're going.
      this._jail.setSync('lambdaModules', new ivm.ExternalCopy(lambdaModules).copyInto());
      this._jail.setSync(
        'lambdaInfo',
        new ivm.ExternalCopy({
          env: appLambdaEnv ? appLambdaEnv.env : null,
          lambdaId: lambda.id.toString(),
          executionId: execution.id.toString(),
          gitHash: lambda.git.hash,
          metadata: lambda.metadata,
          lambdaToken: lambdaToken.value,
          userId: executionUserId,
          appApiPath: apiPath,
          fileName: ownCode?.name,
          entryPoint: lambda.git.entryPoint,
          developmentEmailAddress: Config.lambda.developmentEmailAddress,
          userToken: userToken,
        }).copyInto(),
      );
      this._jail.setSync('lambdaData', new ivm.ExternalCopy(reqBody).copyInto());
      this._jail.setSync('lambdaQuery', new ivm.ExternalCopy(reqQuery).copyInto());
      this._jail.setSync('lambdaRequestHeaders', new ivm.ExternalCopy(reqHeaders).copyInto());

      // Just exposing a few properties of exeuction
      this._jail.setSync(
        'lambdaExecution',
        new ivm.ExternalCopy({
          id: execution.id.toString(),
          lambdaId: execution.lambdaId.toString(),
          deploymentId: execution.deploymentId.toString(),
          triggerType: execution.triggerType,
          executeAfter: execution.executeAfter,
          nextCronExpression: execution.nextCronExpression,
          status: execution.status,
          startedAt: execution.startedAt,
          endedAt: execution.endedAt,
          metadata: execution.metadata,
        }).copyInto(),
      );

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
      await this._runLambdaScript(hostile);
      // Maybe dispose isolate after executin the lambda?

      await this._updateDBLambdaFinishExecution(execution);

      if (type === 'API_ENDPOINT') {
        const lambdaResult = lambdaHelpers.lambdaResult as LambdaResult | null;

        if (lambdaResult && lambdaResult.err) {
          throw Object.assign(new Error(lambdaResult.errMessage), {
            code: lambdaResult.code,
            httpStatus: lambdaResult.httpStatus,
            retryable: lambdaResult.retryable,
          });
        }

        if (!data.reqId) {
          throw new Error(`Missing reqId for API_ENDPOINT lambda ${lambda.name}, execution ${execution.id}`);
        }

        if (trigger && trigger.apiEndpoint.redirect && lambdaResult) lambdaResult.redirect = true;
        const result = lambdaResult ? lambdaResult : 'success';

        const message: ExecutionResultMessage = {
          code: 200,
          res: result,
          reqId: data.reqId,
          executionId: execution.id,
        };
        const json = JSON.stringify(message);
        this.__nrp?.emit('lambda:worker:execution-result', json);
        Logging.logSilly(
          `[${this.name}] Lambda ${lambda.name} execution ${execution.id} completed successfully: ${json}`,
        );
      }
    } catch (err: unknown) {
      Logging.logDebug(err);
      const failure = new LambdaExecutionFailedError(
        `Failed to execute script for lambda:${lambda.name} - ${Helpers.getThrownErrorMessage(err)}`,
      );
      // Before the API caller is answered, so the execution is errored by the time they look
      await this._recordExecutionError(execution, failure.message);

      if (type === 'API_ENDPOINT') {
        const errDetails = Helpers.getThrownErrorDetails(err);
        const errMessage = errDetails.message;

        if (data.reqId) {
          const message: ExecutionResultMessage = {
            code: errDetails.httpStatus ?? 400,
            err: errMessage,
            errDetails,
            reqId: data.reqId,
            executionId: execution.id,
          };
          const json = JSON.stringify(message);
          this.__nrp?.emit('lambda:worker:execution-result', json);
          Logging.logSilly(`[${this.name}] Lambda ${lambda.name} execution ${execution.id} errored: ${json}`);
        } else {
          throw new Error(
            `Missing reqId for API_ENDPOINT lambda ${lambda.name}, execution ${execution.id}, error: ${errMessage}`,
          );
        }
      }

      return Promise.reject(failure);
    }
  }

  /**
   * The trigger an execution is for. An API call names the endpoint it was made to, as a lambda can have several; an
   * execution queued before calls named it goes by the lambda's first.
   */
  _executionTrigger(lambda: Lambda, execution: LambdaExecution, type: string) {
    const endpoint = execution.metadata?.find((m) => m.key === 'API_ENDPOINT')?.value;
    if (type !== 'API_ENDPOINT' || !endpoint) return lambda.trigger.find((t) => t.type === type);

    const { url, method } = JSON.parse(endpoint) as { url: string; method: string };
    return lambda.trigger.find(
      (t) => t.type === type && t.apiEndpoint?.url === url && t.apiEndpoint?.method === method,
    );
  }

  /**
   * Fetch and run a lambda
   * @param {object} payload
   * @return {promise}
   */
  async handleLambdaExecutionMessage(payload: LambdaExecutionMessage) {
    const lambdaId = payload.lambdaId;
    // Resolved once we successfully look it up, so the catch block below can report
    // against it (and update its DB status) regardless of which step failed.
    let execution: LambdaExecution | null = null;
    let reqId: string | undefined;

    try {
      const lambda = (await Model.getCoreModel(LambdaSchemaModel).findById(lambdaId)) as Lambda | null;
      if (!lambda) throw new Error(`Unable to find lambda with id: ${lambdaId}`);

      const app = (await Model.getCoreModel(AppSchemaModel).findById(lambda._appId)) as App | null;
      if (!app) throw new Error(`Unable to find app for lambda: ${lambdaId}`);

      const triggerType = payload.lambdaType;

      const executionId = payload.executionId;
      if (!executionId) throw new Error('unable to fetch execute lambda, missing executionId');

      execution = (await Model.getCoreModel(LambdaExecutionSchemaModel).findOne({
        id: Model.getCoreModel(LambdaExecutionSchemaModel).createId(executionId),
        status: 'PENDING',
      })) as LambdaExecution | null;
      if (!execution) throw new Error('Unable to find pending execution, with id: ' + executionId);

      const body = execution.metadata.find((m) => m.key === 'BODY')?.value || undefined;
      const query = execution.metadata.find((m) => m.key === 'QUERY')?.value || undefined;
      const headers = execution.metadata.find((m) => m.key === 'HEADERS')?.value || undefined;
      reqId = execution.metadata.find((m) => m.key === 'REQ_ID')?.value || undefined;

      // A lambda that's been turned off doesn't run. Its cron keeps its schedule, so it runs again once turned back on.
      if (lambda.executable === false) {
        await this._queueNextCronExecution(execution);
        throw new LambdaNotExecutableError();
      }

      this._lambdaExecution = execution;
      await this.execute(lambda, execution, app, triggerType, {
        body,
        query,
        headers,
        reqId,
      });

      this.working = false;
      this.__nrp?.emit(
        'lambda:worker:finished',
        JSON.stringify({
          workerId: this.id,
          lambdaId: lambdaId,
          executionId: payload.executionId,
          reqId: reqId,
        }),
      );
    } catch (err: unknown) {
      this.working = false;
      const errMessage = Helpers.getThrownErrorMessage(err);
      Logging.logError(errMessage);

      if (execution && !(err instanceof LambdaExecutionFailedError)) {
        await this._recordExecutionError(execution, errMessage);

        // It failed before the lambda ran, so nothing has answered an API caller waiting on it yet
        if (payload.lambdaType === 'API_ENDPOINT' && reqId) {
          const notExecutable = err instanceof LambdaNotExecutableError;
          const message: ExecutionResultMessage = {
            code: notExecutable ? 400 : 500,
            err: notExecutable ? err.message : 'lambda_execution_failed',
            reqId,
            executionId: execution.id,
          };
          this.__nrp?.emit('lambda:worker:execution-result', JSON.stringify(message));
        }
      }

      this.__nrp?.emit(
        'lambda:worker:errored',
        JSON.stringify({
          workerId: payload.workerId,
          executionId: payload.executionId,
          reqId: reqId,
          lambdaId: lambdaId,
          lambdaType: payload.lambdaType,
          errMessage,
        }),
      );
    }
  }

  /**
   * Communicate with main process via Redis
   */
  _subscribeToLambdaManager() {
    Logging.logDebug(`Registering ${this.name} to listen for lambda execution messages`);
    this.__nrp?.on('lambda:worker:announce', (json: string) => {
      Logging.logDebug(`[${this.name}] Received lambda execution message: ${json}, working status: ${this.working}`);
      if (this.working || this._shutdown) return;

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

      if (this._shutdown) {
        Logging.logDebug(`[${this.name}] Shutting down, releasing ${message.executionId}`);
        this.__nrp?.emit('lambda:worker:overloaded', JSON.stringify(message));
        return;
      }

      if (this.working) {
        Logging.logWarn(`[${this.name}] I've taken on too much work, releasing ${message.executionId}`);

        message.currentExecutionId = this._lambdaExecution ? this._lambdaExecution.id : undefined;

        this.__nrp?.emit('lambda:worker:overloaded', JSON.stringify(message));
        return;
      }

      this.working = true;

      this.handleLambdaExecutionMessage(message);
    });
  }

  async _updateDBLambdaRunningExecution(execution: LambdaExecution) {
    await Model.getCoreModel(LambdaExecutionSchemaModel).updateById(
      Model.getCoreModel(LambdaExecutionSchemaModel).createId(execution.id),
      {
        $set: {
          status: 'RUNNING',
          startedAt: Sugar.Date.create('now'),
        },
      },
    );

    // if (type === 'CRON') {
    // 	await Model.getCoreModel(LambdaSchemaModel).update({
    // 		'id': Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
    // 		'trigger.type': type,
    // 	}, {$set: {'trigger.$.cron.status': 'RUNNING'}});
    // }
  }

  async _updateDBLambdaFinishExecution(execution: LambdaExecution) {
    execution = await Model.getCoreModel(LambdaExecutionSchemaModel).findById(execution.id);
    await Model.getCoreModel(LambdaExecutionSchemaModel).updateById(
      Model.getCoreModel(LambdaExecutionSchemaModel).createId(execution.id),
      {
        $set: {
          status: 'COMPLETE',
          endedAt: Sugar.Date.create('now'),
        },
        $push: {
          logs: { $each: IsolateBridge.takeExecutionLogs() },
        },
      },
    );

    await this._queueNextCronExecution(execution);
  }

  // Queues the next run of a cron lambda's execution
  async _queueNextCronExecution(execution: LambdaExecution) {
    const nextCronExpression = execution.nextCronExpression;
    if (!nextCronExpression) return;

    await Model.getCoreModel(LambdaExecutionSchemaModel).add(
      {
        triggerType: 'CRON',
        priority: ExecPriority.CRON,
        lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(execution.lambdaId),
        deploymentId: Model.getCoreModel(DeploymentSchemaModel).createId(execution.deploymentId),
        executeAfter: Sugar.Date.create(nextCronExpression),
        nextCronExpression,
        // Ignored: add() takes the token id in its internals, so the new execution doesn't keep it.
        _tokenId: execution._tokenId ? Model.getCoreModel(LambdaSchemaModel).createId(execution._tokenId) : null,
      } as LambdaExecutionAddBody,
      { _appId: execution._appId },
    );

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

  /**
   * Records the execution as errored, with why. A failure to record it is logged rather than thrown, so the manager and
   * any API caller waiting on the execution are still told.
   */
  async _recordExecutionError(execution: LambdaExecution, message: string) {
    try {
      await this._updateDBLambdaErrorExecution(execution, { message, type: 'ERROR' });
    } catch (err: unknown) {
      Logging.logError(
        `[${this.name}] Failed to record execution ${execution.id} as errored: ${Helpers.getThrownErrorMessage(err)}`,
      );
    }
  }

  async _updateDBLambdaErrorExecution(execution: LambdaExecution, log: { message: string; type: string }) {
    await Model.getCoreModel(LambdaExecutionSchemaModel).updateById(
      Model.getCoreModel(LambdaExecutionSchemaModel).createId(execution.id),
      {
        $set: {
          status: 'ERROR',
          endedAt: Sugar.Date.create('now'),
        },
        $push: {
          logs: { $each: [...IsolateBridge.takeExecutionLogs(), { log: log.message, type: log.type }] },
        },
      },
    );
  }

  async installLambdaPackages(lambda: Lambda, packageAllowList: { packageName: string; packageVersion: string }[]) {
    const packagePath = `${Config.paths.lambda.code}/lambda-${lambda.id}/package.json`;
    const modules: Array<{ name: string }> = [];
    if (!fs.existsSync(packagePath)) return modules;

    const packages = require(`${Config.paths.lambda.code}/lambda-${lambda.id}/package.json`) as {
      dependencies: Record<string, string>;
    };
    for await (const packageKey of Object.keys(packages.dependencies)) {
      try {
        await execFile('npm', ['ls', '--', packageKey]);
      } catch (err: unknown) {
        let packageVersion = packages.dependencies[packageKey];
        const matchedPattern = packageVersion.match(/(^\D)/);
        const [removedPattern] = matchedPattern ? matchedPattern : [];
        // undefined without a prefix, which replace() looks for as the string 'undefined'.
        packageVersion = packageVersion.replace(removedPattern as string, '');
        const packageIsInAllowList = packageAllowList.some((item) => {
          return item.packageName === packageKey && packageVersion === item.packageVersion;
        });

        if (err && typeof err === 'object' && 'code' in err && err.code === 1 && packageIsInAllowList) {
          try {
            Logging.log(`Installing ${packageKey}@${packageVersion} for lambda ${lambda.name}`);
            await execFile('npm', ['install', '--', `${packageKey}@${packageVersion}`]);
            modules.push({
              name: packageKey,
            });
          } catch (err: unknown) {
            Logging.logError(Helpers.getThrownErrorMessage(err));
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

  _getLambdaModulesName(lambda: Lambda) {
    const modules: LambdaModule[] = [];
    // Not checked before this, path.dirname() throws if the lambda has no entry file.
    const entryDir = path.dirname(lambda.git.entryFile as string);
    const entryFile = path.basename(lambda.git.entryFile as string);
    const lambdaDir = `${Config.paths.lambda.code}/lambda-${lambda.git.hash}/./${entryDir}`; // Again ugly /./ because... indolence
    // A pinned hash's code never changes, so it's built and loaded once, under a name of its own so a redeploy's code is
    // loaded in its place. HEAD moves with every pull, and dev reload picks up local edits, so either is built each run.
    const reload = Config.lambda.devReload === 'TRUE' || String(lambda.git.hash).toUpperCase() === 'HEAD';

    modules.push(
      {
        packageName: '@buttress/api',
        name: 'Buttress',
      },
      {
        packageName: '@buttress/snippets',
        name: 'LambdaSnippet',
      },
      {
        packageName: 'sugar',
        name: 'Sugar',
      },
      {
        name: `lambda_${lambda.id}_${lambda.git.hash}`,
        import: `${lambdaDir}/${entryFile}`,
        lambdaId: String(lambda.id),
        reload,
      },
    );

    return modules;
  }

  bundleLambdaModules(modules: LambdaModule[]) {
    const entry: webpack.EntryObject = {};
    modules.forEach((m) => {
      const moduleName = m.packageName ? m.packageName.replace('/', '_') : m.name;
      if (!m.reload && fs.existsSync(`${Config.paths.lambda.bundles}/${moduleName}.js`)) return;

      entry[moduleName] = {
        // Every module has an import path or a package name.
        import: m.import ? m.import : (m.packageName as string),
        library: {
          name: m.name,
          type: 'var',
        },
      };
    });

    if (Object.keys(entry).length < 1) return Promise.resolve();

    Logging.logDebug(`[${this.name}] Bundling lambda modules: ${Object.keys(entry).join(', ')}`);

    // Built in a folder of its own and moved into place, so another worker never loads a bundle still being written,
    // or one from a build that failed.
    const bundlesDir = path.resolve(Config.paths.lambda.bundles);
    fs.mkdirSync(bundlesDir, { recursive: true });
    const buildDir = fs.mkdtempSync(path.join(bundlesDir, '.build-'));

    return new Promise<void>((resolve, reject) => {
      webpack(
        {
          target: 'es2020',
          mode: 'development',
          entry: entry,
          resolve: {
            fallback: {
              crypto: require.resolve('crypto-browserify'),
            },
          },
          module: {
            rules: [
              {
                // Lambda code is checked out inside the Buttress install, so without this its .js files
                // take Buttress's own package.json "type": "module" and are parsed as ES modules, where
                // a CommonJS lambda's `module` and `require` don't exist. Tell ESM from CommonJS by syntax.
                test: /\.js$/,
                include: path.resolve(Config.paths.lambda.code),
                type: 'javascript/auto',
              },
            ],
          },
          plugins: [new NodePolyfillPlugin()],
          output: {
            path: buildDir,
            chunkFormat: 'commonjs',
          },
        },
        (err, stats) => {
          // The compiler itself failed, rather than a module in the build.
          if (err) {
            reject(err);
            return;
          }

          const info = stats?.toJson({ all: false, errors: true, warnings: true });
          // A warning, e.g. a require() of an expression webpack can't follow, still leaves a bundle
          // that works unless that code path runs.
          info?.warnings?.forEach((warning) => {
            Logging.logWarn(`[${this.name}] Warning whilst bundling lambda modules: ${warning.message}`);
          });

          if (stats?.hasErrors()) {
            // webpack still writes a bundle, which would fail later and less clearly when it's loaded.
            const messages = (info?.errors ?? []).map((error) => error.message);
            reject(new Error(`Unable to bundle lambda modules: ${messages.join('\n')}`));
            return;
          }

          try {
            fs.readdirSync(buildDir).forEach((file) =>
              fs.renameSync(path.join(buildDir, file), path.join(bundlesDir, file)),
            );
          } catch (renameErr: unknown) {
            reject(renameErr);
            return;
          }

          resolve();
        },
      );
    })
      .finally(() => {
        fs.rmSync(buildDir, { recursive: true, force: true });
      })
      .catch((error: unknown) => {
        Logging.logError(`[${this.name}] Error whilst bundling lambda modules`);
        Logging.logError(Helpers.getThrownErrorMessage(error));
        throw error;
      });
  }

  async _registerLambdaModules(lambdaModules: LambdaModule[]) {
    if (!this._isolate) throw new Error('Isolate not initialised');
    if (!this._context) throw new Error('Isolate not initialised');

    // In dev mode (LAMBDA_DEV_RELOAD=TRUE), always re-read and recompile a lambda's OWN code
    // module — not the shared @buttress/api / @buttress/snippets / sugar package bundles, which
    // are genuinely static and still worth caching for the isolate's lifetime — so local edits to
    // lambda source take effect on every call instead of only the first one per process lifetime.
    // Off by default: this costs an extra fs read + isolate script compile per invocation, which
    // is fine for a human/agent iterating locally but not something to pay on every request in a
    // real deployment, where lambda.git.hash is pinned to an immutable commit anyway.
    const devReload = Config.lambda.devReload === 'TRUE';

    for await (const mod of lambdaModules) {
      const isOwnCode = !mod.packageName;
      const reload = mod.reload || (devReload && isOwnCode);
      // Own code has no package name, includes(undefined) is false.
      const alreadyRegistered =
        this._registeredBundles.includes(mod.packageName as string) || this._registeredBundles.includes(mod.name);
      if (alreadyRegistered && !reload) continue;

      const registeredName = mod.packageName ? mod.packageName : mod.name;
      const file = mod.packageName ? mod.packageName.replace('/', '_') : mod.name;
      try {
        // A bundle is compiled once and run in each app's context, unless it's read again for every run
        let script = reload ? undefined : this._compiledBundles.get(file);
        if (!script) {
          script = this._isolate.compileScriptSync(
            fs.readFileSync(`${Config.paths.lambda.bundles}/${file}.js`, 'utf8'),
          );
          if (mod.lambdaId) this._releaseCompiledLambda(mod.lambdaId);
          this._compiledBundles.set(file, script);
        }
        script.runSync(this._context, { timeout: LambdaRunner.Constants.TIMEOUT });
      } catch (err: unknown) {
        Logging.logError(`Error registering lambda module ${mod.name}`);
        throw err;
      }
      // Only once it has run, so a bundle that threw is loaded again next time rather than skipped.
      if (!alreadyRegistered) this._registeredBundles.push(registeredName);
    }
  }

  // Lets go of the builds of a lambda's code at other hashes, which a redeploy has replaced
  _releaseCompiledLambda(lambdaId: string) {
    for (const [file, script] of this._compiledBundles) {
      if (!file.startsWith(`lambda_${lambdaId}_`)) continue;
      script.release();
      this._compiledBundles.delete(file);
    }
  }
}
