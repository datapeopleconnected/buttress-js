/**
 * ButtressJS - Realtime datastore for software
 *
 * @file accessControl.js
 * @description A list of access control phases
 * @module routes
 * @author Chris Bates-Keegan
 *
 */

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

		// TODO: better way to figure out the requested schema
		const requestVerb = req.method || req.originalMethod;
		let requestedURL = req.originalUrl || req.url;
		requestedURL = requestedURL.split('?').shift();
		const schemaPath = requestedURL.split('v1/').pop().split('/');
		const schemaName = schemaPath.shift();

		let userPolicies = await this.__getUserPolicies(user, req.authApp._id);
		userPolicies = userPolicies.sort((a, b) => a.priority - b.priority);
		// await this._checkAccessControlQueryBasedCondition(req, schemaName, schemaPath);

		if (userPolicies.length < 1) {
			Logging.logTimer(`_accessControlPolicy:access-control-policy-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Request does not have any policy associated to it'});
			return;
		}

		const policiesConfig = userPolicies.reduce((arr, policy) => {
			const config = policy.config.find((c) => c.endpoints.includes(requestVerb));
			if (config) {
				arr.push({
					name: policy.name,
					config,
				});
			}

			return arr;
		}, []);

		if (policiesConfig.length < 1) {
			Logging.logTimer(`_accessControlPolicy:access-control-policy-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Request does not have any policy rules matching the request verb'});
			return;
		}

		const schemaBasePolicyConfig = policiesConfig.reduce((arr, policy) => {
			const conditionSchemaIdx = policy.config.conditions.findIndex((cond) => cond.schema.includes(schemaName));
			if (!arr[policy.name]) {
				arr[policy.name] = {
					env: {},
					conditions: [],
					query: [],
					projection: [],
				};
			}

			if (conditionSchemaIdx !== -1) {
				const condition = this.__getInnerObjectValue(policy.config.conditions[conditionSchemaIdx]);
				arr[policy.name].conditions.push(condition);
			}

			const querySchemaIdx = policy.config.query.findIndex((q) => q.schema.includes(schemaName));
			if (querySchemaIdx !== -1) {
				const query = this.__getInnerObjectValue(policy.config.query[querySchemaIdx]);
				arr[policy.name].query.push(query);
			}

			const projectionSchemaIdx = policy.config.projection.findIndex((project) => project.schema.includes(schemaName));
			if (projectionSchemaIdx !== -1) {
				const projection = this.__getInnerObjectValue(policy.config.projection[projectionSchemaIdx]);
				arr[policy.name].projection.push(projection);
			}

			if (conditionSchemaIdx !== -1 || querySchemaIdx !== -1 || projectionSchemaIdx !== -1) {
				arr[policy.name].env = {
					...arr.env,
					...policy.config.env,
				};
			}

			return arr;
		}, {});

		const schemas = Schema.decode(req.authApp.__schema).filter((s) => s.type === 'collection');
		const schemaNames = schemas.map((s) => s.name);
		const schema = schemas.find((s) => s.name === schemaName);
		if (!schema) return next();

		AccessControlConditions.setAppShortId(req.authApp._id);
		await AccessControlConditions.applyPolicyConditions(req, schemaBasePolicyConfig);
		if (Object.keys(schemaBasePolicyConfig).length < 1) {
			Logging.logTimer(`_accessControlPolicy:conditions-not-fulfilled`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Access control policy conditions are not fulfilled'});
			return;
		}

		await AccessControlFilter.addAccessControlPolicyQuery(req, schemaBasePolicyConfig);
		const policyProjection = await AccessControlProjection.addAccessControlPolicyQueryProjection(req, schemaBasePolicyConfig, schema);
		if (!policyProjection) {
			Logging.logTimer(`_accessControlPolicy:access-control-properties-permission-error`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Can not access/edit properties without privileged access'});
			return;
		}
		await AccessControlFilter.applyAccessControlPolicyQuery(req);

		await this._queueAttributeCloseSocketEvent(schemaBasePolicyConfig, schemaNames);

		next();
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

	async __getUserPolicies(user, appId) {
		const policies = [];
		// TODO: Rein in this in so it only gets poilices that could match user
		const rxsPolicies = Model.Policy.find({
			_appId: appId,
		});
		for await (const policy of rxsPolicies) {
			policies.push(policy);
		}

		return await AccessControlPolicyMatch.__getUserPolicies(policies, appId, user);
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
		return Object.keys(originalObj).reduce((obj, key) => {
			if (key !== 'schema') {
				obj[key] = originalObj[key];
			}

			return obj;
		}, {});
	}
}
module.exports = new AccessControl();
