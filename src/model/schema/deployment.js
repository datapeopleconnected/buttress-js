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

class DeploymentSchemaModel extends SchemaModel {
	constructor(nrp) {
		const schema = DeploymentSchemaModel.Schema;
		super(schema, null, nrp);
	}

	static get Schema() {
		return {
			name: 'deployment',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				lambdaId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				hash: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				branch: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				deployedAt: {
					__type: 'date',
					__default: 'now',
					__required: true,
					__allowUpdate: true,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with lambda Object when the database request is completed
	 */
	async add(body) {
		const deploymentBody = {
			lambdaId: (body.lambdaId) ? body.lambdaId : null,
			hash: (body.hash) ? body.hash : null,
			branch: (body.branch) ? body.branch : null,
		};

		const rxsDeployment = await super.add(deploymentBody);
		const deployment = await Helpers.streamFirst(rxsDeployment);

		return deployment;
	}
}

/**
 * Exports
 */
module.exports = DeploymentSchemaModel;
