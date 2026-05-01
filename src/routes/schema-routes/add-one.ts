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
import Plugins from '../../plugins/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

/**
 * @class AddOne
 */
export default class AddOne extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}`, `ADD ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();

    this.verb = Route.Constants.Verbs.POST;
    this.permissions = Route.Constants.Permissions.ADD;

    this.activityDescription = `ADD ${schema.name}`;
    this.activityBroadcast = true;
  }

  async _validate(req, res, token) {
    const model = await this.routeModel();
    const validation = model.validate(req.body);
    if (!validation.isValid) {
      if (validation.missing.length > 0) {
        this.log(`${this.schemaName}: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
        throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Missing field: ${validation.missing[0]}`);
      }
      if (validation.invalid.length > 0) {
        this.log(`${this.schemaName}: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
        throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid value: ${validation.invalid[0]}`);
      }

      this.log(`${this.schemaName}: Unhandled Error`, Route.LogLevel.ERR, req.id);
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Unhandled error.`);
    }

    const isDuplicate = await model.isDuplicate(req.body);
    if (isDuplicate === true) {
      this.log(`${this.schemaName}: Duplicate entity`, Route.LogLevel.ERR, req.id);
      throw new Helpers.Errors.RequestError(400, `duplicate`);
    }

    return true;
  }

  async _exec(req, res, validate) {
    const model = await this.routeModel();
    const result = await model.add(req.body);
    return await Plugins.apply_filters('schemaRoutes:addOne:exec', result, model.schemaData);
  }
}
