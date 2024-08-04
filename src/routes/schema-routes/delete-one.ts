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
 * @class DeleteOne
 */
export default class DeleteOne extends Route {
	constructor(schema, appShort, services) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}/:id`, `DELETE ${schema.name}`, services);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE ${schema.name}`;
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

	async _validate(req, res, token) {
		const entity = await this.model.findById(req.params.id)
		if (!entity) {
			throw new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid ID`);
		}

		return entity;
	}

	async _exec(req, res, entity) {
		await this.model.rm(entity.id);
		return true;
	}
};
