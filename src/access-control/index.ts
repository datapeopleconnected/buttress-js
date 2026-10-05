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

import { Request, Response, NextFunction } from 'express';

import NodeRedisPubsub, { AppSchemaUpdatedMessage } from '../services/nrp.js';

import Sugar from '../helpers/sugar.js';
import { ApiError, ApiErrorDetails } from '../helpers/errors.js';
import Model from '../model/index.js';
import Logging from '../helpers/logging.js';
import * as Schema from '../helpers/schema.js';

import PolicySchemaModel, { Policy, PolicyConfig, PolicyEnv } from '../model/core/policy.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';

import AccessControlEnv from './env.js';
import { evaluate, mergeGrants } from './evaluator.js';
import AccessControlProjection from './projection.js';
import AccessControlPolicyMatch from './policy-match.js';
import AccessControlHelpers, { isPolicyExpired, policyLimit } from './helpers.js';
import { PolicyCache } from '../services/policy-cache.js';
import LambdaSchemaModel, { Lambda } from '../model/core/lambda.js';
import AppSchemaModel from '../model/core/app.js';

import { Schema as SchemaDefinition } from '../types/schema.js';

// A request the token's policies don't allow. `logTimerMsg` names the check that refused it, for the request's timer.
export class PolicyError extends ApiError {
  logTimerMsg?: string;

  constructor(status: number, code: string, message: string, logTimerMsg?: string, details?: ApiErrorDetails) {
    super(status, code, message, details);
    this.name = 'PolicyError';
    this.logTimerMsg = logTimerMsg;
  }
}

export type parsedPolicyConfig = PolicyConfig & { appId: string; policies: string[] };

export type ApplicablePolicyConfig = {
  id: string;
  name: string;
  appId: string;
  env: PolicyEnv | null;
  config: PolicyConfig;
};

class AccessControl {
  _schemas: { [key: string]: SchemaDefinition[] };
  // _policies: {[key: string]: any};

  _queuedLimitedPolicy: string[];

  _oneWeekMilliseconds: number;

  _coreSchema: SchemaDefinition[];
  _coreSchemaNames: string[];

  _policyCache?: PolicyCache;

  _nrp?: NodeRedisPubsub;

  constructor() {
    this._schemas = {};
    // this._policies = {};
    this._queuedLimitedPolicy = [];

    this._oneWeekMilliseconds = Sugar.Number.day(7);

    this._coreSchema = [];
    this._coreSchemaNames = [];
  }

  async init(nrp: NodeRedisPubsub, policyCache: PolicyCache) {
    if (!nrp) throw new Error('Unable to init access control, NRP not set');

    this._nrp = nrp;
    this._policyCache = policyCache;

    this.handleCacheListeners();
  }

  handleCacheListeners() {
    if (!this._nrp) throw new Error('Unable to register listeners, NRP not set');

    this._nrp.on('app-schema:updated', async (json) => {
      const data = JSON.parse(json) as AppSchemaUpdatedMessage;
      await this.__cacheAppSchema(data.appId);
    });
  }

  /**
   * Check access control policy before granting access to the data
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   * @param {Function} next - next handler function
   * @return {Void}
   * @private
   */
  async accessControlPolicyMiddleware(req: Request, res: Response, next: NextFunction) {
    req.context.timings.accessControl = req.context.timer.interval;
    Logging.logTimer(
      `accessControlPolicyMiddleware::start`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    // Define a property on the request that we'll use for the access control
    req.context.ac = {
      policyConfigs: [],
    };

    const isSystemToken = req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM;
    if (isSystemToken) return next();

    const token = req.context.token;
    if (!token) {
      throw new Error(`Can not find a token for the requester`);
    }

    // Skip if we're hitting a plugin
    if (req.context.isPluginPath) return next();

    const user = req.context.authUser;
    const appId = token._appId.toString();
    const requestVerb = req.method;
    let lambdaAPICall: Lambda | null = null;
    let requestedURL = req.originalUrl || req.url;
    requestedURL = requestedURL.split('?').shift() || '';
    const isLambdaCall = requestedURL.indexOf('/lambda/v1') === 0;

    if (requestedURL === '/api/v1/app/schema' && requestVerb === 'GET') return next();

    if (isLambdaCall) {
      if (!req.context.authApp) {
        throw new Error(`Unable to determine app for lambda API call to ${requestedURL}`);
      }

      const lambdaURL = requestedURL.replace(`/lambda/v1/${req.context.authApp.apiPath}/`, '');
      lambdaAPICall = await Model.getCoreModel(LambdaSchemaModel).findOne({
        'trigger.apiEndpoint.url': {
          $eq: lambdaURL,
        },
        _appId: {
          $eq: Model.getCoreModel(LambdaSchemaModel).createId(appId),
        },
      });
    }
    if (lambdaAPICall) return next();

    const schemaPath = (requestedURL.split('v1/').pop() || '').split('/');
    const schemaName = Schema.routeToModel(schemaPath.shift() || '');
    if (!schemaName) {
      throw new Error(`Unable to determine schema for request to ${requestedURL}`);
    }

    if (this._coreSchema.length < 1) {
      this._coreSchema = await AccessControlHelpers.cacheCoreSchema();
      this._coreSchemaNames = this._coreSchema.map((c) => Sugar.String.singularize(c.name));
    }

    // if (user && this._coreSchemaNames.some((n) => n === schemaName)) {
    // 	const userAppToken = await Model.getCoreModel(TokenSchemaModel).findOne({
    // 		_appId: {
    // 			$eq: user._appId,
    // 		},
    // 		type: {
    // 			$eq: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
    // 		},
    // 	});
    // 	if (!userAppToken) {
    // 		return res.status(401).send({message: `Non admin app user can not do any core schema requests`});
    // 	}
    // }

    // A policy whose limit has run out grants nothing, whether or not it has been removed yet
    let tokenPolicies: Policy[] = [];
    try {
      if (!this._schemas[appId]) await this.__cacheAppSchema(appId);

      tokenPolicies = (await this.__getTokenPolicies(token)).filter((policy) => !isPolicyExpired(policy));
      Logging.logSilly(
        `Got ${tokenPolicies.length} matching policies for token ${token.type}:${token.id}`,
        req.context.id,
      );

      req.context.ac.policyConfigs = await this.__getOutcome(tokenPolicies, req, schemaName, appId);
    } catch (err: unknown) {
      // The error handler answers it
      if (err instanceof PolicyError) {
        Logging.logTimer(err.logTimerMsg, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
        Logging.logError(err.message);
      }
      return next(err);
    }

    if (user) {
      // const params = {
      // 	policies: req.context.ac.policyConfigs,
      // 	appId: appId,
      // 	apiPath: req.context.authApp.apiPath,
      // 	userId: user.id,
      // 	schemaNames: [...this._coreSchema, ...this._schemas[appId]].map((s) => s.name),
      // 	schemaName: schemaName,
      // 	path: requestedURL,
      // };
      await this._queuePolicyLimitDeleteEvent(tokenPolicies, token, appId);
      // TODO: This doesn't need to happen here, move to sock
      // await this._checkAccessControlDBBasedQueryCondition(req, params);
      // this._nrp?.emit('queuePolicyRoomCloseSocketEvent', JSON.stringify(params));
    }

    // TODO: This doesn't need to happen here, move to sock
    // await this._checkAccessControlDBBasedQueryCondition(req, params);

    Logging.logTimer(
      `accessControlPolicyMiddleware::end`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );
    next();
  }

  /**
   * The policy configs a request goes through, as the routes apply them (REST's side of the evaluator): the grants the
   * token's policies give on the schema for the request's verb, less those the request reads by or writes properties
   * of that they don't let through, merged.
   */
  async __getOutcome(
    tokenPolicies: Policy[],
    req: Request,
    schemaName: string,
    appId: string | null = null,
  ): Promise<parsedPolicyConfig[]> {
    Logging.logTimer(
      `__getOutcome::start - policies:${tokenPolicies.length}`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    appId = !appId && req.context.authApp && req.context.authApp.id ? req.context.authApp.id : appId;
    if (!appId) throw new Error('Trying to combine core with app schema but appId is not defined');

    const schemaCombined = [...this._coreSchema, ...(this._schemas[appId] ?? [])];
    const schema = schemaCombined.find((s) => s.name === schemaName || Sugar.String.singularize(s.name) === schemaName);

    const grants = await evaluate(tokenPolicies, {
      schemaName,
      schema: schema ?? null,
      isCoreSchema: this._coreSchemaNames.some((n) => n === schemaName),
      verb: req.method,
      appId,
      env: AccessControlEnv.generateRequestGlobalEnvs(req, appId, req.context.authUser),
    });

    // evaluate refuses a schema the app hasn't got
    const permitted = await AccessControlProjection.filterGrantsByRequest(req, grants, schema!);
    if (permitted.length < 1) {
      throw new PolicyError(
        403,
        'property_access_denied',
        `Can not access/edit properties of ${schemaName} without privileged access`,
        '_accessControlPolicy:access-control-properties-permission-error',
      );
    }

    const outcome: parsedPolicyConfig[] = mergeGrants(permitted).map((grant) => ({
      ...grant.config,
      query: grant.query,
      projection: grant.projection ? Object.fromEntries(grant.projection.map((key) => [key, 1])) : null,
      appId: grant.appId,
      policies: grant.policies,
    }));

    Logging.logTimer(
      `__getOutcome::end Policy Configs: ${outcome.length}`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    return outcome;
  }

  async __cacheAppSchema(appId: string) {
    const app = await Model.getCoreModel(AppSchemaModel).findById(appId);
    // A token outliving its app
    if (!app) {
      throw new PolicyError(
        401,
        'app_not_found',
        "The token's app was not found",
        `__cacheAppSchema::app ${appId} not found`,
      );
    }
    this._schemas[appId] = Schema.decode(app.__schema).filter((s) => s.type.indexOf('collection') === 0);

    Logging.logSilly(`Refreshed schema cache for app ${appId} got ${this._schemas[appId].length} schema`);
  }

  // async __cacheAppPolicies(appId) {
  // 	const policies: any[] = [];
  // 	const rxsPolicies = await Model.getCoreModel(PolicySchemaModel).find({
  // 		_appId: Model.getCoreModel(PolicySchemaModel).createId(appId),
  // 	});
  // 	for await (const policy of rxsPolicies) {
  // 		policies.push(policy);
  // 	}

  // 	Logging.logSilly(`Refreshed policies for app ${appId} got ${policies.length} policies`);

  // 	this._policies[appId] = policies;
  // }

  async __getTokenPolicies(token: Token) {
    if (!this._policyCache) throw new Error('Unable to get token policies, policy cache not set');
    return this._policyCache.getPoliciesByToken(token);
    // return AccessControlPolicyMatch.getTokenPolicies(this._policies[appId], token);
  }

  async _checkAccessControlDBBasedQueryCondition(req: Request) {
    const requestMethod = req.method;
    if (requestMethod !== 'PUT') return;

    // const id = params.path.split('/').pop();
    // this._nrp?.emit('accessControlPolicy:disconnectQueryBasedSocket', JSON.stringify({
    // 	appId: params.appId,
    // 	apiPath: params.apiPath,
    // 	userId: params.userId,
    // 	id: id,
    // 	updatedSchema: params.schemaName,
    // }));
  }

  _queuePolicyLimitDeleteEvent(policies: Policy[], userToken: Token, appId: string) {
    policies.forEach((p) => {
      const limit = policyLimit(p);
      if (!limit) return;

      const nearlyExpired = limit.getTime() - Date.now();
      if (this._oneWeekMilliseconds < nearlyExpired) return;
      const policyId = String(p.id);
      if (this._queuedLimitedPolicy.includes(policyId)) return;

      this._queuedLimitedPolicy.push(policyId);
      setTimeout(
        async () => {
          await this.__removeUserPropertiesPolicySelection(userToken, p);
          await Model.getCoreModel(PolicySchemaModel).rm(p.id);

          this._nrp?.emit(
            'app-policy:bust-cache',
            JSON.stringify({
              appId,
            }),
          );

          // this._nrp?.emit('worker:socket:updateUserSocketRooms', JSON.stringify({
          // 	userId: Model.getCoreModel(UserSchemaModel).create(userToken._userId),
          // 	appId,
          // }));

          this._queuedLimitedPolicy = this._queuedLimitedPolicy.filter((id) => id !== policyId);
        },
        Math.max(0, nearlyExpired),
        // A removal still to come doesn't keep the process running; the policy grants nothing past its limit anyway
      ).unref();
    });
  }

  async __removeUserPropertiesPolicySelection(userToken: Token, policy: Policy) {
    // The token as it's stored now, not as it was when the removal was queued, up to a week before
    const stored = (await Model.getCoreModel(TokenSchemaModel).findOne({
      _id: Model.getCoreModel(TokenSchemaModel).createId(String(userToken.id)),
    })) as Token | null;
    if (!stored) return;

    // The policy matched on its selection and the token's policy properties, see AccessControlPolicyMatch
    const policySelectionKeys = AccessControlPolicyMatch.selectionKeys(policy.selection ?? {});
    const tokenPolicyProps = { ...(stored.policyProperties ?? {}) };
    policySelectionKeys.forEach((key) => {
      delete tokenPolicyProps[key];
    });

    await Model.getCoreModel(TokenSchemaModel).setPolicyPropertiesById(userToken.id.toString(), tokenPolicyProps);
  }

  __getInnerObjectValue(originalObj: Record<string, unknown> | null) {
    if (!originalObj) return null;

    const { _schema, ...rest } = originalObj;
    return rest;
  }
}
export default new AccessControl();
