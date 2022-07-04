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

const SchemaModel = require('../schemaModel');
const Helpers = require('../../helpers');

class PolicySchemaModel extends SchemaModel {
	constructor(datastore) {
		const schema = PolicySchemaModel.Schema;
		super(schema, null, datastore);
	}

	static get Schema() {
		return {
			name: 'policy',
			type: 'collection',
			extends: [],
			properties: {
				name: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				priority: {
					__type: 'number',
					__default: 0,
					__required: false,
					__allowUpdate: true,
				},
				targetedSchema: {
					__type: 'array',
					__itemtype: 'string',
					__required: false,
					__allowUpdate: true,
				},
				selection: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				config: {
					__type: 'array',
					__allowUpdate: true,
					__schema: {
						endpoints: {
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
						properties: {
							__type: 'array',
							__itemtype: 'string',
							__required: true,
							__allowUpdate: true,
						},
						query: {
							__type: 'object',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
					},
				},
				optionalCondition: {
					__type: 'boolean',
					__required: false,
					__default: false,
					__allowUpdate: true,
				},
				override: {
					__type: 'boolean',
					__required: false,
					__default: false,
					__allowUpdate: true,
				},
				limit: {
					__type: 'date',
					__default: null,
					__required: false,
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
	 * @return {Promise} - fulfilled with policy Object when the database request is completed
	 */
	async add(body) {
		const policyConfig = [];
		if (body.policy.config) {
			body.policy.config.forEach((item) => {
				policyConfig.push({
					endpoints: (item.endpoints) ? item.endpoints : [],
					env: (item.env) ? item.env : null,
					conditions: (item.conditions) ? item.conditions : null,
					properties: (item.properties) ? item.properties : [],
					query: (item.query) ? item.query : null,
				});
			});
		}

		const policyBody = {
			id: (body.policy.id) ? this.createId(body.policy.id) : this.createId(),
			name: (body.policy.name) ? body.policy.name : null,
			priority: (body.policy.priority) ? body.policy.priority : 0,
			targetedSchema: (body.policy.targetedSchema) ? body.policy.targetedSchema : [],
			selection: (body.policy.selection) ? body.policy.selection : [],
			config: policyConfig,
			optionalCondition: (body.policy.optionalCondition) ? body.policy.optionalCondition : false,
			override: (body.policy.override) ? body.policy.override : false,
			limit: (body.policy.limit) ? body.policy.limit : null,
		};

		const rxsPolicy = await super.add(policyBody, {
			_appId: body.appId,
		});
		const policy = await Helpers.streamFirst(rxsPolicy);

		return policy;
	}
}

/**
 * Exports
 */
module.exports = PolicySchemaModel;
