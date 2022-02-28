'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file attributes.js
 * @description Attributes model definition.
 * @module Model
 * @exports AttributeSchemaModel
 * @author Tom Cahill
 */

// const ObjectId = require('mongodb').ObjectId;

const Config = require('node-env-obj')();
const NRP = require('node-redis-pubsub');
const nrp = new NRP(Config.redis);

const Helpers = require('../../helpers');
const SchemaModel = require('../schemaModel');

class AttributeSchemaModel extends SchemaModel {
	constructor(datastore) {
		const schema = AttributeSchemaModel.Schema;
		super(schema, null, datastore);
	}

	static get Schema() {
		return {
			name: 'attribute',
			type: 'collection',
			collection: 'attribute',
			extends: [
				'timestamps',
			],
			properties: {
				extends: {
					__type: 'array',
					__itemtype: 'string',
					__required: true,
					__allowUpdate: true,
				},
				name: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				disposition: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				properties: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				targettedSchema: {
					__type: 'array',
					__itemtype: 'string',
					__required: true,
					__allowUpdate: true,
				},
				env: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				conditions: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				query: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				_appId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with attribute Object when the database request is completed
	 */
	async add(body) {
		const attributeBody = {
			id: this.createId(),
			name: body.attribute.name,
			extends: (body.attribute.extends)? body.attribute.extends : [],
			disposition: (body.attribute.disposition)? body.attribute.disposition : {},
			properties: (body.attribute.properties)? body.attribute.properties : {},
			targettedSchema: (body.attribute.targettedSchema)? body.attribute.targettedSchema : [],
			env: (body.attribute.env)? body.attribute.env : {},
			conditions: (body.attribute.conditions)? body.attribute.conditions : {},
			query: (body.attribute.query)? body.attribute.query : {},
		};

		const rxsAttribute = await super.add(attributeBody, {
			_appId: body.appId,
		});
		const attribute = await Helpers.streamFirst(rxsAttribute);

		nrp.emit('app-routes:bust-attribute-cache', {appId: attribute.appId});

		return attribute;
	}
}

/**
 * Exports
 */
module.exports = AttributeSchemaModel;
