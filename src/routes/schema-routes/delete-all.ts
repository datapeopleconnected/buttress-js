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
import Schema from '../../schema';

/**
 * @class DeleteAll
 */
export default class DeleteAll extends Route {
	constructor(schema, appShort, nrp) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}`, `DELETE ALL ${schema.name}`, nrp);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE ALL ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.name;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.name}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`${this.name} missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return Promise.resolve();
	}

	_exec(req, res, validate) {
		return this.model.rmAll()
			.then(() => true);
	}
};
