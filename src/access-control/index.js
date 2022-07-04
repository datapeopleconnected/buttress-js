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
const Sugar = require('sugar');

const Model = require('../model');
const Logging = require('../logging');
const Schema = require('../schema');
const AccessControlConditions = require('./conditions');
const AccessControlFilter = require('./filter');
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

		const userPolicies = await this.__getUserPolicies(user, req.authApp._id);
		// await this._checkAccessControlQueryBasedCondition(req, schemaName, schemaPath);

		if (userPolicies.length < 1) {
			Logging.logTimer(`_accessControlPolicy:access-control-policy-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Request does not have any policy associated to it'});
			return;
		}

		const schemaBasePolicies = userPolicies.filter((policy) => policy.targetedSchema.includes(schemaName) || policy.targetedSchema.length < 1);
		if (schemaBasePolicies.length < 1) {
			Logging.logTimer(`_accessControlPolicy:access-control-policy-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Request does not have any policy associated to the requested schema'});
			return;
		}

		const policiesConfig = schemaBasePolicies.reduce((arr, policy) => {
			const config = policy.config.find((c) => c.endpoints.includes(requestVerb));
			if (config) {
				arr.push(config);
			}

			return arr;
		}, []);

		if (policiesConfig.length < 1) {
			Logging.logTimer(`_accessControlPolicy:access-control-policy-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Request does not have any policy rules matching the request verb'});
			return;
		}

		const schemas = Schema.decode(req.authApp.__schema).filter((s) => s.type === 'collection');
		const schemaNames = schemas.map((s) => s.name);
		const schema = schemas.find((s) => s.name === schemaName);
		if (!schema) return next();

		AccessControlConditions.setAppShortId(req.authApp._id);
		const accessControlAuthorisation = await AccessControlConditions.applyAccessControlPolicyConditions(req, policiesConfig);
		if (!accessControlAuthorisation) {
			Logging.logTimer(`_accessControlPolicy:conditions-not-fulfilled`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Access control policy conditions are not fulfilled'});
			return;
		}

		const passedAccessControlPolicy = await AccessControlFilter.addAccessControlPolicyQuery(req, policiesConfig, schema);
		if (!passedAccessControlPolicy) {
			Logging.logTimer(`_accessControlPolicy:access-control-properties-permission-error`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Can not access/edit properties without privileged access'});
			return;
		}
		await AccessControlFilter.applyAccessControlPolicyQuery(req);

		await this._queueAttributeCloseSocketEvent(policiesConfig, schemaNames);

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

	/**
	 * Fetch schema related attributes from the token attributes
	 * @param {Object} req
	 * @param {Array} attributes
	 * @param {Array} policyAttributes
	 * @param {Array} attrs
	 * @return {Array}
	 */
	async _getSchemaRelatedAttributes(req, attributes, policyAttributes, attrs = []) {
		const attributeIds = attributes.map((attr) => attr._id);

		attributes.forEach((attr) => {
			if (attr.extends.length > 1) {
				attr.extends.forEach((extendedAttr) => {
					const extendedAttribute = policyAttributes.find((attr) => attr.name === extendedAttr && !attributeIds.includes(attr._id));

					if (!extendedAttribute) return;

					attrs.push(extendedAttribute);
				});
			}

			attrs.push(attr);
		});

		if (attrs.some((attr) => attr.configuration.override)) {
			const dominantAttrs = [];
			await attrs.reduce(async (prev, attr) => {
				await prev;

				if (Sugar.Date.isAfter(Sugar.Date.create('now'), Sugar.Date.create(attr.configuration.limit))) return;
				if (!attr.configuration.optionalCondition) {
					dominantAttrs.push(attr);
				}

				if (attr.configuration.optionalCondition && await AccessControlConditions.applyAccessControlPolicyConditions(req, [attr])) {
					dominantAttrs.push(attr);
				}

				return;
			}, Promise.resolve());

			attrs = (dominantAttrs.length > 0)? dominantAttrs : attrs.filter((attr) => !attr.configuration.override);
		}

		return attrs;
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
}
module.exports = new AccessControl();
