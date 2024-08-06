'use strict'; // eslint-disable-line max-lines

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
import Route from '../route';
import Model from '../../model';

const routes: (typeof Route)[] = [];

/**
 * @class SearchDeploymentList
 */
class SearchDeploymentList extends Route {
	constructor(services) {
		super('deployment', 'SEARCH DEPLOYMENT LIST', services, Model.getModel('Deployment'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	async _validate(req, res, token) {
		const result: {
			query: {
				$and: any[],
			},
		} = {
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
routes.push(SearchDeploymentList);

/**
 * @class DeploymentCount
 */
class DeploymentCount extends Route {
	constructor(services) {
		super(`deployment/count`, `COUNT DEPLOYMENTS`, services, Model.getModel('Deployment'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT DEPLOYMENTS`;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		const result = {
			query: {},
		};

		let query: {
			$and?: any[],
		} = {};

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
routes.push(DeploymentCount);

/**
 * @type {*[]}
 */
export default routes;
