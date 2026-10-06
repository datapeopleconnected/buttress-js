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
import { AdapterDocument } from '../../types/datastore.js';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';
import { pickWriteTarget, WriteTarget } from './write-target.js';

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
      throw Helpers.Errors.badRequest('missing_id', 'An id is required');
    }

    let objectId: string;
    try {
      objectId = model.createId(id);
    } catch (_err) {
      throw Helpers.Errors.badRequest('invalid_id', 'The id is not valid');
    }

    // The record is found within the caller's policies, in whichever source has it, and removed from there
    const findParams: QueryParams<{ id: unknown }> = { query: { id: objectId }, skip: 0 };
    const found = await Helpers.streamAll<AdapterDocument>(await ACM.find(model, findParams, req.context.ac));
    const target = pickWriteTarget(model, found, {
      appId: this._dataApp(req).id ?? '',
      schemaName: this.schemaName ?? 'entity',
      id,
    });
    // One outside the caller's policies is answered as one that doesn't exist
    if (!target) {
      throw Helpers.Errors.entityNotFound(this.schemaName ?? 'entity', id);
    }

    return target;
  }

  override async _exec(req: Request, _res: Response, { entity, via }: WriteTarget) {
    await this._keepEntitiesBeingDeleted(req, [entity.id], [entity]);
    await (await this.routeModel()).rm(entity.id, via);
    return true;
  }
}
