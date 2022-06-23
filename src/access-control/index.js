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
const AccessControlDisposition = require('./disposition');
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
		// access control policy

		// TODO need to take into consideration appDataSharingId

		const user = req.authUser;
		if (!user) return next();

		// TODO: better way to figure out the requested schema
		let requestedURL = req.originalUrl || req.url;
		requestedURL = requestedURL.split('?').shift();
		const schemaPath = requestedURL.split('v1/').pop().split('/');
		const schemaName = schemaPath.shift();

		let policyAttributes = await this.__getPolicyAttributes(user);
		await this._checkAccessControlQueryBasedCondition(req, schemaName, schemaPath);

		if (policyAttributes.length < 1) {
			Logging.logTimer(`_accessControlPolicy:access-control-policy-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Request policy does not have any access control attributes'});
			return;
		}

		await this.__getAttributes();

		policyAttributes = this._getAttributesChain(policyAttributes);
		const schemaBaseAttribute = policyAttributes.filter((attr) => attr.targetedSchema.includes(schemaName) || attr.targetedSchema.length < 1);
		if (schemaBaseAttribute.length < 1) return next();
		const schemaAttributes = this._getSchemaRelatedAttributes(schemaBaseAttribute, policyAttributes);

		const schemas = Schema.decode(req.authApp.__schema).filter((s) => s.type === 'collection');
		const schemaNames = schemas.map((s) => s.name);
		const schema = schemas.find((s) => s.name === schemaName);
		if (!schema) return next();

		const passedDisposition = await AccessControlDisposition.accessControlDisposition(req, schemaAttributes);

		if (!passedDisposition) {
			Logging.logTimer(`_accessControlPolicy:disposition-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Access control policy disposition not allowed'});
			return;
		}

		AccessControlConditions.setAppShortId(req.authApp._id);
		const accessControlAuthorisation = await AccessControlConditions.applyAccessControlPolicyConditions(req, schemaAttributes);
		if (!accessControlAuthorisation) {
			Logging.logTimer(`_accessControlPolicy:conditions-not-fulfilled`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Access control policy conditions are not fulfilled'});
			return;
		}

		const passedAccessControlPolicy = await AccessControlFilter.addAccessControlPolicyQuery(req, schemaAttributes, schema);
		if (!passedAccessControlPolicy) {
			Logging.logTimer(`_accessControlPolicy:access-control-properties-permission-error`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).send({message: 'Can not access properties without privileged access'});
			return;
		}
		await AccessControlFilter.applyAccessControlPolicyQuery(req);

		await this._queueAttributeCloseSocketEvent(schemaAttributes, schemaNames);

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
	 * @param {Array} attributes
	 * @param {Array} tokenAttributes
	 * @param {Array} attrs
	 * @return {Array}
	 */
	_getSchemaRelatedAttributes(attributes, tokenAttributes, attrs = []) {
		const attributeIds = attributes.map((attr) => attr._id);

		attributes.forEach((attr) => {
			if (attr.extends.length > 1) {
				attr.extends.forEach((extendedAttr) => {
					const extendedAttribute = tokenAttributes.find((attr) => attr.name === extendedAttr && !attributeIds.includes(attr._id));

					if (!extendedAttribute) return;

					attrs.push(extendedAttribute);
				});
			}

			attrs.push(attr);
		});

		if (attrs.some((attr) => attr.override)) {
			attrs = attrs.filter((attr) => attr.override);
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

		await this.__getAttributes();

		await this._attributes.reduce(async (prev, attribute) => {
			await prev;
			channels.push(attribute.name);
		}, Promise.resolve());

		return channels;
	}

	async getAttributesChainForToken(tokenAttribute) {
		await this.__getAttributes();
		return await this._getAttributesChain(tokenAttribute);
	}

	async __getAttributes() {
		// if (this._attributes.length > 0) return;

		const attributes = [];
		const rxsAttributes = Model.Attributes.findAll();
		for await (const attribute of rxsAttributes) {
			attributes.push(attribute);
		}

		this._attributes = attributes;
	}

	async __getPolicyAttributes(user) {
		const policies = [];
		// TODO: Rein in this in so it only gets poilices that could match user
		const rxsPolicies = Model.Policy.findAll();
		for await (const policy of rxsPolicies) {
			policies.push(policy);
		}

		return await AccessControlPolicyMatch.__getUserPolicies(policies, user);
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
