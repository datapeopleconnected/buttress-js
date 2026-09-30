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
import Model from '../../model/index.js';
import { invalidUpdateError } from '../../model/shared.js';
import * as Helpers from '../../helpers/index.js';
import LambdaExecutionSchemaModel, { LambdaExecution } from '../../model/core/lambda-execution.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import { QueryParams } from '../../types/bjs-query.js';
import { Services } from '../../bootstrap.js';
import { UpdatePathBody } from '../../types/datastore.js';
import type { CoreRouteClass, CountBody, RequestWithBody, SearchBody } from '../../types/routes.js';

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
class SearchExecutionList extends Route {
  constructor(services: Services) {
    super(
      'lambda-execution',
      'SEARCH LAMBDA EXECUTION LIST',
      services,
      Model.getCoreModel(LambdaExecutionSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.SEARCH;
  }

  override async _validate(req: RequestWithBody<SearchBody<LambdaExecution> | undefined>, _res: Response) {
    const result: QueryParams<LambdaExecution> = {
      query: {},
    };
    result.query.$and = [];

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    }

    const scoped = this.scoped(req, LambdaExecutionSchemaModel);
    result.query = scoped.parseQuery(result.query, {}, scoped.flatSchemaData);

    return result;
  }

  override _exec(req: Request, res: Response, validate: QueryParams<LambdaExecution>) {
    return this.scoped(req, LambdaExecutionSchemaModel).find(validate.query);
  }
}
routes.push(SearchExecutionList);

/**
 * @class LambdaExecutionCount
 */
class LambdaExecutionCount extends Route {
  constructor(services: Services) {
    super(
      `lambda-execution/count`,
      `COUNT LAMBDA EXECUTION`,
      services,
      Model.getCoreModel(LambdaExecutionSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.activityDescription = `COUNT LAMBDA EXECUTION`;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<CountBody<LambdaExecution> | undefined>, _res: Response) {
    const result: QueryParams<LambdaExecution> = {
      query: {},
    };
    result.query.$and = [];

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    } else if (req.body && !req.body.query) {
      // A body with no query is the query, apart from the count's own flag
      const { actualCount: _actualCount, ...bodyQuery } = req.body as Record<string, unknown>;
      result.query.$and.push(bodyQuery);
    }

    const scoped = this.scoped(req, LambdaExecutionSchemaModel);
    result.query = scoped.parseQuery(result.query, {}, scoped.flatSchemaData);

    return result;
  }

  override _exec(req: Request, res: Response, validateResult: QueryParams<LambdaExecution>) {
    return this.scoped(req, LambdaExecutionSchemaModel).count(validateResult.query);
  }
}
routes.push(LambdaExecutionCount);

/**
 * @type {*[]}
 */
export default routes;
