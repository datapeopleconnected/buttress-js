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
 * @class GetOne
 */
module.exports = class GetOne extends Route {
	constructor(schema: any, appShort: string, services: any) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}/:id`, `GET ${schema.name}`, services);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;

		this.activityDescription = `GET ${schema.name}`;
		this.activityBroadcast = false;

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
		let objectId = null;
		const project = (req.body && req.body.project)? req.body.project : false;

		try {
			objectId = this.model.createId(req.params.id);
		} catch (err) {
			this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, 'invalid_id');
		}

		let query = {id: objectId};
		if (req.body.query && Object.keys(req.body.query).length > 0) {
			query = req.body.query;

			query = this.model.parseQuery(query, {}, this.model.flatSchemaData);
			query.id = objectId;
		}

		return {
			query,
			project,
		};
	}

	async _exec(req, res, validate) {
		const rxsEntity = await this.model.find(validate.query, {}, 1, 0, null, validate.project);
		const entity = await Helpers.streamFirst(rxsEntity);

		if (!entity) {
			this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, 'invalid_id or access_control_not_fullfilled');
		}

		return entity;
	}
};
