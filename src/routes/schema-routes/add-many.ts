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
 * @class AddMany
 */
export default class AddMany extends Route {
	constructor(schema, appShort, services) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}/bulk/add`, `BULK ADD ${schema.name}`, services);
		this.__configureSchemaRoute();

		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.ADD;

		this.activityDescription = `BULK ADD ${schema.name}`;
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
			const entities = req.body;
			if (entities instanceof Array === false) {
				this.log(`ERROR: You need to supply an array of ${this.schema.name}`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `array_required`));
			}
			// if (companies.length > 601) {
			//   this.log(`ERROR: No more than 300`, Route.LogLevel.ERR);
			//   reject({statusCode: 400, message: `Invalid data: send no more than 300 ${this.schema.name} at a time`});
			//   return;
			// }

			const validation = this.model.validate(entities);
			if (!validation.isValid) {
				if (validation.missing.length > 0) {
					this.log(`ERROR: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
				}
				if (validation.invalid.length > 0) {
					this.log(`ERROR: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
				}

				return reject(new Helpers.Errors.RequestError(400, `unknown_error`));
			}
			resolve(entities);
		});
	}

	_exec(req, res, entities) {
		return this.model.add(entities);
	}
};
