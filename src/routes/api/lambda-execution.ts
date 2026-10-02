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
import { CoreCount, CoreRouteConfig, CoreSearch } from '../core-routes.js';
import Model from '../../model/index.js';
import { invalidUpdateError } from '../../model/shared.js';
import * as Helpers from '../../helpers/index.js';
import LambdaExecutionSchemaModel, { LambdaExecution } from '../../model/core/lambda-execution.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import { Services } from '../../bootstrap.js';
import { UpdatePathBody } from '../../types/datastore.js';
import type { CoreRouteClass, RequestWithBody } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

/**
 * @class GetLambdaExecution
 */
class GetLambdaExecution extends Route {
  constructor(services: Services) {
    super(
      'lambda-execution/:id',
      'GET LAMBDA EXECUTION',
      services,
      Model.getCoreModel(LambdaExecutionSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda execution id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const lambdaExecution = await this.scoped(req, LambdaExecutionSchemaModel).findByIdOrFail(id);

    return lambdaExecution;
  }

  override _exec(req: Request, res: Response, lambdaExecution: LambdaExecution) {
    return lambdaExecution;
  }
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
class UpdateLambdaExecution extends Route {
  constructor(services: Services) {
    super(
      'lambda-execution/:id',
      'UPDATE LAMBDA EXECUTION',
      services,
      Model.getCoreModel(LambdaExecutionSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  override _validate(req: RequestWithBody<unknown>, _res: Response) {
    return new Promise<{ id: string }>((resolve, reject) => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const executions = this.scoped(req, LambdaExecutionSchemaModel);
      const { validation, body } = executions.validateUpdate(req.body);
      req.body = body;

      if (!validation.isValid) {
        const err = invalidUpdateError(this.schemaName, validation);
        this.log(`ERROR: ${err.message}`, Route.LogLevel.ERR);
        return reject(err);
      }

      executions
        .assertExists(id)
        .then(() => resolve({ id }))
        .catch(reject);
    });
  }

  // _validate replaced the body with the validated updates
  override async _exec(req: RequestWithBody<UpdatePathBody[]>, _res: Response, validate: { id: string }) {
    return this.scoped(req, LambdaExecutionSchemaModel).updateByPath(req.body, validate.id);
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
