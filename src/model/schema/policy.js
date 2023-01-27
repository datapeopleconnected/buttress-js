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

const Model = require('../');
const SchemaModel = require('../schemaModel');
const Helpers = require('../../helpers');

class PolicySchemaModel extends SchemaModel {
	constructor() {
		const schema = PolicySchemaModel.Schema;
		super(schema, null);
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
	 * @param {Object} req - request object
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with policy Object when the database request is completed
	 */
	async add(req, body) {
		const policyConfig = [];
		if (body.policy.config) {
			body.policy.config.forEach((item) => {
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
			id: (body.policy.id) ? this.createId(body.policy.id) : this.createId(),
			name: (body.policy.name) ? body.policy.name : null,
			merge: (body.policy.merge) ? body.policy.merge : false,
			priority: (body.policy.priority) ? body.policy.priority : 0,
			selection: (body.policy.selection) ? body.policy.selection : [],
			config: policyConfig,
			limit: (body.policy.limit) ? Sugar.Date.create(body.policy.limit) : null,
		};

		let appId = Model?.authApp?._id;
		if (!appId) {
			const token = await this._getToken(req);
			if (token && token._app) {
				appId = token._app;
			}
			if (token && token._lambda) {
				const lambda = await Model.Lambda.findById(token._lambda);
				appId = lambda._appId;
			}
			if (token && token._user) {
				const user = await Model.Lambda.findById(token._lambda);
				[appId] = user.apps;
			}
		}
		const rxsPolicy = await super.add(policyBody, {
			_appId: appId,
		});
		const policy = await Helpers.streamFirst(rxsPolicy);

		return policy;
	}
}

/**
 * Exports
 */
module.exports = PolicySchemaModel;
