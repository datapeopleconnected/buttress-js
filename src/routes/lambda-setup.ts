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
import LambdaExecutionSchemaModel, { LambdaExecution } from '../model/core/lambda-execution.js';

export class RoutesLambdaSetup {
  app: express.Application;
  _nrp?: NRP;
  _preRouteMiddleware: express.RequestHandler[];

  constructor(app: express.Application, nrp: NRP | undefined, preRouteMiddleware: express.RequestHandler[]) {
    this.app = app;
    this._nrp = nrp;
    this._preRouteMiddleware = preRouteMiddleware;
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

  async __configureAppLambdaEndpoints(apiPath: string) {
    this.app.all(`/lambda/v1/${apiPath}/*endpoint`, this._preRouteMiddleware, async (req: Request, res: Response) => {
      const endpointParam = req.params.endpoint;
      const endpoint = Array.isArray(endpointParam) ? endpointParam.join('/') : endpointParam;

      if (req.method === 'POST' && (!req.body || Object.values(req.body).length < 1)) {
        res.status(400).send({ message: 'missing_request_body' });
        return;
      }

      if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).send({ message: 'method_not_allowed' });
        return;
      }

      const result = await this._queueLambdaAPIExecution(endpoint, apiPath, req);
      if (result.errCode && result.errMessage) {
        res.status(result.errCode).send({ message: result.errMessage });
        return;
      }

      const lambdaExecutionId = result.lambdaExecution?.id;
      if (!lambdaExecutionId) {
        res.status(500).send({ message: 'lambda_execution_id_missing' });
        return;
      }

      res.set('Cache-Control', 'no-store');

      let lambdaResult: ExecutionResultMessage | null = null;

      if (result.triggerAPIType === 'SYNC') {
        lambdaResult = await new Promise((resolve) => {
          this._nrp?.on('lambda:worker:execution-result', (json) => {
            const exec = JSON.parse(json) as ExecutionResultMessage;
            if (exec.reqId === req.context.id?.toString()) {
              resolve(exec);
            }
          });
        });
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
        let query: string = '';
        if (queryObj) {
          query = Object.keys(queryObj).reduce((output, key) => {
            if (!output) {
              output = `${key}=${queryObj[key]}`;
            } else {
              output = `${output}&${key}=${queryObj[key]}`;
            }
            return output;
          }, '');
        }
        const redirectURL = query ? `${url}?${query}` : url;
        res.redirect(redirectURL);
      } else if (lambdaResult) {
        res.status(lambdaResult.code).send({
          res: lambdaResult.res,
          err: lambdaResult.err,
          executionId: lambdaResult.executionId,
        });
      } else {
        res.status(200).send({
          executionId: lambdaExecutionId,
        });
      }
    });
  }

  async _queueLambdaAPIExecution(endpointOrId: string, apiPath: string, req: Request) {
    const res: {
      errCode?: number;
      errMessage?: string;
      triggerAPIType?: string;
      lambdaExecution?: LambdaExecution;
    } = {};
    let lambda: Lambda | null = null;

    const lambdaApp = await Model.getCoreModel(AppSchemaModel).findByApiPath(apiPath);
    if (!lambdaApp) {
      res.errCode = 404;
      res.errMessage = 'app_not_found';
      return res;
    }

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

    if (!lambda) {
      res.errCode = 404;
      res.errMessage = 'lambda_not_found';
      return res;
    }
    if (!lambda.executable) {
      res.errCode = 400;
      res.errMessage = 'lambda_is_not_executable';
      return res;
    }

    const triggerAPI = lambda.trigger.find((t) => t.type === 'API_ENDPOINT');
    if (!triggerAPI || triggerAPI.apiEndpoint.method !== req.method) {
      res.errCode = 404;
      res.errMessage = 'api_method_not_found';
      return res;
    }

    const deployment = await Model.getCoreModel(DeploymentSchemaModel).findOne({
      lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
      hash: lambda.git.hash,
    });
    if (!deployment) {
      res.errCode = 404;
      res.errMessage = 'deployment_not_found';
      return res;
    }

    const LambdaExecutionData = {
      triggerType: 'API_ENDPOINT',
      priority: triggerAPI.apiEndpoint.type === 'SYNC' ? ExecPriority.API_ENDPOINT_SYNC : ExecPriority.API_ENDPOINT,
      lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(lambda.id),
      deploymentId: Model.getCoreModel(DeploymentSchemaModel).createId(deployment.id),
      metadata: [{ key: 'REQ_ID', value: req.context.id }],
    };

    if (req.body) LambdaExecutionData.metadata.push({ key: 'BODY', value: JSON.stringify(req.body) });
    if (req.query) LambdaExecutionData.metadata.push({ key: 'QUERY', value: JSON.stringify(req.query) });
    if (req.headers) LambdaExecutionData.metadata.push({ key: 'HEADERS', value: JSON.stringify(req.headers) });

    const callerTokenId =
      triggerAPI.apiEndpoint.useCallerToken && req.context.token
        ? Model.getCoreModel(TokenSchemaModel).createId(req.context.token.id)
        : null;

    const lambdaExecution = (await Model.getCoreModel(LambdaExecutionSchemaModel).add(
      LambdaExecutionData,
      lambda._appId,
      callerTokenId,
    )) as LambdaExecution;

    res.lambdaExecution = lambdaExecution;
    res.triggerAPIType = triggerAPI.apiEndpoint.type;

    const data: LambdaExecutionMessage = {
      executionId: lambdaExecution.id,
      lambdaId: lambda.id,
      lambdaType: 'API_ENDPOINT',
      triggerType: triggerAPI.type,
      lambdaExecBehavior: triggerAPI.apiEndpoint.type,
    };

    if (!res.errCode && !res.errMessage) {
      this._nrp?.emit('rest:worker:exec-lambda-api', JSON.stringify(data));
    }

    return res;
  }
}

export default RoutesLambdaSetup;
