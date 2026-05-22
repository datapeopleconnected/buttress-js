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

import Route from '../route.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';

import { BjsQuery, QueryParams } from '../../types/bjs-query.js';

interface validateResult {
  queryParams: QueryParams<object>;
  actualCount: boolean;
}

/**
 * @class Count
 */
export default class SearchCount extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}/count`, `COUNT ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.SEARCH;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.activityDescription = `COUNT ${schema.name}`;
    this.activityBroadcast = false;
  }

  override async _validate(req: Request, _res: Response) {
    const model = await this.routeModel();

    const result: validateResult = {
      queryParams: {
        query: {},
      },
      actualCount: false,
    };

    let query: BjsQuery<object> = {};

    if (!query.$and) {
      query.$and = [];
    }

    if (req.body?.actualCount) {
      result.actualCount = true;
    }

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body?.query) {
      query.$and.push(req.body.query);
    } else if (req.body && !req.body.query) {
      query.$and.push(req.body);
    }

    query = model.parseQuery(query, {}, model.flatSchemaData);
    result.queryParams.query = query;
    return result;
  }

  override async _exec(req: Request, _res: Response, validateResult: validateResult) {
    const model = await this.routeModel();
    return ACM.count(model, validateResult.queryParams, req.context.ac, validateResult.actualCount);
  }
}
