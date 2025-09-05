/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

/**
 * @class DeleteOne
 */
export default class DeleteOne extends Route {
	constructor(schema: Schema, app: App, services: Services) {
		const schemaRoutePath = modelToRoute(schema.name);

		super(`${schemaRoutePath}/:id`, `DELETE ${schema.name}`, services, schema, app);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE ${schema.name}`;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const entity = await (await this.routeModel()).findById(req.params.id)
		if (!entity) {
			throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid ID`);
		}

		return entity;
	}

	async _exec(req, res, entity) {
		await (await this.routeModel()).rm(entity.id);
		return true;
	}
};
