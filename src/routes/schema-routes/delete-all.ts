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
import type { AdapterDocument } from '../../types/datastore.js';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';

/**
 * @class DeleteAll
 */
export default class DeleteAll extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}`, `DELETE ALL ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.DEL;
    this.permissions = Route.Constants.Permissions.DELETE;

    this.activityDescription = `DELETE ALL ${schema.name}`;
    this.activityBroadcast = true;
  }

  // The entities the caller's policies let it delete, or null when they reach every entity in the collection.
  override async _validate(req: Request, _res: Response) {
    if (ACM.reachesEveryEntity(req.context.ac)) return null;

    const model = await this.routeModel();
    const findParams: QueryParams<object> = { query: {} };
    const rxsScoped = await ACM.find(model, findParams, req.context.ac);
    const scopedEntities = await Helpers.streamAll<AdapterDocument>(rxsScoped);

    // There's a find for each policy config, so an entity more than one of them selects comes back more than once.
    const byId = new Map(scopedEntities.map((entity) => [String(entity.id), entity]));
    return [...byId.values()];
  }

  override async _exec(req: Request, _res: Response, scopedEntities: AdapterDocument[] | null) {
    const model = await this.routeModel();

    if (!scopedEntities) {
      await model.rmAll({});
      return true;
    }

    const ids = scopedEntities.map((entity) => String(entity.id));
    if (ids.length > 0) {
      await this._keepEntitiesBeingDeleted(req, ids, scopedEntities);
      await model.rmBulk(ids);
    }
    return ids;
  }

  // Clients expect `true` in the response, but a delete limited by policy needs the deleted ids to apply the broadcast.
  override async _respond(req: Request, res: Response, _result: unknown) {
    return super._respond(req, res, true);
  }

  // A delete of every entity goes out as it is. One limited by policy names the entities it deleted, for the SPR to
  // relay as a delete of each.
  override async _broadcast(req: Request, res: Response, result: unknown, path: string, isSuper = false) {
    const deleted = Array.isArray(result) ? (result as string[]).map((id) => ({ id })) : result;
    return super._broadcast(req, res, deleted, path, isSuper);
  }
}
