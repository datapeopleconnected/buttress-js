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
import { getThrownErrorMessage } from '../helpers/index.js';
import { ApiError, ApiErrorDetails } from '../helpers/errors.js';
import Model from '../model/index.js';
import type StandardModel from '../model/type/standard.js';
import Logging from '../helpers/logging.js';
import * as Schema from '../helpers/schema.js';

import { Policy, PolicyConfig, PolicyEnv } from '../model/core/policy.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';

import AccessControlEnv from './env.js';
import { evaluate, Grant, mergeGrants } from './evaluator.js';
import AccessControlProjection from './projection.js';
import AccessControlHelpers, { isPolicyExpired } from './helpers.js';
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

  _coreSchema: SchemaDefinition[];
  _coreSchemaNames: string[];

  _policyCache?: PolicyCache;

  _nrp?: NodeRedisPubsub;

  constructor() {
    this._schemas = {};
    // this._policies = {};

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

    // A policy whose limit has run out grants nothing, whether or not the SPR primary has removed it yet (PolicyExpiry)
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
   * The grants whose queries the app's schema can read, as the routes read them. One that can't be, such as a policy
   * saved before its query's operands were checked, is left out and logged, rather than failing the request; it's
   * left out before grants are merged, so it doesn't take another policy's query with it.
   * @param {Grant[]} grants
   * @param {string} appId
   * @param {string} schemaName
   * @return {Promise<Grant[]>}
   */
  async __readableGrants(grants: Grant[], appId: string, schemaName: string): Promise<Grant[]> {
    const model = await Model.getAppModel<StandardModel>(appId, schemaName);
    if (!model) return grants;

    return grants.filter((grant) => {
      try {
        model.parseQuery(grant.query as Record<string, unknown>, {}, model.flatSchemaData, false);
        return true;
      } catch (err: unknown) {
        Logging.logWarn(
          `Policy ${grant.policies.join(', ')} not applied to ${schemaName}: ${getThrownErrorMessage(err)}`,
        );
        return false;
      }
    });
  }

  /**
   * The policy configs a request goes through, as the routes apply them (REST's side of the evaluator): the grants the
   * token's policies give on the schema for the request's verb whose queries the schema can read, less those the
   * request reads by or writes properties of that they don't let through, merged.
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

    const isCoreSchema = this._coreSchemaNames.some((n) => n === schemaName);
    const grants = await evaluate(tokenPolicies, {
      schemaName,
      schema: schema ?? null,
      isCoreSchema,
      verb: req.method,
      appId,
      env: AccessControlEnv.generateRequestGlobalEnvs(req, appId, req.context.authUser),
    });

    // evaluate refuses a schema the app hasn't got, so the schema is there from here on. A grant whose query can't be
    // read for it grants nothing, as in realtime, and the token's others still apply; a core schema's rows aren't read
    // through policies' queries (D-21)
    const readable = isCoreSchema ? grants : await this.__readableGrants(grants, appId, schema!.name);
    if (readable.length < 1) {
      throw new PolicyError(
        403,
        'access_denied',
        `Access control policy query can not be applied to ${schemaName}`,
        '_accessControlPolicy:query-not-resolved',
      );
    }

    const permitted = await AccessControlProjection.filterGrantsByRequest(req, readable, schema!);
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
    // An app whose stored schema can't be read has none of its own here, rather than failing every request it makes
    const schemas = Schema.decodeStored(app) ?? [];
    this._schemas[appId] = schemas.filter((s) => s.type.indexOf('collection') === 0);

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

  __getInnerObjectValue(originalObj: Record<string, unknown> | null) {
    if (!originalObj) return null;

    const { _schema, ...rest } = originalObj;
    return rest;
  }
}
export default new AccessControl();
