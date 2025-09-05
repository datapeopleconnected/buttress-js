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
 * @class DeleteMany
 */
export default class DeleteMany extends Route {
	constructor(schema: Schema, app: App, services: Services) {
		const schemaRoutePath = modelToRoute(schema.name);

		super(`${schemaRoutePath}/bulk/delete`, `BULK DELETE ${schema.name}`, services, schema, app);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `BULK DELETE ${schema.name}`;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const model = await this.routeModel();
		let ids = req.body;

		if (!ids) {
			this.log(`ERROR: No ${this.schemaName} IDs provided`, Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, `Requires ids`);
		}
		if (!ids.length) {
			this.log(`ERROR: No ${this.schemaName} IDs provided`, Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, `Expecting array of ids`);
		}

		try {
			ids = ids.map((id) => model.createId(id));
		} catch (err) {
			throw new Helpers.Errors.RequestError(400, `All ids must be string of 12 bytes or a string of 24 hex characters`);
		}

		// if (this._ids.length > 600) {
		//   this.log('ERROR: No more than 300 company IDs are supported', Route.LogLevel.ERR);
		//   reject({statusCode: 400, message: 'ERROR: No more than 300 company IDs are supported'});
		//   return;
		// }
		return ids;
	}

	async _exec(req, res, ids) {
		await (await this.routeModel()).rmBulk(ids);
		return true;
		
	}
};
