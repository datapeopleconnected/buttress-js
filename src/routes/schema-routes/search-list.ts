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
import * as Helpers from '../../helpers/index.js';

import * as ACM from '../../access-control/models-access.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';
import { BjsQuery, QueryParams } from '../../types/bjs-query.js';
import type { RequestWithBody, SearchListBody } from '../../types/routes.js';

/**
 * @class SearchList
 */
export default class SearchList extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}`, `SEARCH ${schema.name} LIST`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.QUERY;
    this.permissions = Route.Constants.Permissions.LIST;

    this.activityDescription = `SEARCH ${schema.name} LIST`;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<SearchListBody<object> | undefined>, _res: Response) {
    // The search options are read off the body, and an array has a sort method of its own
    if (Array.isArray(req.body)) throw Helpers.Errors.badRequest('invalid_body');

    const model = await this.routeModel();

    const result: QueryParams<object> = {
      query: {},
      ...Helpers.searchPaging(req.body),
      sort: req.body && req.body.sort ? req.body.sort : {},
      project: req.body && req.body.project ? req.body.project : false,
    };

    let query: BjsQuery<object> = {};

    if (!query.$and) {
      query.$and = [];
    }

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      query.$and.push(req.body.query);
    }

    query = model.parseQuery(query, {}, model.flatSchemaData);

    result.query = query;
    return result;
  }

  override async _exec(req: Request, _res: Response, validateResult: QueryParams<object>) {
    const model = await this.routeModel();

    return ACM.find(model, validateResult, req.context.ac);
  }
}
