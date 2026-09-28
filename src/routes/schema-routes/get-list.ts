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
import Logging from '../../helpers/logging.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';
import { BjsQuery, QueryParams } from '../../types/bjs-query.js';
import type { RequestWithBody } from '../../types/routes.js';

type GetListBody = {
  query?: BjsQuery<object> & { zeroResults?: boolean };
  project?: QueryParams<object>['project'];
};

/**
 * @class GetList
 */
export default class GetList extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}`, `GET ${schema.name} LIST`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.GET;
    this.permissions = Route.Constants.Permissions.LIST;

    this.activityDescription = `GET ${schema.name} LIST`;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<GetListBody | undefined>, _res: Response) {
    const model = await this.routeModel();
    Logging.logTimer(
      `${this.name}:_validate:start`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    const result: QueryParams<object> = {
      query: {},
      project: req.body && req.body.project ? req.body.project : false,
    };
    result.query.$and = [];

    // access control query
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    }

    if (req.body && req.body.query && req.body.query.zeroResults) {
      return false;
    }

    Logging.logTimer(`${this.name}:_validate:end`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    result.query = model.parseQuery(result.query, {}, model.flatSchemaData);

    return result;
  }

  override async _exec(req: Request, _res: Response, validateResult: QueryParams<object> | false) {
    const model = await this.routeModel();
    // if (validateResult.query === false) {
    // 	return Promise.resolve([]);
    // }

    Logging.logTimer(`${this.name}:_exec:start`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    // validateResult is false for a zeroResults query, which isn't handled (see the commented out check above), so
    // it's passed on as the query params
    return ACM.find(model, validateResult as QueryParams<object>, req.context.ac);
    // return this.model.find(validateResult.query, {}, 0, 0, {}, validateResult.project);
  }
}
