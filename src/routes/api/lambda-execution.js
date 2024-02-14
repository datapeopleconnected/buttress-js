'use strict'; // eslint-disable-line max-lines

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

const ObjectId = require('mongodb').ObjectId;

const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');

const routes = [];


/**
 * @class GetLambdaExecution
 */
class GetLambdaExecution extends Route {
	constructor(nrp) {
		super('lambda-execution/:id', 'GET LAMBDA EXECUTION', nrp, Model.LambdaExecution);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const id = req.params.id;
		if (!id) {
			this.log(`[${this.name}] Missing required lambda execution id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_execution_id`));
		}
		if (!ObjectId.isValid(id)) {
			this.log(`[${this.name}] Invalid lambda execution id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_execution_id`));
		}

		const lambdaExecution = await this.model.findById(id);
		if (!lambdaExecution) {
			this.log(`[${this.name}] Cannot find a lambda execution with id id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `lambda_execution_does_not_exist`));
		}

		return lambdaExecution;
	}

	_exec(req, res, lambdaExecution) {
		return lambdaExecution;
	}
}
routes.push(GetLambdaExecution);

/**
 * @class UpdateLambdaExecution
 */
class UpdateLambdaExecution extends Route {
	constructor(nrp) {
		super('lambda-execution/:id', 'UPDATE LAMBDA EXECUTION', nrp, Model.LambdaExecution);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const {validation, body} = this.model.validateUpdate(req.body);
			req.body = body;

			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `LAMBDA EXECUTION: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `LAMBDA EXECUTION: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			this.model.exists(req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid LAMBDA EXECUTION ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});
		});
	}

	async _exec(req, res, validate) {
		return this.model.updateByPath(req.body, req.params.id, null, 'LambdaExecution');
	}
}
routes.push(UpdateLambdaExecution);

/**
 * @class SearchExecutionList
 */
class SearchExecutionList extends Route {
	constructor(services) {
		super('lambda-execution', 'SEARCH LAMBDA EXECUTION LIST', services, Model.LambdaExecution);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		const result = {
			query: {
				$and: [],
			},
		};

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = this.model.parseQuery(result.query, {}, this.model.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return this.model.find(validate.query);
	}
}
routes.push(SearchExecutionList);

/**
 * @class LambdaExecutionCount
 */
class LambdaExecutionCount extends Route {
	constructor(nrp) {
		super(`lambda-execution/count`, `COUNT LAMBDA EXECUTION`, nrp, Model.LambdaExecution);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT LAMBDA EXECUTION`;
		this.activityBroadcast = false;
	}

	_validate(req, res, token) {
		const result = {
			query: {},
		};

		let query = {};

		if (!query.$and) {
			query.$and = [];
		}

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			query.$and.push(req.body.query);
		} else if (req.body && !req.body.query) {
			query.$and.push(req.body);
		}

		query = this.model.parseQuery(query, {}, this.model.flatSchemaData);
		result.query = query;
		return result;
	}

	_exec(req, res, validateResult) {
		return this.model.count(validateResult.query);
	}
}
routes.push(LambdaExecutionCount);

/**
 * @type {*[]}
 */
module.exports = routes;
