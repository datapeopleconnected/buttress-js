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
 * @class DeleteMany
 */
module.exports = class DeleteMany extends Route {
	constructor(schema, appShort, nrp) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}/bulk/delete`, `BULK DELETE ${schema.name}`, nrp);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `BULK DELETE ${schema.name}`;
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
		return new Promise((resolve, reject) => {
			let ids = req.body;

			if (!ids) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `Requires ids`));
			}
			if (!ids.length) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `Expecting array of ids`));
			}

			try {
				ids = ids.map((id) => this.model.createId(id));
			} catch (err) {
				return reject(new Helpers.Errors.RequestError(400, `All ids must be string of 12 bytes or a string of 24 hex characters`));
			}

			// if (this._ids.length > 600) {
			//   this.log('ERROR: No more than 300 company IDs are supported', Route.LogLevel.ERR);
			//   reject({statusCode: 400, message: 'ERROR: No more than 300 company IDs are supported'});
			//   return;
			// }
			resolve(ids);
		});
	}

	_exec(req, res, ids) {
		return this.model.rmBulk(ids)
			.then(() => true);
	}
};
