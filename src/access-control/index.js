/**
 * ButtressJS - Realtime datastore for software
 *
 * @file accessControl.js
 * @description A list of access control phases
 * @module routes
 * @author Chris Bates-Keegan
 *
 */

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
		this._attributeCloseSocketEvents = [];
		this._attributes = [];

		this._schemas = null;
		this._policies = null;
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
		const user = req.authUser;
		if (!user) return next();

		if (!this._schemas) {
			this._schemas = Schema.decode(req.authApp.__schema).filter((s) => s.type === 'collection');
		}

		if (!this._policies) {
			this._policies = await this.__loadAppPolicies(req.authApp._id);
		}

		const schemaNames = this._schemas.map((s) => s.name);

		const userPolicies = await this.__getUserPolicies(user, req.authApp._id);
		const policyOutcome = await this.__getPolicyOutcome(userPolicies, req);
		if (policyOutcome.statusCode && policyOutcome.message) {
			Logging.logTimer(policyOutcome.logTimerMsg, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(policyOutcome.statusCode).send({message: policyOutcome.message});
			return;
		}
		// await this._checkAccessControlQueryBasedCondition(req, schemaName, schemaPath);
		// await this._queueAttributeCloseSocketEvent(schemaBasePolicyConfig, schemaNames);

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
		req.body = {};

		if (!this._policies) {
			this._policies = await this.__loadAppPolicies(appId);
		}

		if (!this._schemas) {
			const app = await Model.App.findById(appId);
			this._schemas = Schema.decode(app.__schema).filter((s) => s.type === 'collection');
		}

		const userPolicies = await this.__getUserPolicies(user, appId);
		await this._schemas.reduce(async (prev, next) => {
			await prev;
			const outcome = await this.__getPolicyOutcome(userPolicies, req, next.name, appId);
			const outcomeHash = hash(req.body);

			if (!outcome.statusCode && !outcome.message) {
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
					userSocketObj[next.name][outcomeHash].access = {
						projection: [],
					};
					projectionKeys.forEach((key) => {
						userSocketObj[next.name][outcomeHash].access.projection.push(key);
					});
				}
			}
		}, Promise.resolve());

		return Object.keys(userSocketObj).reduce((arr, key) => {
			const schema = userSocketObj[key];
			Object.keys(schema).forEach((key) => {
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
	 * @return {Object}
	 */
	async __getPolicyOutcome(userPolicies, req, schemaName = null, appId = null) {
		const err = {};

		// TODO: better way to figure out the requested schema
		const requestVerb = req.method || req.originalMethod;
		if (!schemaName) {
			let requestedURL = req.originalUrl || req.url;
			requestedURL = requestedURL.split('?').shift();
			const schemaPath = requestedURL.split('v1/').pop().split('/');
			schemaName = schemaPath.shift();
		}

		userPolicies = userPolicies.sort((a, b) => a.priority - b.priority);
		if (userPolicies.length < 1) {
			err.statusCode = 401;
			err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			err.message = 'Request does not have any policy associated to it';
			return err;
		}

		const policiesConfig = userPolicies.reduce((arr, policy) => {
			const config = policy.config.slice().reverse().find((c) => c.endpoints.includes(requestVerb));
			if (config) {
				arr.push({
					name: policy.name,
					config,
				});
			}

			return arr;
		}, []);

		if (policiesConfig.length < 1) {
			err.statusCode = 401;
			err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			err.message = 'Request does not have any policy rules matching the request verb';
			return err;
		}

		const schemaBasePolicyConfig = policiesConfig.reduce((arr, policy) => {
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

				if (!arr) {
					arr = {};
				}

				if (!arr[policy.name]) {
					arr[policy.name] = {
						env: {},
						conditions: [],
						query: [],
						projection: [],
					};
				}

				if (condition) {
					arr[policy.name].conditions.push(condition);
				}
				if (query && query.access && query.access === 'FULL_ACCESS') {
					query = {};
				}
				if (query) {
					arr[policy.name].query.push(query);
				}
				if (projection) {
					arr[policy.name].projection.push(projection);
				}
				arr[policy.name].env = {
					...arr.env,
					...policy.config.env,
				};
			}

			return arr;
		}, false);

		if (!schemaBasePolicyConfig) {
			err.statusCode = 401;
			err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			err.message = 'Request policy does have access to the requested schema';
			return err;
		}

		const schema = this._schemas.find((s) => s.name === schemaName);
		if (!schema) {
			err.statusCode = 401;
			err.logTimerMsg = `_accessControlPolicy:access-control-policy-not-allowed`;
			err.message = 'Request schema does not exist in the app';
			return err;
		}

		appId = (req.authApp && req.authApp._id) ? req.authApp._id : appId;
		AccessControlConditions.setAppShortId(appId);
		await AccessControlConditions.applyPolicyConditions(req, schemaBasePolicyConfig);
		if (Object.keys(schemaBasePolicyConfig).length < 1) {
			err.statusCode = 401;
			err.logTimerMsg = `_accessControlPolicy:conditions-not-fulfilled`;
			err.message = 'Access control policy conditions are not fulfilled';
			return err;
		}

		await AccessControlFilter.addAccessControlPolicyQuery(req, schemaBasePolicyConfig);
		const policyProjection = await AccessControlProjection.addAccessControlPolicyQueryProjection(req, schemaBasePolicyConfig, schema);
		if (!policyProjection) {
			err.statusCode = 401;
			err.logTimerMsg = `_accessControlPolicy:access-control-properties-permission-error`;
			err.message = 'Can not access/edit properties without privileged access';
			return err;
		}
		await AccessControlFilter.applyAccessControlPolicyQuery(req);

		return err;
	}

	/**
	 * lookup attributes and fetch token attributes chain
	 * @param {Array} attributeNames
	 * @param {Array} attributes
	 * @return {Array} attributes
	 */
	_getAttributesChain(attributeNames, attributes = []) {
		const attrs = this._attributes.filter((attr) => attributeNames.includes(attr.name));
		attributes = attrs.concat(attributes);

		const extendedAttributes = attrs.reduce((arr, attr) => {
			attr.extends.forEach((a) => {
				if (arr.includes(a)) return;

				arr.push(a);
			});

			return arr;
		}, []);

		if (extendedAttributes.length > 0) {
			return this._getAttributesChain(extendedAttributes, attributes);
		}

		return attributes;
	}

	async _queueAttributeCloseSocketEvent(attributes, schemaNames) {
		nrp.emit('queueAttributeCloseSocketEvent', {
			attributes,
			schemaNames,
		});
	}

	async getAttributeChannels(appId) {
		const channels = [];

		await this._attributes.reduce(async (prev, attribute) => {
			await prev;
			channels.push(attribute.name);
		}, Promise.resolve());

		return channels;
	}

	async getAttributesChainForToken(tokenAttribute) {
		return await this._getAttributesChain(tokenAttribute);
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
		return await AccessControlPolicyMatch.__getUserPolicies(this._policies, appId, user);
	}

	async _checkAccessControlQueryBasedCondition(req, updatedSchema, path) {
		const requestMethod = req.method;
		if (requestMethod !== 'PUT') return;

		const id = path.pop();

		nrp.emit('accessControlPolicy:disconnectQueryBasedSocket', {
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
