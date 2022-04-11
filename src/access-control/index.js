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
const Sugar = require('sugar');
const NRP = require('node-redis-pubsub');

const Model = require('../model');
const Logging = require('../logging');
const Schema = require('../schema');
const AccessControlDisposition = require('./disposition');
const AccessControlConditions = require('./conditions');
const AccessControlFilter = require('./filter');

const nrp = new NRP(Config.redis);

class AccessControl {
	constructor() {
		this._attributeCloseSocketEvents = [];
		this._attributes = [];

		this._oneWeekMilliseconds = Sugar.Number.day(7);
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

		await this.__getAttributes();

		userAttributes = this._getAttributesChain(userAttributes);

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
		const prioritisedConditions = await AccessControlConditions.__prioritiseConditionOrder(attributes);
		await prioritisedConditions.reduce(async (prev, attribute) => {
			await prev;

			const name = attribute.name;
			let attributeIdx = this._attributeCloseSocketEvents.findIndex((event) => event === name);
			if (attributeIdx !== -1) return;

			attributeIdx = this._attributeCloseSocketEvents.push(name);

			await this._queueEvent(attribute, attributeIdx);
		}, Promise.resolve());
	}

	async _queueEvent(attribute, idx) {
		const envVars = attribute.environmentVar;
		const conditions = attribute.condition;

		// just for now only for time and date condition
		const dateTimeBasedCondition = await AccessControlConditions.isAttributeDateTimeBased(conditions);

		if (dateTimeBasedCondition === 'time') {
			const conditionEndTime = AccessControlConditions.getEnvironmentVar(envVars, 'env.endTime');
			const timeout = Sugar.Date.range(`now`, `${conditionEndTime}`).milliseconds();
			setTimeout(() => {
				nrp.emit('accessControlPolicy:disconnectSocket', {
					id: attribute.name,
					type: 'generic',
				});
				this._attributeCloseSocketEvents.splice(idx - 1, 1);
			}, timeout);
		}

		if (dateTimeBasedCondition === 'date') {
			const conditionEndDate = AccessControlConditions.getEnvironmentVar(envVars, 'env.endDate');
			const nearlyExpired = Sugar.Number.day(Sugar.Date.create(conditionEndDate));
			if (this._oneWeekMilliseconds > nearlyExpired) {
				setTimeout(() => {
					nrp.emit('accessControlPolicy:disconnectSocket', {
						id: attribute.name,
						type: 'generic',
					});
					this._attributeCloseSocketEvents.splice(idx - 1, 1);
				}, nearlyExpired);
			}
		}
	}

	async getAttributeChannels(appId) {
		const channels = [];

		const users = await this.__getUsers(appId);

		await this.__getAttributes();

		await users.reduce(async (prev, user) => {
			await prev;
			const userAttributes = await this._getAttributesChain(user._attribute);
			channels.push(userAttributes.map((attr) => attr.name).join(','));
		}, Promise.resolve());

		return channels;
	}

	async getAttributesChainForUser(userAttribute) {
		await this.__getAttributes();
		return await this._getAttributesChain(userAttribute);
	}

	async __getUsers(appId) {
		const users = [];
		const rxsUsers = Model.User.findAll(appId);
		for await (const token of rxsUsers) {
			users.push(token);
		}

		return users;
	}

	async __getAttributes() {
		if (this._attributes.length > 0) return;

		const attributes = [];
		const rxsAttributes = Model.Attributes.findAll();
		for await (const token of rxsAttributes) {
			attributes.push(token);
		}

		this._attributes = attributes;
	}
}
module.exports = new AccessControl();
