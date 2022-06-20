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
			collection: 'policy',
			extends: [],
			properties: {
				selection: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				attributes: {
					__type: 'array',
					__itemtype: 'string',
					__required: true,
					__allowUpdate: true,
				},
			},
		};
	}


	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with policy Object when the database request is completed
	 */
	async add(body) {
		const policyBody = {
			id: this.createId(),
			selection: (body.policy.selection)? body.policy.selection : [],
			attributes: (body.policy.attributes)? body.policy.attributes : {},
		};

		const rxsAttribute = await super.add(policyBody, {
			_appId: body.appId,
		});
		const attribute = await Helpers.streamFirst(rxsAttribute);

		return attribute;
	}
}

/**
 * Exports
 */
module.exports = PolicySchemaModel;
