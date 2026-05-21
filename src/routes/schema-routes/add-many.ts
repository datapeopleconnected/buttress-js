/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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

import { Request, Response } from 'express';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';
import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

/**
 * @class AddMany
 */
export default class AddMany extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}/bulk/add`, `BULK ADD ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();

    this.verb = Route.Constants.Verbs.POST;
    this.permissions = Route.Constants.Permissions.ADD;

    this.activityDescription = `BULK ADD ${schema.name}`;
    this.activityBroadcast = true;
  }

  async _validate(req: Request, _res: Response) {
    const model = await this.routeModel();
    const entities = req.body;
    if (entities instanceof Array === false) {
      this.log(`ERROR: You need to supply an array of ${this.schemaName}`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `array_required`);
    }
    // if (companies.length > 601) {
    //   this.log(`ERROR: No more than 300`, Route.LogLevel.ERR);
    //   reject({statusCode: 400, message: `Invalid data: send no more than 300 ${this.schemaName} at a time`});
    //   return;
    // }

    const validation = model.validate(entities);
    if (!validation.isValid) {
      if (validation.missing.length > 0) {
        this.log(`ERROR: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.context.id);
        throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Missing field: ${validation.missing[0]}`);
      }
      if (validation.invalid.length > 0) {
        this.log(`ERROR: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.context.id);
        throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid value: ${validation.invalid[0]}`);
      }

      throw new Helpers.Errors.RequestError(400, `unknown_error`);
    }
    return entities;
  }

  async _exec(_req: Request, _res: Response, entities: unknown) {
    return (await this.routeModel()).add(entities);
  }
}
