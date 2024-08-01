'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

const Sugar = require('sugar');
require('sugar-inflections');
const hash = require('object-hash');

const Model = require('../model');
const Logging = require('../helpers/logging');
const Schema = require('../schema');
const AccessControlConditions = require('./conditions');
const AccessControlFilter = require('./filter');
const AccessControlProjection = require('./projection');
const AccessControlPolicyMatch = require('./policy-match');
const AccessControlHelpers = require('./helpers');

class AccessControl {
	constructor() {
		this._schemas = {};
		this._policies = {};
		this._queuedLimitedPolicy = [];

		this._oneWeekMilliseconds = Sugar.Number.day(7);

		this._coreSchema = [];
		this._coreSchemaNames = [];

		this._queryAccess = [
			'%FULL_ACCESS%',
			'%APP_SCHEMA%',
			'%CORE_SCHEMA%',
		];
	}

	async init(nrp) {
		this._nrp = nrp;

		this.handleCacheListeners();
	}

	handleCacheListeners() {
		this._nrp.on('app-policy:bust-cache', async (data) => await this.__cacheAppPolicies(data.appId));
		this._nrp.on('app-schema:updated', async (data) => await this.__cacheAppSchema(data.appId));
	}

	/**
	 * Check access control policy before granting access to the data
	 * @param {Object} req - Request object
	 * @param {Object} res - Response object
	 * @param {Function} next - next handler function
	 * @return {Void}
	 * @private
	 */
	async accessControlPolicyMiddleware(req, res, next) {
		Logging.logTimer(`accessControlPolicyMiddleware::start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		const isSystemToken = req.token.type === Model.Token.Constants.Type.SYSTEM;
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
		requestedURL = requestedURL.split('?').shift();
		const isLambdaCall = requestedURL.indexOf('/lambda/v1') === 0;

		if (requestedURL === '/api/v1/app/schema' && requestVerb === 'GET') return next();

		if (isLambdaCall) {
			const lambdaURL = requestedURL.replace(`/lambda/v1/${req.authApp.apiPath}/`, '');
			lambdaAPICall = await Model.Lambda.findOne({
				'trigger.apiEndpoint.url': {
					$eq: lambdaURL,
				},
				'_appId': {
					$eq: Model.Lambda.createId(appId),
				},
			});
		}
		if (lambdaAPICall) return next();

		const schemaPath = requestedURL.split('v1/').pop().split('/');
		const schemaName = Schema.routeToModel(schemaPath.shift());

		if (this._coreSchema.length < 1) {
			this._coreSchema = await AccessControlHelpers.cacheCoreSchema();
			this._coreSchemaNames = this._coreSchema.map((c) => Sugar.String.singularize(c.name));
		}

		// if (user && this._coreSchemaNames.some((n) => n === schemaName)) {
		// 	const userAppToken = await Model.Token.findOne({
		// 		_appId: {
		// 			$eq: user._appId,
		// 		},
		// 		type: {
		// 			$eq: Model.Token.Constants.Type.SYSTEM,
		// 		},
		// 	});
		// 	if (!userAppToken) {
		// 		return res.status(401).send({message: `Non admin app user can not do any core schema requests`});
		// 	}
		// }

		if (!this._schemas[appId]) await this.__cacheAppSchema(appId);
		if (!this._policies[appId]) await this.__cacheAppPolicies(appId);

		const tokenPolicies = this.__getTokenPolicies(token, appId);
		Logging.logSilly(`Got ${tokenPolicies.length} Matched policies for token ${token.type}:${token.id}`, req.id);

		const policyOutcome = await this.__getPolicyOutcome(tokenPolicies, req, schemaName, appId);
		if (policyOutcome.err.statusCode && policyOutcome.err.message) {
			Logging.logTimer(policyOutcome.err.logTimerMsg, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			Logging.logError(policyOutcome.err.message);
			return res.status(policyOutcome.err.statusCode).send({message: policyOutcome.err.message});
		}

		if (user) {
			const params = {
				policies: policyOutcome.res,
				appId: appId,
				apiPath: req.authApp.apiPath,
				userId: user.id,
				schemaNames: [...this._coreSchema, ...this._schemas[appId]].map((s) => s.name),
				schemaName: schemaName,
				path: requestedURL,
			};
			await this._queuePolicyLimitDeleteEvent(tokenPolicies, token, appId);
			// TODO: This doesn't need to happen here, move to sock
			// await this._checkAccessControlDBBasedQueryCondition(req, params);
			this._nrp.emit('queuePolicyRoomCloseSocketEvent', params);
		}

		// TODO: This doesn't need to happen here, move to sock
		// await this._checkAccessControlDBBasedQueryCondition(req, params);

		Logging.logTimer(`accessControlPolicyMiddleware::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		next();
	}

	async _getSchemaRoomStructure(tokenPolicies, req, schemaName, appId) {
		Logging.logTimer(`_getSchemaRoomStructure::start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		const outcome = await this.__getPolicyOutcome(tokenPolicies, req, schemaName, appId);

		if (outcome.err.statusCode || outcome.err.message) {
			Logging.logError(`getRoomStructure statusCode:${outcome.err.statusCode} message:${outcome.err.message}`);
			return {};
		}

		const structure = {
			appId: appId,
			schema: {},
			appliedPolicy: Object.keys(outcome.res),
		};
		structure.schema[schemaName] = {
			access: {},
		};

		const projectionKeys = (req.body && req.body.project) ? Object.keys(req.body.project) : [];
		structure.schema[schemaName].access.query = (req.body.query)? req.body.query : {};

		if (projectionKeys.length > 0) {
			structure.schema[schemaName].access.projection = [];
			projectionKeys.forEach((key) => {
				structure.schema[schemaName].access.projection.push(key);
			});
		}

		Logging.logTimer(`_getSchemaRoomStructure::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		// TODO: Add app id to hash
		return {roomId: hash(outcome.res), structure};
	}

	async getUserRoomStructures(user, appId, req = {}) {
		Logging.logTimer(`getUserRoomStructures::start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		if (!this._policies[appId]) await this.__cacheAppPolicies(appId);
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
		const token = await Model.Token.findOne({
			_userId: {
				$eq: Model.User.createId(user.id),
			},
		});
		const tokenPolicies = this.__getTokenPolicies(token, appId);
		for await (const schema of this._schemas[appId]) {
			req.body = {};
			req.accessControlQuery = {};
			const {roomId, structure} = await this._getSchemaRoomStructure(tokenPolicies, req, schema.name, appId);
			if (!roomId) continue;

			if (!rooms[roomId]) {
				rooms[roomId] = structure;
			} else {
				rooms[roomId].schema[schema.name] = structure.schema[schema.name];
			}
		}

		Logging.logTimer(`getUserRoomStructures::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		return rooms;
	}

	/**
	 * lookup policies and compute user rooms
	 * @param {Object} user
	 * @param {String} appId
	 * @param {Object} req
	 * @return {Object}
	 */
	async getUserRooms(user, appId, req) {
		const rooms = await this.getUserRoomStructures(user, appId, req);
		return Object.keys(rooms);
		// return Object.keys(rooms).reduce((arr, key) => {
		// 	const schema = appPolicyRooms[key];
		// 	Object.keys(schema).forEach((key) => {
		// 		if (!schema[key].userIds) return;

		// 		const userIdx = schema[key].userIds.findIndex((id) => id.toString() === user.id.toString());
		// 		if (userIdx !== -1) {
		// 			arr.push(key);
		// 		}
		// 	});

		// 	return arr;
		// }, [])
		// 	.filter((v, idx, arr) => arr.indexOf(v) === idx);
	}

	/**
	 * compute policies outcome
	 * @param {Array} tokenPolicies
	 * @param {Object} req
	 * @param {String} schemaName
	 * @param {String} appId
	 * @return {Object}
	 */
	async __getPolicyOutcome(tokenPolicies, req, schemaName, appId = null) {
		Logging.logTimer(`__getPolicyOutcome::start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		const outcome = {
			res: {},
			err: {},
		};

		appId = (!appId && req.authApp && req.authApp.id) ? req.authApp.id : appId;

		// TODO: better way to figure out the request verb
		const requestVerb = req.method || req.originalMethod;
		const isCoreSchema = this._coreSchemaNames.some((n) => n === schemaName);

		tokenPolicies = tokenPolicies.sort((a, b) => a.priority - b.priority);
		if (tokenPolicies.length < 1) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			outcome.err.message = 'Request does not have any policy associated to it';
			return outcome;
		}

		const policiesConfig = tokenPolicies.reduce((arr, policy) => {
			const config = policy.config.slice().reverse().find((c) => {
				return (c.endpoints.includes(requestVerb) || c.endpoints.includes('%ALL%')) &&
					c.query.some((q) => {
						if (isCoreSchema) {
							return q.schema.includes(schemaName) || q.schema.includes('%ALL%') || q.schema.includes('%CORE_SCHEMA%');
						}
						return q.schema.includes(schemaName) || q.schema.includes('%ALL%') || q.schema.includes('%APP_SCHEMA%');
					});
			});

			if (config) {
				arr.push({
					name: policy.name,
					merge: policy.merge,
					config,
				});
			}

			return arr;
		}, []);

		if (policiesConfig.length < 1) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			outcome.err.message = `Request does not have any policy rules matching the request verb ${requestVerb} and schema ${schemaName}`;
			return outcome;
		}

		let schemaBasePolicyConfig = policiesConfig.reduce((obj, policy) => {
			const conditionSchemaIdx = policy.config.conditions.findIndex((cond) => {
				const cs = cond.schema;
				if (isCoreSchema) {
					if (cs.includes('%ALL%') || cs.includes('%CORE_SCHEMA%') || cs.includes(schemaName)) return true;
				} else {
					if (cs.includes('%ALL%') || cs.includes('%APP_SCHEMA%') || cs.includes(schemaName)) return true;
				}

				return false;
			});
			const querySchemaIdx = policy.config.query.findIndex((q) => {
				const qs = q.schema;
				if (isCoreSchema) {
					if (qs.includes('%ALL%') || qs.includes('%CORE_SCHEMA%') || qs.includes(schemaName)) return true;
				} else {
					if (qs.includes('%ALL%') || qs.includes('%APP_SCHEMA%') || qs.includes(schemaName)) return true;
				}

				return false;
			});
			const projectionSchemaIdx = policy.config.projection.findIndex((project) => {
				const ps = project.schema;
				if (isCoreSchema) {
					if (ps.includes('%ALL%') || ps.includes('%CORE_SCHEMA%') || ps.includes(schemaName)) return true;
				} else {
					if (ps.includes('%ALL%') || ps.includes('%APP_SCHEMA%') || ps.includes(schemaName)) return true;
				}

				return false;
			});

			if (conditionSchemaIdx !== -1 || querySchemaIdx !== -1 || projectionSchemaIdx !== -1) {
				const condition = this.__getInnerObjectValue(policy.config.conditions[conditionSchemaIdx]);
				const projection = this.__getInnerObjectValue(policy.config.projection[projectionSchemaIdx]);
				let query = this.__getInnerObjectValue(policy.config.query[querySchemaIdx]);

				if (!obj) {
					obj = {};
				}

				if (!obj[policy.name]) {
					obj[policy.name] = {
						appId: appId.toString(),
						env: {},
						conditions: [],
						query: [],
						projection: [],
						merge: policy.merge,
					};
				}

				if (condition) {
					obj[policy.name].conditions.push(condition);
				}
				if (query && query.access && this._queryAccess.includes(query.access)) {
					query = {};
				}
				if (query) {
					obj[policy.name].query.push(query);
				}
				if (projection) {
					obj[policy.name].projection.push(projection);
				}
				obj[policy.name].env = {
					...obj.env,
					...policy.config.env,
				};
			}

			return obj;
		}, false);

		if (!schemaBasePolicyConfig) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			outcome.err.message = `Request policy does not have access to the requested schema: ${schemaName}`;
			return outcome;
		}

		const mergedPolicyConfig = Object.keys(schemaBasePolicyConfig).reduce((obj, configKey) => {
			if (schemaBasePolicyConfig[configKey].merge) {
				obj[configKey] = schemaBasePolicyConfig[configKey];
			}

			return obj;
		}, {});

		if (Object.keys(schemaBasePolicyConfig).length !== Object.keys(mergedPolicyConfig).length) {
			const highestPriorityKey = Object.keys(schemaBasePolicyConfig).pop();
			const highestPolicyPriorityConfig = Object.keys(schemaBasePolicyConfig).reduce((obj, configKey) => {
				if (highestPriorityKey !== configKey) return obj;

				obj[configKey] = schemaBasePolicyConfig[configKey];
				return obj;
			}, {});

			await AccessControlConditions.applyPolicyConditions(req, highestPolicyPriorityConfig);
			if (Object.keys(highestPolicyPriorityConfig).length < 1) {
				delete schemaBasePolicyConfig[highestPriorityKey];
			} else {
				schemaBasePolicyConfig = highestPolicyPriorityConfig;
			}
		}

		const schemaCombined = [...this._coreSchema, ...this._schemas[appId]];
		const schema = schemaCombined
			.find((s) => s.name === schemaName || Sugar.String.singularize(s.name) === schemaName);

		if (!schema) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			outcome.err.message = `Request schema: ${schemaName} - does not exist in the app`;
			return outcome;
		}

		await AccessControlConditions.applyPolicyConditions(req, schemaBasePolicyConfig);

		if (Object.keys(schemaBasePolicyConfig).length < 1) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:conditions-not-fulfilled`;
			outcome.err.message = `Access control policy conditions are not fulfilled to access ${schemaName}`;
			return outcome;
		}

		await AccessControlFilter.addAccessControlPolicyQuery(req, schemaBasePolicyConfig);
		const policyProjection = await AccessControlProjection.addAccessControlPolicyQueryProjection(req, schemaBasePolicyConfig, schema);
		if (!policyProjection) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-properties-permission-error`;
			outcome.err.message = `Can not access/edit properties of ${schemaName} without privileged access`;
			return outcome;
		}

		const policyQuery = await AccessControlFilter.applyAccessControlPolicyQuery(req);
		if (!policyQuery) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-query-permission-error`;
			outcome.err.message = `Policy query can not access the queried data from ${schemaName}`;
			return outcome;
		}

		// TODO needs to be removed and added to the adapters - TEMPORARY HACK!!
		const passedEvalutaion = await AccessControlFilter.evaluateManipulationActions(req, schemaName);
		if (!passedEvalutaion) {
			outcome.err.statusCode = 404;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-query-permission-error`;
			outcome.err.message = `Accessed data from ${schemaName} can not be manipulated with your restricted policy`;
			return outcome;
		}

		outcome.res = schemaBasePolicyConfig;
		Logging.logTimer(`__getPolicyOutcome::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		return outcome;
	}


	async __cacheAppSchema(appId) {
		const app = await Model.App.findById(appId);
		this._schemas[appId] = Schema.decode(app.__schema).filter((s) => s.type.indexOf('collection') === 0);

		Logging.logSilly(`Refreshed schema cache for app ${appId} got ${this._schemas[appId].length} schema`);
	}

	async __cacheAppPolicies(appId) {
		const policies = [];
		const rxsPolicies = await Model.Policy.find({
			_appId: Model.Policy.createId(appId),
		});
		for await (const policy of rxsPolicies) {
			policies.push(policy);
		}

		Logging.logSilly(`Refreshed policies for app ${appId} got ${policies.length} policies`);

		this._policies[appId] = policies;
	}

	__getTokenPolicies(token, appId) {
		return AccessControlPolicyMatch.__getTokenPolicies(this._policies[appId], token);
	}

	async _checkAccessControlDBBasedQueryCondition(req, params) {
		const requestMethod = req.method;
		if (requestMethod !== 'PUT') return;

		const id = params.path.split('/').pop();
		this._nrp.emit('accessControlPolicy:disconnectQueryBasedSocket', {
			appId: params.appId,
			apiPath: params.apiPath,
			userId: params.userId,
			id: id,
			updatedSchema: params.schemaName,
		});
	}

	_queuePolicyLimitDeleteEvent(policies, userToken, appId) {
		const limitedPolicies = policies.filter((p) => p.limit && Sugar.Date.isValid(p.limit));
		if (limitedPolicies.length < 1) return;

		limitedPolicies.forEach((p) => {
			const nearlyExpired = Sugar.Date.create(p.limit) - Sugar.Date.create();
			if (this._oneWeekMilliseconds < nearlyExpired) return;
			if (this._queuedLimitedPolicy.includes(p.name)) return;

			const policyIdx = this._queuedLimitedPolicy.push(p.name);
			setTimeout(async () => {
				await this.__removeUserPropertiesPolicySelection(userToken, p);
				await Model.Policy.rm(p.id);

				this._nrp.emit('app-policy:bust-cache', {
					appId,
				});

				this._nrp.emit('worker:socket:updateUserSocketRooms', {
					userId: Model.User.create(userToken._userId),
					appId,
				});

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

		await Model.Token.setPolicyPropertiesById(userToken.id, tokenPolicyProps);
	}

	__getInnerObjectValue(originalObj) {
		if (!originalObj) return null;

		// eslint-disable-next-line no-unused-vars
		const {schema, ...rest} = originalObj;
		return rest;
	}
}
module.exports = new AccessControl();
