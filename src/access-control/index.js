/**
 * ButtressJS - Realtime datastore for software
 *
 * @file accessControl.js
 * @description A list of access control phases
 * @module routes
 * @author Chris Bates-Keegan
 *
 */

const Sugar = require('sugar');
require('sugar-inflections');
const hash = require('object-hash');
const Config = require('node-env-obj')();
const NRP = require('node-redis-pubsub');

const Model = require('../model');
const Logging = require('../logging');
const Schema = require('../schema');
const AccessControlConditions = require('./conditions');
const AccessControlFilter = require('./filter');
const AccessControlProjection = require('./projection');
const AccessControlPolicyMatch = require('./policy-match');

const nrp = new NRP(Config.redis);

class AccessControl {
	constructor() {
		this._schemas = {};
		this._policies = {};
		this._schemaNames = {};
		this._queuedLimitedPolicy = [];

		this._oneWeekMilliseconds = Sugar.Number.day(7);

		this._coreSchema = [];
		this._coreSchemaNames = [];

		this.handlePolicyCaching();
	}

	handlePolicyCaching() {
		nrp.on('app-policy:bust-cache', async (data) => {
			this._policies[data.appId] = await this.__loadAppPolicies(data.appId);
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
		const lambda = req.authLambda;
		const appId = token._appId.toString();
		const requestVerb = req.method || req.originalMethod;
		const coreSchemaCall = req.params.core;
		let lambdaAPICall = false;
		let requestedURL = req.originalUrl || req.url;
		requestedURL = requestedURL.split('?').shift();
		const isLambdaCall = requestedURL.indexOf('/api/v1/lambda') === 0;

		if (lambda && !user && requestedURL === '/api/v1/app/schema' && requestVerb === 'GET') return next();
		if (user && !coreSchemaCall && requestedURL === '/api/v1/app/schema' && requestVerb === 'GET') return next();

		if (isLambdaCall) {
			const lambdaURL = requestedURL.replace(`/api/v1/lambda/${req.authApp.apiPath}/`, '');
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
		const schemaName = schemaPath.shift();

		if (user && this._coreSchemaNames.some((n) => n === schemaName)) {
			const userAppToken = await Model.Token.findOne({
				_appId: {
					$eq: user._appId,
				},
				type: {
					$eq: Model.Token.Constants.Type.SYSTEM,
				},
			});
			if (!userAppToken) {
				return res.status(401).send({message: `Non admin app user can not do any core schema requests`});
			}
		}

		if (this._coreSchema.length < 1) {
			this._coreSchema = Model._getModels().reduce((arr, name) => {
				name = Sugar.String.camelize(name);
				arr.push(Model[name].schemaData);
				return arr;
			}, []);
			this._coreSchemaNames = this._coreSchema.map((c) => Sugar.String.singularize(c.name));
		}

		if (!this._schemas[appId]) {
			const appSchema = Schema.decode(req.authApp.__schema).filter((s) => s.type.indexOf('collection') === 0);
			this._schemas[appId] = appSchema.concat(this._coreSchema);
			this._schemaNames[appId] = this._schemas[appId].map((s) => s.name);
		}

		if (!this._policies[appId]) {
			this._policies[appId] = await this.__loadAppPolicies(appId);
		}

		const tokenPolicies = await this.__getTokenPolicies(token, appId);
		const policyOutcome = await this.__getPolicyOutcome(tokenPolicies, req, schemaName, appId);
		if (policyOutcome.err.statusCode && policyOutcome.err.message) {
			Logging.logTimer(policyOutcome.err.logTimerMsg, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			Logging.logError(policyOutcome.err.message);
			res.status(policyOutcome.err.statusCode).send({message: policyOutcome.err.message});
			return;
		}

		if (user) {
			const params = {
				policies: policyOutcome.res,
				appId: appId,
				apiPath: req.authApp.apiPath,
				userId: user._id,
				schemaNames: this._schemaNames[appId],
				schemaName: schemaName,
				path: requestedURL,
			};
			await this._queuePolicyLimitDeleteEvent(tokenPolicies, token, appId);
			// TODO: This doesn't need to happen here, move to sock
			// await this._checkAccessControlDBBasedQueryCondition(req, params);
			nrp.emit('queuePolicyRoomCloseSocketEvent', params);
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
		if (!this._policies[appId]) {
			this._policies[appId] = await this.__loadAppPolicies(appId);
		}

		if (!this._schemas[appId]) {
			const app = await Model.App.findById(appId);
			this._schemas[appId] = Schema.decode(app.__schema).filter((s) => s.type.indexOf('collection') === 0);
		}

		if (!req.authApp) {
			req.authApp = {
				_id: appId,
			};
		}
		if (!req.authUser) {
			req.authUser = {
				_id: user._id,
			};
		}

		const rooms = {};
		const token = await Model.Token.findOne({
			_userId: {
				$eq: Model.User.createId(user._id),
			},
		});
		const tokenPolicies = await this.__getTokenPolicies(token, appId);
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

		// 		const userIdx = schema[key].userIds.findIndex((id) => id.toString() === user._id.toString());
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

		appId = (!appId && req.authApp && req.authApp._id) ? req.authApp._id : appId;

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
			outcome.err.message = 'Request does not have any policy rules matching the request verb';
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
				if (query && query.access && query.access === '%FULL_ACCESS%') {
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

		const schema = this._schemas[appId].find((s) => s.name === schemaName || Sugar.String.singularize(s.name) === schemaName);
		if (!schema) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			outcome.err.message = 'Request schema does not exist in the app';
			return outcome;
		}

		await AccessControlConditions.applyPolicyConditions(req, schemaBasePolicyConfig);

		if (Object.keys(schemaBasePolicyConfig).length < 1) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:conditions-not-fulfilled`;
			outcome.err.message = 'Access control policy conditions are not fulfilled';
			return outcome;
		}

		await AccessControlFilter.addAccessControlPolicyQuery(req, schemaBasePolicyConfig);
		const policyProjection = await AccessControlProjection.addAccessControlPolicyQueryProjection(req, schemaBasePolicyConfig, schema);
		if (!policyProjection) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-properties-permission-error`;
			outcome.err.message = 'Can not access/edit properties without privileged access';
			return outcome;
		}

		const policyQuery = await AccessControlFilter.applyAccessControlPolicyQuery(req);
		if (!policyQuery) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-query-permission-error`;
			outcome.err.message = 'Policy query Can not access the queried data';
			return outcome;
		}

		outcome.res = schemaBasePolicyConfig;
		Logging.logTimer(`__getPolicyOutcome::end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		return outcome;
	}

	async __loadAppPolicies(appId) {
		const policies = [];
		const rxsPolicies = await Model.Policy.find({
			_appId: Model.Policy.createId(appId),
		});
		for await (const policy of rxsPolicies) {
			policies.push(policy);
		}

		return policies;
	}

	async __getTokenPolicies(token, appId) {
		return await AccessControlPolicyMatch.__getTokenPolicies(this._policies[appId], token);
	}

	async _checkAccessControlDBBasedQueryCondition(req, params) {
		const requestMethod = req.method;
		if (requestMethod !== 'PUT') return;

		const id = params.path.split('/').pop();
		nrp.emit('accessControlPolicy:disconnectQueryBasedSocket', {
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
				await Model.Policy.rm(p);

				nrp.emit('app-policy:bust-cache', {
					appId,
				});

				nrp.emit('worker:socket:updateUserSocketRooms', {
					userId: Model.User.create(userToken._user),
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

		await Model.Token.setPolicyPropertiesById(userToken._id, tokenPolicyProps);
	}

	__getInnerObjectValue(originalObj) {
		if (!originalObj) return null;

		return Object.keys(originalObj).reduce((obj, key) => {
			if (key !== 'schema') {
				obj[key] = originalObj[key];
			}

			return obj;
		}, {});
	}
}
module.exports = new AccessControl();
