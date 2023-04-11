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
const SchemaModel = require('../schemaModel');
const Helpers = require('../../helpers');

class LambdaExecutionSchemaModel extends SchemaModel {
	constructor() {
		const schema = LambdaExecutionSchemaModel.Schema;
		super(schema, null);
	}

	static get Schema() {
		return {
			name: 'lambdaExecution',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				lambdaId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				deploymentId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				status: {
					__type: 'string',
					__default: 'PENDING',
					__enum: [
						'PENDING',
						'RUNNING',
						'COMPLETE',
						'ERROR',
					],
					__required: true,
					__allowUpdate: true,
				},
				logs: {
					__type: 'array',
					__allowUpdate: true,
					__schema: {
						log: {
							__type: 'string',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
						type: {
							__type: 'string',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
					},
				},
				calledAt: {
					__type: 'date',
					__default: 'now',
					__required: true,
					__allowUpdate: true,
				},
				startedAt: {
					__type: 'date',
					__default: null,
					__required: false,
					__allowUpdate: true,
				},
				endedAt: {
					__type: 'date',
					__default: null,
					__required: false,
					__allowUpdate: true,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with lambda execution Object when the database request is completed
	 */
	async add(body) {
		const executionBody = {
			lambdaId: (body.lambdaId) ? body.lambdaId : null,
			logs: (body.logs) ? body.logs : [],
			calledAt: Sugar.Date.create('now'),
		};

		const rxsExecution = await super.add(executionBody);
		const execution = await Helpers.streamFirst(rxsExecution);

		return execution;
	}
}

/**
 * Exports
 */
module.exports = LambdaExecutionSchemaModel;
