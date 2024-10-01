/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
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
import Sugar from '../../helpers/sugar';
import StandardModel from '../type/standard';
import * as Helpers from '../../helpers';


interface PolicyEnvQuery {
	collection: string;
	type: string;
	query: any;
	output: {
		key: string;
		type: string;
	}
}
export interface PolicyEnv {
	[key: string]: string | PolicyEnvQuery;
}

export interface PolicySelection {
	[key: string]: {[key: string]: string};
}

export interface PolicyQuery {
	[key: string]: any;
}

export interface PolicyCondition {
	[key: string]: any;
}

export interface PolicyProjection {
	[key: string]: any;
}

export interface PolicyConfig {
	verbs: string[];
	endpoints: string[];
	schema: string[]
	env: PolicyEnv | null;
	condition: PolicyCondition | null;
	query: PolicyQuery | null;
	projection: PolicyProjection | null;
}
export interface Policy {
	id: string;
	name: string;
	priority: number;
	selection: PolicySelection | null;
	env: PolicyEnv | null;
	config: PolicyConfig[];
	limit: Date | null;
	_appId: string;
}

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
				env: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				config: {
					__type: 'array',
					__allowUpdate: true,
					__schema: {
						verbs: {
							__type: 'array',
							__itemtype: 'string',
							__required: true,
							__allowUpdate: true,
						},
						endpoints: {
							__type: 'array',
							__itemtype: 'string',
							__required: true,
							__allowUpdate: true,
						},
						schema: {
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
						condition: {
							__type: 'object',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
						projection: {
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
		const policyConfig: any[] = [];
		if (body.config) {
			body.config.forEach((item) => {
				policyConfig.push({
					verbs: (item.verbs) ? item.verbs : [],
					endpoints: (item.endpoints) ? item.endpoints : [],
					schema: (item.schema) ? item.schema : [],
					env: (item.env) ? item.env : null,
					condition: (item.condition) ? item.condition : null,
					projection: (item.projection) ? item.projection : null,
					query: (item.query) ? item.query : null,
				});
			});
		}

		const policyBody = {
			id: (body.id) ? this.createId(body.id) : this.createId(),
			name: (body.name) ? body.name : null,
			priority: (body.priority) ? body.priority : 0,
			selection: (body.selection) ? body.selection : {},
			env: (body.env) ? body.env : {},
			config: policyConfig,
			limit: (body.limit) ? Sugar.Date.create(body.limit) : null,
		};

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
export default PolicySchemaModel;
