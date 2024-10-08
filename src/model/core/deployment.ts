'use strict';

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
import StandardModel from '../type/standard';
import * as Helpers from '../../helpers';

class DeploymentSchemaModel extends StandardModel {
	constructor(services) {
		const schema = DeploymentSchemaModel.Schema;
		super(schema, null, services);
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
	 * @param {string} appId - the appId the deployment blongs to
	 * @return {Promise} - fulfilled with lambda Object when the database request is completed
	 */
	async add(body, appId) {
		const deploymentBody = {
			lambdaId: (body.lambdaId) ? body.lambdaId : null,
			hash: (body.hash) ? body.hash : null,
			branch: (body.branch) ? body.branch : null,
		};

		const rxsDeployment = await super.add(deploymentBody, {
			_appId: appId,
		});
		const deployment = await Helpers.streamFirst(rxsDeployment);

		return deployment;
	}
}

/**
 * Exports
 */
export default DeploymentSchemaModel;
