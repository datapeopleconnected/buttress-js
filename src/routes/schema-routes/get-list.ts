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
import * as Helpers from '../../helpers';
import Logging from '../../helpers/logging';
import Schema from '../../schema';

/**
 * @class GetList
 */
export default class GetList extends Route {
	constructor(schema, appShort, services) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}`, `GET ${schema.name} LIST`, services);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.LIST;

		this.activityDescription = `GET ${schema.name} LIST`;
		this.activityBroadcast = false;

		let schemaCollection = schema.name;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.name}`;
		}

		this.slowLogging = false;

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		Logging.logSilly(`Created route: ${this.name} for ${schemaCollection}`);

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`${this.name} missing model ${schemaCollection}`);
		}
	}

	async _validate(req, res, token) {
		Logging.logTimer(`${this.name}:_validate:start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		const result = {
			query: {},
			project: (req.body && req.body.project)? req.body.project : false,
		};

		let query: any = {};
		if (!query.$and) {
			query.$and = [];
		}

		// access control query
		if (req.body && req.body.query) {
			query.$and.push(req.body.query);
		}

		if (req.body && req.body.query && req.body.query.zeroResults) {
			return false;
		}

		Logging.logTimer(`${this.name}:_validate:end`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		query = this.model.parseQuery(query, {}, this.model.flatSchemaData);

		result.query = query;
		return result;
	}

	_exec(req, res, validateResult) {
		if (validateResult.query === false) {
			return [];
		}

		Logging.logTimer(`${this.name}:_exec:start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		return this.model.find(validateResult.query, {}, 0, 0, {}, validateResult.project);
	}
};
