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

		let core = false;
		let requestedURL = req.originalUrl || req.url;
		// Check URL to see if it's a core schema
		if (!core) core = requestedURL.indexOf('/api') === 0;
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

		await this._checkAccessControlQueryBasedCondition(req, appId, schemaName, requestedURL);
		await this._queuePolicyRoomCloseSocketEvent(policyOutcome.res, appId);

		next();
	}

	/**
	 * lookup policies and compute user rooms
	 * @param {Object} user
	 * @param {Object} req
	 * @param {String} appId
	 * @param {Object} userSocketObj
	 * @return {Object}
	 */
	async getUserRooms(user, req, appId, userSocketObj) {
		if (!this._policies[appId]) {
			this._policies[appId] = await this.__loadAppPolicies(appId);
		}

		if (!this._schemas[appId]) {
			const app = await Model.App.findById(appId);
			this._schemas[appId] = Schema.decode(app.__schema).filter((s) => s.type === 'collection');
		}

		const userPolicies = await this.__getUserPolicies(user, appId);
		await this._schemas[appId].reduce(async (prev, next) => {
			await prev;
			req.body = {};
			req.accessControlQuery = {};
			const outcome = await this.__getPolicyOutcome(userPolicies, req, next.name, appId);
			const outcomeHash = hash(outcome.res);

			if (!outcome.err.statusCode && !outcome.err.message) {
				if (!userSocketObj[next.name]) {
					userSocketObj[next.name] = {};
				}
				if (!userSocketObj[next.name][outcomeHash]) {
					userSocketObj[next.name][outcomeHash] = {
						userIds: [],
						access: {},
					};
				}

				userSocketObj[next.name][outcomeHash].userIds.push(user._id);

				const projectionKeys = (req.body && req.body.project) ? Object.keys(req.body.project) : [];
				userSocketObj[next.name][outcomeHash].access.query = (req.body.query)? req.body.query : {};

				if (projectionKeys.length > 0) {
					userSocketObj[next.name][outcomeHash].access.projection = [];
					projectionKeys.forEach((key) => {
						userSocketObj[next.name][outcomeHash].access.projection.push(key);
					});
				}
			}
		}, Promise.resolve());

		return Object.keys(userSocketObj).reduce((arr, key) => {
			const schema = userSocketObj[key];
			Object.keys(schema).forEach((key) => {
				if (!schema[key].userIds) return;

				const userIdx = schema[key].userIds.findIndex((id) => id.toString() === user._id.toString());
				if (userIdx !== -1) {
					arr.push(key);
				}
			});

			return arr;
		}, [])
			.filter((v, idx, arr) => arr.indexOf(v) === idx);
	}

	/**
	 * compute policies outcome
	 * @param {Array} userPolicies
	 * @param {Object} req
	 * @param {String} schemaName
	 * @param {String} appId
	 * @param {Boolean} core
	 * @param {String} userName
	 * @return {Object}
	 */
	async __getPolicyOutcome(userPolicies, req, schemaName, appId = null, core = false, userName = null) {
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
			outcome.err.message = 'Request policy does have access to the requested schema';
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

		let schema = null;
		if (core) {
			const SchemaNameCamel = Sugar.String.camelize(schemaName);
			if (Model.coreSchema.includes(SchemaNameCamel)) {
				schema = Model[SchemaNameCamel].schemaData;
			}
		} else if (this._schemas[appId]) {
			schema = this._schemas[appId].find((s) => s.name === schemaName);
		}

		if (!schema) {
			outcome.err.statusCode = 401;
			outcome.err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			outcome.err.message = 'Request schema does not exist in the app';
			return outcome;
		}

		AccessControlConditions.setAppShortId(appId);
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
		await AccessControlFilter.applyAccessControlPolicyQuery(req);

		outcome.res = schemaBasePolicyConfig;
		return outcome;
	}

	async _queuePolicyRoomCloseSocketEvent(policies, appId) {
		nrp.emit('queuePolicyRoomCloseSocketEvent', {
			policies,
			appId,
			schemaNames: this._schemaNames[appId],
		});
	}

	async __loadAppPolicies(appId) {
		const policies = [];
		const rxsPolicies = Model.Policy.find({
			_appId: appId,
		});
		for await (const policy of rxsPolicies) {
			policies.push(policy);
		}

		return policies;
	}

	async __getUserPolicies(user, appId) {
		return await AccessControlPolicyMatch.__getUserPolicies(this._policies[appId], appId, user);
	}

	async _checkAccessControlQueryBasedCondition(req, appId, updatedSchema, path) {
		const requestMethod = req.method;
		if (requestMethod !== 'PUT') return;

		nrp.emit('updateUserSocketRooms', {
			userId: req.authUser._id,
			appId,
		});

		const id = path.split('/').pop();
		nrp.emit('accessControlPolicy:disconnectQueryBasedSocket', {
			appId,
			updatedSchema,
			id,
		});
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
