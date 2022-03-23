/**
 * ButtressJS - Realtime datastore for software
 *
 * @file accessControl.js
 * @description A list of access control phases
 * @module routes
 * @author Chris Bates-Keegan
 *
 */

const Logging = require('../logging');
const Schema = require('../schema');
const AccessControlDisposition = require('./disposition');
const AccessControlConditions = require('./conditions');
const AccessControlFilter = require('./filter');

class AccessControl {
	constructor() {
		this._attributeCloseSocketEvents = [];
	}

	/**
	 * Check access control policy before granting access to the data
	 * @param {Object} req - Request object
	 * @param {Object} res - Response object
	 * @param {Function} next - next handler function
	 * @param {Array} attributes - app attributes
	 * @return {Void}
	 * @private
	 */
	async accessControlPolicy(req, res, next, attributes) {
		// access control policy
		const authUser = req.authUser;

		// TODO: better way to figure out the requested schema
		let requestedURL = req.originalUrl || req.url;
		requestedURL = requestedURL.split('?').shift();
		const schemaName = requestedURL.split('v1/').pop().split('/').shift();

		let userAttributes = null;

		if (authUser) {
			userAttributes = authUser._attribute;
		}

		if (!userAttributes) return next();

		userAttributes = this._getAttributesChain(attributes, userAttributes);

		const schemaBaseAttribute = userAttributes.filter((attr) => attr.targettedSchema.includes(schemaName) || attr.targettedSchema.length < 1);
		if (schemaBaseAttribute.length < 1) return next();
		const schemaAttributes = this._getSchemaRelatedAttributes(schemaBaseAttribute, userAttributes);

		const schemaNames = Schema.decode(req.authApp.__schema).filter((s) => s.type === 'collection').map((s) => s.name);
		const schema = schemaNames.some((n) => n === schemaName);
		if (!schema) return next();

		const passedDisposition = await AccessControlDisposition.accessControlDisposition(req, schemaAttributes);

		if (!passedDisposition) {
			Logging.logTimer(`_accessControlPolicy:disposition-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).json({message: 'Access control policy disposition not allowed'});
			return;
		}

		AccessControlConditions.setAppShortId(req.authApp._id);
		const accessControlAuthorisation = await AccessControlConditions.applyAccessControlPolicyConditions(req, schemaAttributes);
		if (!accessControlAuthorisation) {
			Logging.logTimer(`_accessControlPolicy:conditions-not-fulfilled`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).json({message: 'Access control policy conditions are not fulfilled'});
			return;
		}

		const passedAccessControlPolicy = await AccessControlFilter.addAccessControlPolicyQuery(req, schemaAttributes, schema);
		if (!passedAccessControlPolicy) {
			Logging.logTimer(`_accessControlPolicy:access-control-properties-permission-error`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).json({message: 'Can not edit properties without privileged access'});
			return;
		}
		await AccessControlFilter.applyAccessControlPolicyQuery(req);

		await this._queueAttributeCloseSocketEvent(schemaAttributes);

		next();
	}

	/**
	 * lookup attributes and fetch user attributes chain
	 * @param {Array} appAttributes
	 * @param {Array} attributeNames
	 * @param {Array} attributes
	 * @return {Array} attributes
	 */
	_getAttributesChain(appAttributes, attributeNames, attributes = []) {
		const attrs = appAttributes.filter((attr) => attributeNames.includes(attr.name));
		attributes = attrs.concat(attributes);

		const extendedAttributes = attrs.reduce((arr, attr) => {
			attr.extends.forEach((a) => {
				if (arr.includes(a)) return;

				arr.push(a);
			});

			return arr;
		}, []);

		if (extendedAttributes.length > 0) {
			return this._getAttributesChain(appAttributes, extendedAttributes, attributes);
		}

		return attributes;
	}

	/**
	 * Fetch schema related attributes from the user attributes
	 * @param {Array} attributes
	 * @param {Array} userAttributes
	 * @param {Array} attrs
	 * @return {Array}
	 */
	_getSchemaRelatedAttributes(attributes, userAttributes, attrs = []) {
		const attributeIds = attributes.map((attr) => attr._id);

		attributes.forEach((attr) => {
			if (attr.extends.length > 1) {
				attr.extends.forEach((extendedAttr) => {
					const extendedAttribute = userAttributes.find((attr) => attr.name === extendedAttr && !attributeIds.includes(attr._id));

					if (!extendedAttribute) return;

					attrs.push(extendedAttribute);
				});
			}

			attrs.push(attr);
		});

		return attrs;
	}

	async _queueAttributeCloseSocketEvent(attributes) {
		const room = attributes.map((attr) => attr.name).join(',');
		const attributeIdx = this._attributeCloseSocketEvents.findIndex((event) => event === room);
		if (attributeIdx !== -1) return;

		const prioritisedConditions = await AccessControlConditions.__prioritiseConditionOrder(attributes);
		await prioritisedConditions.reduce(async (prev, attribute) => {
			await prev;
			await this._queueEvent(attribute);
		}, Promise.resolve());

		this._attributeCloseSocketEvents.push(room);
	}

	async _queueEvent(attribute) {
		const envVars = attribute.environmentVar;
		const conditions = attribute.condition;
		// just for now only for time and date condition
		const isTimeCondition = await AccessControlConditions.isAttributeTimeConditioned(conditions);
		console.log('isTimeCondition event', isTimeCondition);
		// const timeout = 
		// setTimeout(() => {
			
		// }, );
	}
}
module.exports = new AccessControl();
