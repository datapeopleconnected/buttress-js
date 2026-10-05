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

import Route from '../route.js';
import { CoreCount, CoreGetOne, CoreRouteConfig, CoreSearch, CoreUpdateByPath } from '../core-routes.js';
import Model from '../../model/index.js';
import * as Helpers from '../../helpers/index.js';
import LambdaExecutionSchemaModel, { LambdaExecution } from '../../model/core/lambda-execution.js';
import { Services } from '../../bootstrap.js';
import { UpdatePathBody } from '../../types/datastore.js';
import type { CoreRouteClass } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

/**
 * @class GetLambdaExecution
 */
class GetLambdaExecution extends CoreGetOne<LambdaExecutionSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'lambda-execution/:id',
    name: 'GET LAMBDA EXECUTION',
    model: LambdaExecutionSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.READ,
  };
}
routes.push(GetLambdaExecution);

/**
 * @class GetLambdaExecution
 */
class GetLambdaExecutionStatus extends Route {
  constructor(services: Services) {
    super(
      'lambda-execution/:id/status',
      'GET LAMBDA EXECUTION STATUS',
      services,
      Model.getCoreModel(LambdaExecutionSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.USER;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda execution id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const lambdaExecution = await this.scoped(req, LambdaExecutionSchemaModel).findByIdOrFail(id);

    return lambdaExecution.status;
  }

  override async _exec(req: Request, res: Response, status: LambdaExecution['status']) {
    return {
      status,
    };
  }
}
routes.push(GetLambdaExecutionStatus);

/**
 * @class UpdateLambdaExecution
 */
class UpdateLambdaExecution extends CoreUpdateByPath<LambdaExecutionSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'lambda-execution/:id',
    name: 'UPDATE LAMBDA EXECUTION',
    model: LambdaExecutionSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.WRITE,
  };

  // Only a CRON execution's status can be changed. Setting an API or path-mutation execution back to
  // PENDING would run it again, with whatever its metadata now holds.
  protected override async updateProblem(req: Request, updates: UpdatePathBody[]) {
    if (!updates.some((update) => update.path === 'status')) return null;

    const execution = await this.rows(req).findByIdOrFail(this.idOf(req));
    if (execution.triggerType === 'CRON') return null;

    return Helpers.Errors.badRequest(
      'lambda_execution_status_not_updatable',
      `The status of a ${execution.triggerType} execution can't be changed`,
    );
  }
}
routes.push(UpdateLambdaExecution);

/**
 * @class SearchExecutionList
 */
class SearchExecutionList extends CoreSearch<LambdaExecutionSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'lambda-execution',
    name: 'SEARCH LAMBDA EXECUTION LIST',
    model: LambdaExecutionSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.SEARCH,
  };
}
routes.push(SearchExecutionList);

/**
 * @class LambdaExecutionCount
 */
class LambdaExecutionCount extends CoreCount<LambdaExecutionSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'lambda-execution/count',
    name: 'COUNT LAMBDA EXECUTION',
    model: LambdaExecutionSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.SEARCH,
  };
}
routes.push(LambdaExecutionCount);

/**
 * @type {*[]}
 */
export default routes;
