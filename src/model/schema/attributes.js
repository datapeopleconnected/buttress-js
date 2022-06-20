'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
 *
 * This file is part of Buttress.
 * Buttress is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public Licence as published by the Free Software
 * Foundation, either version 3 of the Licence, or (at your option) any later version.
 * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public Licence for more details.
 * You should have received a copy of the GNU Affero General Public Licence along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */

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
				targetedSchema: {
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
				overrideConfiguration: {
					override: {
						__type: 'boolean',
						__required: true,
						__default: false,
						__allowUpdate: true,
					},
					limit: {
						__type: 'date',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
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
			targetedSchema: (body.attribute.targetedSchema)? body.attribute.targetedSchema : [],
			env: (body.attribute.env)? body.attribute.env : {},
			conditions: (body.attribute.conditions)? body.attribute.conditions : {},
			query: (body.attribute.query)? body.attribute.query : {},
			overrideConfiguration: body.attribute.overrideConfiguration,
		};

		const rxsAttribute = await super.add(attributeBody, {
			_appId: body.appId,
		});
		const attribute = await Helpers.streamFirst(rxsAttribute);

		// NOT needed for now
		// nrp.emit('app-routes:bust-attribute-cache', {appId: attribute.appId});

		return attribute;
	}
}

/**
 * Exports
 */
module.exports = AttributeSchemaModel;
