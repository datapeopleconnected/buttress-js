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

import express, { Request, Response } from 'express';

import * as Helpers from '../helpers/index.js';
import Model from '../model/index.js';

import NRP from '../services/nrp.js';
import { ExecutionResultMessage } from '../lambda/lambda-runner.js';
import { ExecPriority, LambdaExecutionMessage } from '../lambda/lambda-manager.js';

import AppSchemaModel from '../model/core/app.js';
import LambdaSchemaModel, { Lambda } from '../model/core/lambda.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';
import DeploymentSchemaModel from '../model/core/deployment.js';
import LambdaExecutionSchemaModel, { LambdaExecution, LambdaExecutionAddBody } from '../model/core/lambda-execution.js';
import type { RequestWithBody } from '../types/routes.js';
import { withoutCredentialHeaders } from '../helpers/redact.js';

const SYNC_LAMBDA_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class RoutesLambdaSetup {
  app: express.Application;
  _nrp?: NRP;
  _preRouteMiddleware: express.RequestHandler[];
  // Answers an error from an endpoint's middleware. Lambda endpoints are added after the app's own error handler, so
  // they need one of their own.
  _errorHandler?: express.ErrorRequestHandler;
  // The api paths whose lambda endpoints are registered, so each is registered once
  _configuredApiPaths = new Set<string>();
  // Lambda results this process is waiting on, by request id, and the one subscription that hands them over
  _pendingResults = new Map<string, (result: ExecutionResultMessage) => void>();
  _resultsSubscription?: Promise<unknown>;

  constructor(
    app: express.Application,
    nrp: NRP | undefined,
    preRouteMiddleware: express.RequestHandler[],
    errorHandler?: express.ErrorRequestHandler,
  ) {
    this.app = app;
    this._nrp = nrp;
    this._preRouteMiddleware = preRouteMiddleware;
    this._errorHandler = errorHandler;
  }

  async _setupLambdaEndpoints() {
    const appsToken = await Helpers.streamAll<Token>(
      await Model.getCoreModel(TokenSchemaModel).find({
        $or: [
          {
            type: Model.getCoreModel(TokenSchemaModel).Constants.Type.APP,
          },
          {
            type: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
          },
        ],
      }),
    );
    const tokenIds = appsToken.map((t) => t.id);
    const apps = await Helpers.streamAll<{ apiPath: string }>(
      await Model.getCoreModel(AppSchemaModel).find({
        _tokenId: {
          $in: tokenIds,
        },
      }),
    );
    const appApiPaths = apps.map((app) => app.apiPath);

    appApiPaths.forEach((apiPath) => {
      this.__configureAppLambdaEndpoints(apiPath);
    });

    this._nrp?.on('app:configure-lambda-endpoints', (apiPath: string) => {
      this.__configureAppLambdaEndpoints(apiPath);
    });
  }

  /**
   * Subscribes to lambda results once, handing each to the request waiting on it.
   */
  _listenForResults() {
    this._resultsSubscription ??= Promise.resolve(
      this._nrp?.on('lambda:worker:execution-result', (json: string) => {
        const result = JSON.parse(json) as ExecutionResultMessage;
        this._pendingResults.get(result.reqId)?.(result);
      }),
    );
    return this._resultsSubscription;
  }

  async __configureAppLambdaEndpoints(apiPath: string) {
    if (this._configuredApiPaths.has(apiPath)) return;
    this._configuredApiPaths.add(apiPath);

    this.app.all(`/lambda/v1/${apiPath}/*endpoint`, this._preRouteMiddleware, async (req: Request, res: Response) => {
      // A token in a URL ends up in access logs and browser history
      if (req.query?.token !== undefined) {
        throw Helpers.Errors.badRequest('token_in_url_not_supported', 'A token in the URL is not supported');
      }

      const endpointParam = req.params.endpoint;
      const endpoint = Array.isArray(endpointParam) ? endpointParam.join('/') : endpointParam;

      if (req.method === 'POST' && (!req.body || Object.values(req.body as object).length < 1)) {
        throw Helpers.Errors.badRequest('missing_request_body', 'A POST to a lambda endpoint needs a body');
      }

      if (req.method !== 'POST' && req.method !== 'GET') {
        throw Helpers.Errors.methodNotAllowed('method_not_allowed', 'A lambda endpoint takes GET or POST');
      }

      // Waiting before the call is queued, as its result can come back before queueing it has finished
      await this._listenForResults();
      const reqId = String(req.context.id);
      let settle: (result: ExecutionResultMessage | null) => void = () => {};
      const resultArrives = new Promise<ExecutionResultMessage | null>((resolve) => (settle = resolve));
      this._pendingResults.set(reqId, settle);

      let lambdaResult: ExecutionResultMessage | null = null;
      let lambdaExecutionId: string | undefined;
      try {
        const result = await this._queueLambdaAPIExecution(endpoint, apiPath, req);
        lambdaExecutionId = result.lambdaExecution.id;

        res.set('Cache-Control', 'no-store');

        if (result.triggerAPIType === 'SYNC') {
          // If the result never arrives (e.g. the lambda worker crashed), the caller gets the executionId, as for an
          // ASYNC call, to look the outcome up themselves
          const timer = setTimeout(() => settle(null), SYNC_LAMBDA_TIMEOUT_MS);
          lambdaResult = await resultArrives;
          clearTimeout(timer);
        }
      } finally {
        this._pendingResults.delete(reqId);
      }

      const lambdaResultPayload =
        lambdaResult && typeof lambdaResult.res === 'object' && lambdaResult.res !== null
          ? (lambdaResult.res as Record<string, unknown>)
          : null;

      if (lambdaResultPayload && lambdaResultPayload.redirect) {
        const url = typeof lambdaResultPayload.url === 'string' ? lambdaResultPayload.url : '';
        const queryObj =
          typeof lambdaResultPayload.query === 'object' && lambdaResultPayload.query !== null
            ? (lambdaResultPayload.query as Record<string, unknown>)
            : null;
        const query = Object.entries(queryObj ?? {})
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
          .join('&');
        const redirectURL = query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
        res.redirect(redirectURL);
      } else if (lambdaResult) {
        res.status(lambdaResult.code).send({
          res: lambdaResult.res,
          err: lambdaResult.err,
          errDetails: lambdaResult.errDetails,
          executionId: lambdaResult.executionId,
        });
      } else {
        res.status(200).send({
          executionId: lambdaExecutionId,
        });
      }
    });
    // Express passes an error only to error handlers added with use(), not to route handlers
    if (this._errorHandler) this.app.use(`/lambda/v1/${apiPath}`, this._errorHandler);
  }

  async _queueLambdaAPIExecution(endpointOrId: string, apiPath: string, req: RequestWithBody<unknown>) {
    let lambda: Lambda | null = null;

    const lambdaApp = await Model.getCoreModel(AppSchemaModel).findByApiPath(apiPath);
    if (!lambdaApp) throw Helpers.Errors.notFound('not_found', 'No app has that api path', { schema: 'app', apiPath });

    lambda = await Model.getCoreModel(LambdaSchemaModel).findOne({
      $or: [
        {
          id: {
            $eq: endpointOrId,
          },
        },
        {
          'trigger.apiEndpoint.url': {
            $eq: endpointOrId,
          },
        },
      ],
      _appId: {
        $eq: lambdaApp.id,
      },
    });

    if (!lambda) throw Helpers.Errors.notFound('lambda_not_found', 'No lambda has that endpoint');
    if (!lambda.executable) {
      throw Helpers.Errors.badRequest('lambda_is_not_executable', 'The lambda is turned off');
    }

    // The trigger the request is for: the one at its url, or any, for a request that names the lambda by id; and with
    // its method, as a url can have one trigger for each
    const apiTriggers = lambda.trigger.filter((t) => t.type === 'API_ENDPOINT');
    const atUrl = apiTriggers.filter((t) => t.apiEndpoint.url === endpointOrId);
    const triggerAPI = (atUrl.length > 0 ? atUrl : apiTriggers).find((t) => t.apiEndpoint.method === req.method);
    if (!triggerAPI) {
      throw Helpers.Errors.notFound('api_method_not_found', `The endpoint has no ${req.method} trigger`);
    }

    const deployment = await Model.getCoreModel(DeploymentSchemaModel).findOne({
      lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
      hash: lambda.git.hash,
    });
    if (!deployment) throw Helpers.Errors.notFound('deployment_not_found', "The lambda's deployment was not found");

    const LambdaExecutionData = {
      triggerType: 'API_ENDPOINT',
      priority: triggerAPI.apiEndpoint.type === 'SYNC' ? ExecPriority.API_ENDPOINT_SYNC : ExecPriority.API_ENDPOINT,
      lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
      deploymentId: Model.getCoreModel(DeploymentSchemaModel).createId(deployment.id),
      metadata: [
        { key: 'REQ_ID', value: req.context.id },
        // So the runner applies this trigger's settings
        {
          key: 'API_ENDPOINT',
          value: JSON.stringify({ url: triggerAPI.apiEndpoint.url, method: triggerAPI.apiEndpoint.method }),
        },
      ],
    } satisfies LambdaExecutionAddBody;

    if (req.body) LambdaExecutionData.metadata.push({ key: 'BODY', value: JSON.stringify(req.body) });
    if (req.query) LambdaExecutionData.metadata.push({ key: 'QUERY', value: JSON.stringify(req.query) });
    // Kept for the lambda, which is tenant code, so without the caller's credentials
    if (req.headers) {
      const headers = withoutCredentialHeaders(req.headers);
      LambdaExecutionData.metadata.push({ key: 'HEADERS', value: JSON.stringify(headers) });
    }

    // An endpoint that uses the caller's token runs as the caller only for a token of the lambda's own app
    const callerToken = req.context.token;
    const callerTokenId =
      triggerAPI.apiEndpoint.useCallerToken && callerToken && String(callerToken._appId) === String(lambda._appId)
        ? Model.getCoreModel(TokenSchemaModel).createId(callerToken.id)
        : null;

    const lambdaExecution = (await Model.getCoreModel(LambdaExecutionSchemaModel).add(LambdaExecutionData, {
      _appId: lambda._appId,
      _tokenId: callerTokenId,
    })) as LambdaExecution;

    const data: LambdaExecutionMessage = {
      executionId: lambdaExecution.id,
      lambdaId: lambda.id,
      lambdaType: 'API_ENDPOINT',
      triggerType: triggerAPI.type,
      lambdaExecBehavior: triggerAPI.apiEndpoint.type,
    };

    this._nrp?.emit('rest:worker:exec-lambda-api', JSON.stringify(data));

    return { lambdaExecution, triggerAPIType: triggerAPI.apiEndpoint.type };
  }
}

export default RoutesLambdaSetup;
