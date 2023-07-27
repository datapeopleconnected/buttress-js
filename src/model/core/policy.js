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
const Sugar = require('sugar');

const StandardModel = require('../type/standard');
const Helpers = require('../../helpers');

class PolicySchemaModel extends StandardModel {
	constructor(services) {
		const schema = PolicySchemaModel.Schema;
		super(schema, null, services);
	}

	static get Schema() {
		return {
			name: 'policy',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				name: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				merge: {
					__type: 'boolean',
					__default: false,
					__required: true,
					__allowUpdate: true,
				},
				priority: {
					__type: 'number',
					__default: 0,
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
							__type: 'array',
							__itemtype: 'object',
							__required: true,
							__allowUpdate: true,
						},
						projection: {
							__type: 'array',
							__itemtype: 'object',
							__required: true,
							__allowUpdate: true,
						},
						query: {
							__type: 'array',
							__itemtype: 'object',
							__required: true,
							__allowUpdate: true,
						},
					},
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
	 * @param {Object} body - policy object
	 * @param {String} appId - app id
	 * @return {Promise} - fulfilled with policy Object when the database request is completed
	 */
	async add(body, appId) {
		const policyConfig = [];
		if (body.config) {
			body.config.forEach((item) => {
				policyConfig.push({
					endpoints: (item.endpoints) ? item.endpoints : [],
					env: (item.env) ? item.env : null,
					conditions: (item.conditions) ? item.conditions : [],
					projection: (item.projection) ? item.projection : [],
					query: (item.query) ? item.query : [],
				});
			});
		}

		const policyBody = {
			id: (body.id) ? this.createId(body.id) : this.createId(),
			name: (body.name) ? body.name : null,
			merge: (body.merge) ? body.merge : false,
			priority: (body.priority) ? body.priority : 0,
			selection: (body.selection) ? body.selection : [],
			config: policyConfig,
			limit: (body.limit) ? Sugar.Date.create(body.limit) : null,
		};

		const rxsPolicy = await super.add(policyBody, {
			_appId: appId,
		});
		const policy = await Helpers.streamFirst(rxsPolicy);

		return policy;
	}

	/**
	 * @param {ObjectId} appId - id of the App that owns the user
	 * @param {int} token - request token
	 * @return {Promise} - resolves to an array of Apps
	 */
	findAll(appId, token) {
		if (token && token.type === this.__modelManager.Token.Constants.Type.SYSTEM) {
			return super.find({});
		}

		return super.find({_appId: appId});
	}
}

/**
 * Exports
 */
module.exports = PolicySchemaModel;
