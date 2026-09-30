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
import type { RequestWithBody } from '../../types/routes.js';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';

interface GetManyQuery {
  ids: string[];
  project: Record<string, 1 | -1> | false;
}

type GetManyBody = {
  query: { ids?: string[] };
  project?: Record<string, 1 | -1>;
};

/**
 * @class GetMany
 */
export default class GetMany extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}/bulk/load`, `BULK GET ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.SEARCH;
    this.permissions = Route.Constants.Permissions.READ;

    this.activityDescription = `BULK GET ${schema.name}`;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<GetManyBody | undefined>, _res: Response): Promise<GetManyQuery> {
    const _ids: unknown = req.body?.query?.ids;
    const project: Record<string, 1 | -1> | false = req.body?.project ? req.body.project : false;

    if (!Array.isArray(_ids) || _ids.length < 1) {
      this.log(`ERROR: No ${this.schemaName} IDs provided`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('array_required', 'Expected query.ids to be a list of ids');
    }

    const model = await this.routeModel();
    if (!_ids.every((id) => model.isValidId(id))) {
      this.log(`ERROR: Invalid ${this.schemaName} ID provided`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('invalid_id', 'The ids are not all valid');
    }

    return { ids: _ids as string[], project: project };
  }

  override async _exec(req: Request, _res: Response, query: GetManyQuery) {
    const model = await this.routeModel();
    const findParams: QueryParams<{ id: unknown }> = {
      query: { id: { $in: query.ids.map((id) => model.createId(id)) } },
      project: query.project,
    };
    return ACM.find(model, findParams, req.context.ac);
  }
}
