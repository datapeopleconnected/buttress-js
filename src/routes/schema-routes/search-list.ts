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
import { QueryParams } from '../../types/bjs-query.js';

/**
 * @class SearchList
 */
export default class SearchList extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}`, `SEARCH ${schema.name} LIST`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.SEARCH;
    this.permissions = Route.Constants.Permissions.LIST;

    this.activityDescription = `SEARCH ${schema.name} LIST`;
    this.activityBroadcast = false;
  }

  async _validate(req: Request, _res: Response) {
    const model = await this.routeModel();

    const result = {
      query: {},
      skip: req.body && req.body.skip ? parseInt(req.body.skip) : 0,
      limit: req.body && req.body.limit ? parseInt(req.body.limit) : 0,
      sort: req.body && req.body.sort ? req.body.sort : {},
      project: req.body && req.body.project ? req.body.project : false,
    };

    if (isNaN(result.skip)) throw new Helpers.Errors.RequestError(400, `invalid_value_skip`);
    if (isNaN(result.limit)) throw new Helpers.Errors.RequestError(400, `invalid_value_limit`);

    let query: any = {};

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

  async _exec(req: Request, _res: Response, validateResult: QueryParams<object>) {
    const model = await this.routeModel();

    return ACM.find(model, validateResult, req.context.ac);
  }
}
