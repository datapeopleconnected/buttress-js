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

import hash from 'object-hash';
import NodeRedisPubsub from '../services/nrp.js';

import Sugar from '../helpers/sugar.js';
import Model from '../model/index.js';
import Logging from '../helpers/logging.js';
import * as Schema from '../helpers/schema.js';

import PolicySchemaModel, { Policy, PolicyConfig, PolicyEnv } from '../model/core/policy.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';

import AccessControlConditions from './conditions.js';
import AccessControlFilter from './filter.js';
import AccessControlEnv from './env.js';
import AccessControlProjection from './projection.js';
import AccessControlPolicyMatch from './policy-match.js';
import AccessControlHelpers, { filterPolicyConfigs } from './helpers.js';
import { BjsRequest } from '../types/bjs-express.js';
import { PolicyCache } from '../services/policy-cache.js';
import LambdaSchemaModel from '../model/core/lambda.js';
import UserSchemaModel from '../model/core/user.js';
import AppSchemaModel from '../model/core/app.js';

export class PolicyError extends Error {
  statusCode: number;
  logTimerMsg?: string;

  constructor(statusCode: number, message: string, logTimerMsg?: string) {
    super(message);
    this.name = 'PolicyError';
    this.statusCode = statusCode;
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
  _schemas: { [key: string]: any };
  // _policies: {[key: string]: any};

  _queuedLimitedPolicy: string[];

  _oneWeekMilliseconds: number;

  _coreSchema: any[];
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
      const data = JSON.parse(json);
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
  async accessControlPolicyMiddleware(req: BjsRequest, res, next) {
    Logging.logTimer(`accessControlPolicyMiddleware::start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

    // Define a property on the request that we'll use for the access control
    req.ac = {
      policyConfigs: [],
    };

    const isSystemToken = req.token.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM;
    if (isSystemToken) return next();

    const token = req.token;
    if (!token) {
      throw new Error(`Can not find a token for the requester`);
    }

    // Skip if we're hitting a plugin
    if (req.isPluginPath) return next();

    const user = req.authUser;
    const appId = token._appId.toString();
    const requestVerb = req.method || req.originalMethod;
    let lambdaAPICall = false;
    let requestedURL = req.originalUrl || req.url;
    requestedURL = requestedURL.split('?').shift() || '';
    const isLambdaCall = requestedURL.indexOf('/lambda/v1') === 0;

    if (requestedURL === '/api/v1/app/schema' && requestVerb === 'GET') return next();

    if (isLambdaCall) {
      const lambdaURL = requestedURL.replace(`/lambda/v1/${req.authApp.apiPath}/`, '');
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
    const schemaName = Schema.routeToModel(schemaPath.shift());

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

    if (!this._schemas[appId]) await this.__cacheAppSchema(appId);
    // if (!this._policies[appId]) await this.__cacheAppPolicies(appId);

    const tokenPolicies = await this.__getTokenPolicies(token, appId);
    Logging.logSilly(`Got ${tokenPolicies.length} matching policies for token ${token.type}:${token.id}`, req.id);

    try {
      req.ac.policyConfigs = await this.__getOutcome(tokenPolicies, req, schemaName, appId);
    } catch (err: any) {
      if (err instanceof PolicyError) {
        Logging.logTimer(err.logTimerMsg, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
        Logging.logError(err.message);
        return res.status(err.statusCode).send({ message: err.message });
      }

      Logging.logError(`Error in accessControlPolicyMiddleware: ${err.message}`);
      console.error(err);
      return res.status(500).send({ message: 'Internal Server Error' });
    }

    if (user) {
      // const params = {
      // 	policies: req.ac.policyConfigs,
      // 	appId: appId,
      // 	apiPath: req.authApp.apiPath,
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

    Logging.logTimer(`accessControlPolicyMiddleware::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    next();
  }

  async _getSchemaRoomStructure(tokenPolicies, req, schemaName, appId) {
    Logging.logTimer(`_getSchemaRoomStructure::start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

    let outcome: parsedPolicyConfig[];
    try {
      outcome = await this.__getOutcome(tokenPolicies, req, schemaName, appId);
    } catch (err: any) {
      if (err instanceof PolicyError) {
        Logging.logError(`getRoomStructure statusCode:${err.statusCode} message:${err.message}`);
        return {};
      }

      Logging.logError(`Error in accessControlPolicyMiddleware: ${err.message}`);
      console.error(err);
      return {};
    }

    const structure = {
      appId: appId,
      schema: {},
      appliedPolicy: outcome.map((o) => o.policies).flat(),
    };
    structure.schema[schemaName] = {
      access: {},
    };

    // TODO: The following lines are now redundant, getOutcome no longer modifieds the req.body.
    const projectionKeys = req.body && req.body.project ? Object.keys(req.body.project) : [];
    structure.schema[schemaName].access.query = req.body.query ? req.body.query : {};

    if (projectionKeys.length > 0) {
      structure.schema[schemaName].access.projection = [];
      projectionKeys.forEach((key) => {
        structure.schema[schemaName].access.projection.push(key);
      });
    }

    Logging.logTimer(`_getSchemaRoomStructure::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    return { roomId: hash(outcome), structure };
  }

  async getUserRoomStructures(user, appId, req: any = {}) {
    Logging.logTimer(`getUserRoomStructures::start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

    // if (!this._policies[appId]) await this.__cacheAppPolicies(appId);
    if (!this._schemas[appId]) await this.__cacheAppSchema(appId);

    if (!req.authApp) {
      req.authApp = {
        id: appId,
      };
    }
    if (!req.authUser) {
      req.authUser = user;
    }

    const rooms = {};
    // ! This isn't taking into account there could be mutiple user tokens.
    const token = await Model.getCoreModel(TokenSchemaModel).findOne({
      _userId: {
        $eq: Model.getCoreModel(UserSchemaModel).createId(user.id),
      },
    });
    const tokenPolicies = await this.__getTokenPolicies(token, appId);
    for await (const schema of this._schemas[appId]) {
      req.body = {};
      // req.accessControlQuery = {};
      const { roomId, structure } = await this._getSchemaRoomStructure(tokenPolicies, req, schema.name, appId);
      if (!roomId) continue;

      if (!rooms[roomId]) {
        rooms[roomId] = structure;
      } else {
        if (!structure) throw new Error('getUserRoomStructures - structure is not defined');
        rooms[roomId].schema[schema.name] = structure.schema[schema.name];
      }
    }

    Logging.logTimer(`getUserRoomStructures::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    return rooms;
  }

  /**
   * This is the main processing part of the policy engine, policies which have matched on the token are fed into this
   * function. The engine will then process the policies against the request and return a set of policies which are to
   * be processed.
   */
  async __getOutcome(
    tokenPolicies: Policy[],
    req: BjsRequest,
    schemaName: string,
    appId: string | null = null,
  ): Promise<parsedPolicyConfig[]> {
    Logging.logTimer(
      `__getOutcome::start - policies:${tokenPolicies.length}`,
      req.timer,
      Logging.Constants.LogLevel.SILLY,
      req.id,
    );

    appId = !appId && req.authApp && req.authApp.id ? req.authApp.id : appId;
    if (!appId) throw new Error('Trying to combine core with app schema but appId is not defined');

    const requestVerb = req.method || req.originalMethod;
    const isCoreSchema = this._coreSchemaNames.some((n) => n === schemaName);

    tokenPolicies = tokenPolicies.sort((a, b) => a.priority - b.priority);
    if (tokenPolicies.length < 1) {
      throw new PolicyError(
        401,
        `Request does not have any policy associated to it`,
        '_accessControlPolicy:access-control-policy-not-allowed',
      );
    }

    // Filter down policies t aplicable to the request
    let applicablePolicies = tokenPolicies.reduce((arr: ApplicablePolicyConfig[], policy) => {
      // * A query is needed regardless of what else is in the policy config, we'll discard any that are missing.
      const configs = filterPolicyConfigs(policy, schemaName, requestVerb, isCoreSchema);

      configs.forEach((config, idx) => {
        // TODO: Merging - Check the verbs, schema|endpoints and query. If they match then merge the other properties.
        arr.push({
          id: policy.id,
          name: `${policy.name}#${idx}`,
          env: policy.env,
          appId,
          config: JSON.parse(JSON.stringify(config)),
        });
      });

      return arr;
    }, []);

    if (applicablePolicies.length < 1) {
      throw new PolicyError(
        401,
        `Request does not have any policy rules matching the request verb ${requestVerb} and schema ${schemaName}`,
        '_accessControlPolicy:access-control-policy-not-allowed',
      );
    }

    const schemaCombined = [...this._coreSchema, ...this._schemas[appId]];
    const schema = schemaCombined.find((s) => s.name === schemaName || Sugar.String.singularize(s.name) === schemaName);

    if (!schema) {
      throw new PolicyError(
        401,
        `Request schema: ${schemaName} - does not exist in the app`,
        '_accessControlPolicy:access-control-policy-not-allowed',
      );
    }

    const reqEnv = AccessControlEnv.generateRequestGlobalEnvs(req, appId, req.authUser);

    applicablePolicies = await AccessControlConditions.filterPoliciesByPolicyConditions(applicablePolicies, reqEnv);
    if (applicablePolicies.length < 1) {
      throw new PolicyError(
        401,
        `Access control policy condition is not fulfilled to access ${schemaName}`,
        '_accessControlPolicy:conditions-not-fulfilled',
      );
    }

    // Look through each of the policies and build the queries
    applicablePolicies = await AccessControlFilter.buildApplicablePoliciesQuery(applicablePolicies, reqEnv);
    applicablePolicies = await AccessControlProjection.filterPoliciesByPolicyProjection(
      req,
      applicablePolicies,
      schema,
    );
    if (applicablePolicies.length < 1) {
      throw new PolicyError(
        401,
        `Can not access/edit properties of ${schemaName} without privileged access`,
        '_accessControlPolicy:access-control-properties-permission-error',
      );
    }

    // TODO: This needs to be revisited, it's expecting the AC to be already applied.
    // const passedEvalutaion = await AccessControlFilter.evaluateManipulationActions(req, schemaName);
    // console.log('passedEvalutaion', passedEvalutaion, schemaName);
    // if (!passedEvalutaion) {
    // 	throw new PolicyError(
    // 401,
    // `Accessed data from ${schemaName} can not be manipulated with your restricted policy`,
    // '_accessControlPolicy:access-control-query-permission-error');
    // }

    const outcome: parsedPolicyConfig[] = [];

    // Merge down policies, this is really only for projections.
    for (const policy of applicablePolicies) {
      const policyConfig = {
        ...policy.config,
        appId: policy.appId,
        policies: [policy.name],
      };

      // TODO: If a merged does happen the what do we do with ENV?

      // Try to see if we can merge this config with another policy.
      const existingPolicyConfig = outcome.findIndex((existing) => {
        const verbsMatch = policyConfig.verbs.every((v) => existing.verbs.includes(v));
        if (!verbsMatch) return false;

        if (existing.endpoints && policyConfig.endpoints) {
          const endpointsMatch = policyConfig.endpoints.every((ep) => existing.endpoints.includes(ep));
          if (!endpointsMatch) return false;
        }
        if (existing.schema && policyConfig.schema) {
          const schemaMatch = policyConfig.schema.every((s) => existing.schema.includes(s));
          if (!schemaMatch) return false;
        }

        const queryMatch = JSON.stringify(existing.query) === JSON.stringify(policyConfig.query);
        if (!queryMatch) {
          // If verbs & schema match, query doesn't and we have no projection then we can merge down the query.
          if (existing.projection === null && policyConfig.projection === null) {
            return true;
          }

          return false;
        }

        return true;
      });

      if (existingPolicyConfig !== -1) {
        if (policyConfig.projection === null) {
          // Try to merge down the queries
          if (outcome[existingPolicyConfig].query === null) {
            outcome[existingPolicyConfig].query = policyConfig.query;
          } else {
            outcome[existingPolicyConfig].query = AccessControlFilter.mergeQueryFilters(
              outcome[existingPolicyConfig].query,
              policyConfig.query,
              '$or',
            );
          }
        } else {
          if (outcome[existingPolicyConfig].projection === null) {
            outcome[existingPolicyConfig].projection = policyConfig.projection;
          } else {
            outcome[existingPolicyConfig].projection = {
              ...outcome[existingPolicyConfig].projection,
              ...policyConfig.projection,
            };
          }
        }

        outcome[existingPolicyConfig].policies = [...outcome[existingPolicyConfig].policies, ...policyConfig.policies];
      } else {
        outcome.push(policyConfig);
      }
    }
    Logging.logTimer(
      `__getOutcome::end Policy Configs: ${Object.keys(outcome).length}`,
      req.timer,
      Logging.Constants.LogLevel.SILLY,
      req.id,
    );

    return outcome;
  }

  async __cacheAppSchema(appId: string) {
    const app = await Model.getCoreModel(AppSchemaModel).findById(appId);
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

  async __getTokenPolicies(token: Token, appId: string) {
    if (!this._policyCache) throw new Error('Unable to get token policies, policy cache not set');
    return this._policyCache.getPoliciesByToken(token);
    // return AccessControlPolicyMatch.getTokenPolicies(this._policies[appId], token);
  }

  async _checkAccessControlDBBasedQueryCondition(req, params) {
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

  _queuePolicyLimitDeleteEvent(policies, userToken, appId) {
    const limitedPolicies = policies.filter((p) => p.limit && Sugar.Date.isValid(p.limit));
    if (limitedPolicies.length < 1) return;

    limitedPolicies.forEach((p) => {
      const nearlyExpired = Sugar.Date.create(p.limit).getTime() - Sugar.Date.create().getTime();
      if (this._oneWeekMilliseconds < nearlyExpired) return;
      if (this._queuedLimitedPolicy.includes(p.name)) return;

      const policyIdx = this._queuedLimitedPolicy.push(p.name);
      setTimeout(async () => {
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

        this._queuedLimitedPolicy.splice(policyIdx, 1);
      }, nearlyExpired);
    });
  }

  async __removeUserPropertiesPolicySelection(userToken, policy) {
    const policySelectionKeys = Object.keys(policy.selection);
    const tokenPolicyProps = userToken.policyProperties;
    policySelectionKeys.forEach((key) => {
      delete tokenPolicyProps[key];
    });

    await Model.getCoreModel(TokenSchemaModel).setPolicyPropertiesById(userToken.id.toString(), tokenPolicyProps);
  }

  __getInnerObjectValue(originalObj) {
    if (!originalObj) return null;

    const { schema, ...rest } = originalObj;
    return rest;
  }
}
export default new AccessControl();
