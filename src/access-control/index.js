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
const hash = require('object-hash');
const Config = require('node-env-obj')();
const NRP = require('node-redis-pubsub');
const ObjectId = require('mongodb').ObjectId;

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
	async accessControlPolicy(req, res, next) {
		// TODO need to take into consideration appDataSharingId
		const appId = req.authApp._id;
		const user = req.authUser;
		if (!user) return next();

		let requestedURL = req.originalUrl || req.url;
		// Check URL to see if it's a core schema
		const core = requestedURL.indexOf('/api') === 0;
		if (core) return next();

		requestedURL = requestedURL.split('?').shift();
		const schemaPath = requestedURL.split('v1/').pop().split('/');
		const schemaName = schemaPath.shift();

		if (!this._schemas[appId]) {
			this._schemas[appId] = Schema.decode(req.authApp.__schema).filter((s) => s.type === 'collection');
			this._schemaNames[appId] = this._schemas[appId].map((s) => s.name);
		}

		if (!this._policies[appId]) {
			this._policies[appId] = await this.__loadAppPolicies(appId);
		}

		const userPolicies = await this.__getUserPolicies(user, appId);
		const policyOutcome = await this.__getPolicyOutcome(userPolicies, req, schemaName, appId, core);
		if (policyOutcome.err.statusCode && policyOutcome.err.message) {
			Logging.logTimer(policyOutcome.err.logTimerMsg, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(policyOutcome.err.statusCode).send({message: policyOutcome.err.message});
			return;
		}

		const params = {
			policies: policyOutcome.res,
			appId: appId,
			apiPath: req.authApp.apiPath,
			userId: user._id,
			schemaNames: this._schemaNames[appId],
			schemaName: schemaName,
			path: requestedURL,
		};

		await this._queuePolicyLimitDeleteEvent(userPolicies, user, appId);
		await this._checkAccessControlDBBasedQueryCondition(req, params);
		nrp.emit('queuePolicyRoomCloseSocketEvent', params);

		next();
	}

	async _getSchemaRoomStructure(userPolicies, req, schemaName, appId) {
		const outcome = await this.__getPolicyOutcome(userPolicies, req, schemaName, appId);

		if (outcome.err.statusCode || outcome.err.message) {
			Logging.logError(`getRoomStructure statusCode:${outcome.err.statusCode} message:${outcome.err.message}`)
			return {};
		}

		const structure = {
			appId: appId,
			schema: {},
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

		return {roomId: hash(outcome.res), structure};
	}

	async getUserRoomStructures(user, appId, req = {}) {
		if (!this._policies[appId]) {
			this._policies[appId] = await this.__loadAppPolicies(appId);
		}

		if (!this._schemas[appId]) {
			const app = await Model.App.findById(appId);
			this._schemas[appId] = Schema.decode(app.__schema).filter((s) => s.type === 'collection');
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
		const userPolicies = await this.__getUserPolicies(user, appId);
		for await (const schema of this._schemas[appId]) {
			req.body = {};
			req.accessControlQuery = {};
			const {roomId, structure} = await this._getSchemaRoomStructure(userPolicies, req, schema.name, appId);
			if (!roomId) continue;

			if (!rooms[roomId]) {
				rooms[roomId] = structure;
			} else {
				rooms[roomId].schema[schema.name] = structure.schema[schema.name];
			}
		}

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
	 * @param {Array} userPolicies
	 * @param {Object} req
	 * @param {String} schemaName
	 * @param {String} appId
	 * @param {Boolean} core
	 * @return {Object}
	 */
	async __getPolicyOutcome(userPolicies, req, schemaName, appId = null, core = false) {
		const outcome = {
			res: {},
			err: {},
		};

		appId = (!appId && req.authApp && req.authApp._id) ? req.authApp._id : appId;

		// TODO: better way to figure out the requested schema
		const requestVerb = req.method || req.originalMethod;

		userPolicies = userPolicies.sort((a, b) => a.priority - b.priority);
		if (userPolicies.length < 1) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			outcome.err.message = 'Request does not have any policy associated to it';
			return outcome;
		}

		const policiesConfig = userPolicies.reduce((arr, policy) => {
			const config = policy.config.slice().reverse().find((c) => c.endpoints.includes(requestVerb) || c.endpoints.includes('ALL'));
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
				return cond.schema.includes(schemaName) || cond.schema.includes('ALL');
			});
			const querySchemaIdx = policy.config.query.findIndex((q) => {
				return q.schema.includes(schemaName) || q.schema.includes('ALL');
			});
			const projectionSchemaIdx = policy.config.projection.findIndex((project) => {
				return project.schema.includes(schemaName) || project.schema.includes('ALL');
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
				if (query && query.access && query.access === 'FULL_ACCESS') {
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
			outcome.err.message = 'Request policy does not have access to the requested schema';
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

		const schema = this._schemas[appId].find((s) => s.name === schemaName);

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
			outcome.err.message = 'Can not access the queried data as it is not part of the policy filter';
			return outcome;
		}

		outcome.res = schemaBasePolicyConfig;
		return outcome;
	}

	async __loadAppPolicies(appId) {
		const policies = [];
		const rxsPolicies = Model.Policy.find({
			_appId: new ObjectId(appId),
		});
		for await (const policy of rxsPolicies) {
			policies.push(policy);
		}

		return policies;
	}

	async __getUserPolicies(user, appId) {
		return await AccessControlPolicyMatch.__getUserPolicies(this._policies[appId], appId, user);
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

	_queuePolicyLimitDeleteEvent(policies, user, appId) {
		const limitedPolicies = policies.filter((p) => p.limit && Sugar.Date.isValid(p.limit));
		if (limitedPolicies.length < 1) return;

		limitedPolicies.forEach((p) => {
			const nearlyExpired = Sugar.Date.create(p.limit) - Sugar.Date.create();
			if (this._oneWeekMilliseconds < nearlyExpired) return;
			if (this._queuedLimitedPolicy.includes(p.name)) return;

			const policyIdx = this._queuedLimitedPolicy.push(p.name);
			setTimeout(async () => {
				await this.__removeUserPropertiesPolicySelection(user, p, appId);
				await Model.Policy.rm(p);

				nrp.emit('app-policy:bust-cache', {
					appId,
				});

				nrp.emit('updateSocketRooms', {
					userId: user._id,
					appId,
				});

				this._queuedLimitedPolicy.splice(policyIdx, 1);
			}, nearlyExpired);
		});
	}

	async __removeUserPropertiesPolicySelection(user, policy, appId) {
		const userAppMetadata = user._appMetadata.find((m) => m.appId.toString() === appId.toString());
		if (!userAppMetadata) return;

		const limitedPolicySelectionKeys = Object.keys(policy.selection);
		const userPolicyProps = userAppMetadata.policyProperties;
		limitedPolicySelectionKeys.forEach((key) => {
			delete userPolicyProps[key];
		});

		await Model.User.setPolicyPropertiesById(user._id, appId, userPolicyProps);
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
