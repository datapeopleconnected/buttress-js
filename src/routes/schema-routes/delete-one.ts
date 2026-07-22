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
import { Response, Request } from 'express';
import { QueryParams } from '../../types/bjs-query.js';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';

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

  override async _validate(req: Request, _res: Response) {
    const model = await this.routeModel();

    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid ID`);
    }

    let objectId;
    try {
      objectId = model.createId(id);
    } catch (_err) {
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid ID`);
    }

    const findParams: QueryParams<{ id: unknown }> = { query: { id: objectId }, limit: 1, skip: 0 };
    const rxsEntity = await ACM.find(model, findParams, req.context.ac);
    let entity;
    try {
      entity = await Helpers.streamFirst(rxsEntity);
    } catch (_err) {
      entity = null;
    }
    if (!entity) {
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid ID`);
    }

    return entity;
  }

  override async _exec(_req: Request, _res: Response, entity) {
    await (await this.routeModel()).rm(entity.id);
    return true;
  }
}
