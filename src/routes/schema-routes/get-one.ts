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
import { BjsQuery } from '../../types/bjs-query.js';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

/**
 * @class GetOne
 */
export default class GetOne extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}/:id`, `GET ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.GET;
    this.permissions = Route.Constants.Permissions.READ;

    this.activityDescription = `GET ${schema.name}`;
    this.activityBroadcast = false;
  }

  override async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`${this.schemaName}: Missing ID`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, 'missing_id');
    }

    const model = await this.routeModel();

    let objectId = null;
    // const project = req.body && req.body.project ? req.body.project : false;

    try {
      objectId = model.createId(id);
    } catch (_err) {
      this.log(`${this.schemaName}: Invalid ID: ${id}`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, 'invalid_id');
    }

    const query: BjsQuery<{ id: string | null }> = { id: objectId };
    // if (req.body.query && Object.keys(req.body.query).length > 0) {
    //   query = model.parseQuery(req.body.query, {}, model.flatSchemaData);
    //   query.id = objectId;
    // }

    return {
      query,
      project: false,
    };
  }

  override async _exec(
    req: Request,
    _res: Response,
    validate: { query: BjsQuery<{ id: string | null }>; project: boolean },
  ) {
    const model = await this.routeModel();

    const rxsEntity = await model.find(validate.query, {}, 1, 0, null, validate.project);
    const entity = await Helpers.streamFirst(rxsEntity);

    if (!entity) {
      this.log(`${this.schemaName}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, 'invalid_id or access_control_not_fullfilled');
    }

    return entity;
  }
}
