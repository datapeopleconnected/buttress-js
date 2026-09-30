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
import { Response } from 'express';

import Route from '../route.js';
import { takenIdError, findBatchProblem, refuseEntitiesOutsidePolicy } from './add-many.js';
import { invalidEntityError } from '../../model/shared.js';
import * as Helpers from '../../helpers/index.js';
import Plugins from '../../plugins/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';
import type { RequestWithBody } from '../../types/routes.js';

/**
 * @class AddOne
 */
export default class AddOne extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}`, `ADD ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();

    this.verb = Route.Constants.Verbs.POST;
    this.permissions = Route.Constants.Permissions.ADD;

    this.activityDescription = `ADD ${schema.name}`;
    this.activityBroadcast = true;
  }

  override async _validate(req: RequestWithBody<unknown>, _res: Response) {
    const model = await this.routeModel();

    // An array of entities is stored as bulk/add stores it, so it's checked in the same way.
    if (Array.isArray(req.body)) {
      const problem = await findBatchProblem(model, req.body, this.schemaName);
      if (problem) {
        this.log(problem.message, Route.LogLevel.ERR, req.context.id);
        throw problem;
      }
      refuseEntitiesOutsidePolicy(model, req.body, req.context.ac, this.schemaName);
      return true;
    }

    const validation = model.validate(req.body);
    if (!validation.isValid) {
      const err = invalidEntityError(this.schemaName, validation);
      this.log(err.message, Route.LogLevel.ERR, req.context.id);
      throw err;
    }

    refuseEntitiesOutsidePolicy(model, [req.body], req.context.ac, this.schemaName);

    const isDuplicate = await model.isDuplicate(req.body);
    if (isDuplicate === true) {
      this.log(`${this.schemaName}: Duplicate entity`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('duplicate');
    }

    return true;
  }

  override async _exec(req: RequestWithBody<unknown>, _res: Response, _validate: boolean) {
    const model = await this.routeModel();
    let result;
    try {
      result = await model.add(req.body);
    } catch (err) {
      // The id was taken by another request after the duplicate check.
      if (!(err instanceof Helpers.Errors.DuplicateIdError)) throw err;
      if (Array.isArray(req.body)) {
        const problem = takenIdError(err, req.body, this.schemaName);
        this.log(problem.message, Route.LogLevel.ERR, req.context.id);
        throw problem;
      }
      this.log(`${this.schemaName}: Duplicate entity`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('duplicate');
    }
    return await Plugins.apply_filters('schemaRoutes:addOne:exec', result, model.schemaData);
  }
}
