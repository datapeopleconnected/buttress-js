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

import util from 'node:util';
import { Request, Response } from 'express';
import { exec as cpExec } from 'node:child_process';

import { ObjectId } from 'bson';

const exec = util.promisify(cpExec);

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import { ExtendsRoute } from '../../types/routes.js';

import Route from '../route.js';
import Model from '../../model/index.js';
import Sugar from '../../helpers/sugar.js';
import * as Helpers from '../../helpers/index.js';

import Datastore from '../../datastore/index.js';
import LambdaSchemaModel from '../../model/core/lambda.js';
import TokenSchemaModel from '../../model/core/token.js';
import UserSchemaModel from '../../model/core/user.js';
import AppSchemaModel from '../../model/core/app.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import DeploymentSchemaModel from '../../model/core/deployment.js';
import LambdaExecutionSchemaModel, { LambdaExecution } from '../../model/core/lambda-execution.js';

import { Services } from '../../bootstrap.js';

// Should should contain a list of routes that extend the Route class but have different constructors
const routes: ExtendsRoute<Route>[] = [];

/**
 * @class GetLambda
 */
class GetLambda extends Route {
  constructor(services: Services) {
    super('lambda/:id', 'GET LAMBDA', services, Model.getCoreModel(LambdaSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.READ;
  }

  async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
    }
    if (!ObjectId.isValid(id)) {
      this.log(`[${this.name}] Invalid lambda id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
    }

    const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(id);
    if (!lambda) {
      this.log(`[${this.name}] Cannot find a lambda with id ${id}`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `lambda_does_not_exist`));
    }

    return lambda;
  }

  _exec(_req: Request, _res: Response, lambda: any) {
    return lambda;
  }
}
routes.push(GetLambda);

/**
 * @class GetLambdaList
 */
class GetLambdaList extends Route {
  constructor(services: Services) {
    super('lambda', 'GET LAMBDA LIST', services, Model.getCoreModel(LambdaSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  _validate(req: Request, _res: Response) {
    const rawIds = req.query.ids;
    const ids = Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' ? rawIds.split(',').filter(Boolean) : [];

    if (ids.length > 0) {
      ids.forEach((id) => {
        try {
          Datastore.getInstance('core').ID.new(id);
        } catch (err) {
          this.log(`LAMBDA: Invalid ID: ${id}`, Route.LogLevel.ERR, req.context.id);
          throw new Helpers.Errors.RequestError(400, 'invalid_id');
        }
      });
    }

    return Promise.resolve(ids);
  }

  async _exec(req: Request, res: Response, ids) {
    if (ids.length > 0) {
      // TODO: needs to be scoped by appId - Disabled until fixed.
      // return Model.getCoreModel(LambdaSchemaModel).findByIds(ids);
    }

    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log(`[${this.name}] Unable to get app id from request context`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `unable_to_get_app_id`));
    }

    return req.context.token && req.context.token.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM
      ? await Model.getCoreModel(LambdaSchemaModel).findAll()
      : await Model.getCoreModel(LambdaSchemaModel).find({
          _appId: Model.getCoreModel(LambdaSchemaModel).adapter.ID.new(appId),
        });
  }
}
routes.push(GetLambdaList);

/**
 * @class SearchLambdaList
 */
class SearchLambdaList extends Route {
  constructor(services: Services) {
    super('lambda', 'SEARCH LAMBDA LIST', services, Model.getCoreModel(LambdaSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  async _validate(req: Request, res: Response) {
    const result: {
      query: any;
    } = {
      query: {
        $and: [],
      },
    };

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    }

    result.query = Model.getCoreModel(LambdaSchemaModel).parseQuery(
      result.query,
      {},
      Model.getCoreModel(LambdaSchemaModel).flatSchemaData,
    );
    return result;
  }

  _exec(req: Request, res: Response, validate) {
    return Model.getCoreModel(LambdaSchemaModel).find(validate.query);
  }
}
routes.push(SearchLambdaList);

/**
 * @class AddLambda
 */
class AddLambda extends Route {
  constructor(services: Services) {
    super('lambda', 'ADD LAMBDA', services, Model.getCoreModel(LambdaSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  async _validate(req: Request, _res: Response) {
    try {
      const name = req.body?.lambda?.name;
      const url = req.body?.lambda?.git?.url;
      const branch = req.body?.lambda?.git?.branch;
      const gitHash = req.body?.lambda?.git?.hash;

      if (
        !req.context.authApp ||
        !req.body.lambda.trigger ||
        !req.body.lambda.git ||
        !req.body.lambda.git.entryFile ||
        !req.body.lambda.git.entryPoint ||
        !name ||
        !url ||
        !gitHash ||
        !branch
      ) {
        this.log(`[${this.name}] Missing required lambda field`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
      }

      if (req.body.lambda && req.body.lambda.policyProperties) {
        req.body.auth.policyProperties = req.body.lambda.policyProperties;
      }

      if (!req.body.auth) {
        this.log(`[${this.name}] Auth properties are required when creating a lambda`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `missing_auth`));
      }

      if (!req.body.auth.domains || !req.body.auth.policyProperties) {
        this.log(`[${this.name}] Missing required field (auth.domains, auth.policyProperties)`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
      }

      return Promise.resolve(true);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async _exec(req: Request, res: Response, validate) {
    let appId = req.context.authApp?.id;
    if (!appId) {
      // const token = await this._getToken(req);
      const token = req.context.token;
      if (token && token._appId) {
        appId = token._appId;
      }
      if (token && token._lambdaId) {
        const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(token._lambdaId);
        appId = lambda._appId;
      }
      if (token && token._userId) {
        const user = await Model.getCoreModel(UserSchemaModel).findById(token._userId);
        appId = user._appId;
      }
    }

    const app = await Model.getCoreModel(AppSchemaModel).findById(appId);
    const lambda = await Model.getCoreModel(LambdaSchemaModel).add(req.body.lambda, { auth: req.body.auth, app });

    const hasPathMutation = lambda.trigger.some((t) => t.type === 'PATH_MUTATION');
    if (hasPathMutation) {
      this._nrp?.emit('rest:worker:add-path-mutation', JSON.stringify(lambda));
    }

    return lambda;
  }
}
routes.push(AddLambda);

/**
 * @class UpdateLambda
 */
class UpdateLambda extends Route {
  constructor(services: Services) {
    super('lambda/:id', 'UPDATE LAMBDA', services, Model.getCoreModel(LambdaSchemaModel).schemaData);

    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  _validate(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { validation, body } = Model.getCoreModel(LambdaSchemaModel).validateUpdate(req.body);
      req.body = body;

      if (!validation.isValid) {
        if (validation.isPathValid === false) {
          this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
          return reject(
            new Helpers.Errors.RequestError(400, `LAMBDA: Update path is invalid: ${validation.invalidPath}`),
          );
        }
        if (validation.isValueValid === false) {
          this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
          return reject(
            new Helpers.Errors.RequestError(400, `LAMBDA: Update value is invalid: ${validation.invalidValue}`),
          );
        }
      }

      Model.getCoreModel(LambdaSchemaModel)
        .exists(id)
        .then((exists) => {
          if (!exists) {
            this.log('ERROR: Invalid LAMBDA ID', Route.LogLevel.ERR);
            return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
          }
          resolve({
            id,
          });
        });
    });
  }

  async _exec(req: Request, _res: Response, validate) {
    const updated = await Model.getCoreModel(LambdaSchemaModel).updateByPath(req.body, validate.id);

    // TODO: Check to see if the updated involved the triggers or path mutations.

    const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(validate.id);
    if (req.body.some((update) => update.path.replace(/\./g, '_').toUpperCase() === 'GIT_HASH')) {
      await Model.getCoreModel(LambdaSchemaModel).pullLambdaCode(lambda);
    }
    return updated;
  }
}
routes.push(UpdateLambda);

/**
 * @class BulkUpdateLambda
 */
class BulkUpdateLambda extends Route {
  constructor(services: Services) {
    super('lambda/bulk/update', 'BULK UPDATE LAMBDA', services, Model.getCoreModel(LambdaSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  async _validate(req: Request, res: Response) {
    for await (const item of req.body) {
      const { validation, body } = Model.getCoreModel(LambdaSchemaModel).validateUpdate(item.body);
      item.body = body;
      if (!validation.isValid) {
        if (validation.isPathValid === false) {
          this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
          return Promise.reject(
            new Helpers.Errors.RequestError(400, `LAMBDA: Update path is invalid: ${validation.invalidPath}`),
          );
        }
        if (validation.isValueValid === false) {
          this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
          return Promise.reject(
            new Helpers.Errors.RequestError(400, `LAMBDA: Update value is invalid: ${validation.invalidValue}`),
          );
        }
      }

      const exists = Model.getCoreModel(LambdaSchemaModel).exists(item.id);
      if (!exists) {
        this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
      }
    }

    return req.body;
  }

  async _exec(req: Request, res: Response, validate) {
    for await (const item of validate) {
      await Model.getCoreModel(LambdaSchemaModel).updateByPath(item.body, item.id);
      const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(item.id);
      if (item.body.some((update) => update.path.replace(/\./g, '_').toUpperCase() === 'GIT_HASH')) {
        await Model.getCoreModel(LambdaSchemaModel).pullLambdaCode(lambda);
      }
    }
    return true;
  }
}
routes.push(BulkUpdateLambda);

/**
 * @class EditLambdaDeployment
 */
class ScheduleLambdaExecution extends Route {
  constructor(services: Services) {
    super(
      'lambda/:id/schedule',
      'SCHEDULE LAMBDA EXECUTION',
      services,
      Model.getCoreModel(LambdaSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  async _validate(req: Request, res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
    }

    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_post_body`));
    }

    // This should be auto scoped to the app id.
    const lambda = await Model.getCoreModel(LambdaSchemaModel).findOne({
      id: Model.getCoreModel(LambdaSchemaModel).createId(id),
      ...(req.context.authApp?.id
        ? { _appId: Model.getCoreModel(AppSchemaModel).createId(req.context.authApp.id) }
        : {}),
    });
    if (!lambda) {
      this.log('ERROR: Lambda not found', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(404, `not_found`));
    }

    // Find deployment
    const deploymentQuery: {
      lambdaId: string;
      id?: string;
    } = {
      lambdaId: lambda.id,
    };
    if (req.body.deploymentId) {
      deploymentQuery.id = Model.getCoreModel(DeploymentSchemaModel).createId(req.body.deploymentId);
    }

    const deployment = await Model.getCoreModel(DeploymentSchemaModel).findOne(deploymentQuery);
    if (!deployment) {
      this.log('ERROR: Deployment not found', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(404, `not_found`));
    }

    const executeAfter = Sugar.Date.create(req.body.executeAfter);
    if (!Sugar.Date.isValid(executeAfter)) {
      this.log('ERROR: Invalid executeAfter date expression', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_execute_after_date`));
    }

    const execution: Partial<LambdaExecution> = {
      triggerType: 'CRON',
      lambdaId: lambda.id,
      deploymentId: deployment.id,
      executeAfter: new Date(executeAfter.toString()),
      nextCronExpression: null,
      metadata: req.body.metadata,
    };
    const lambdaCronTrigger = lambda.trigger.find((t) => t.type === 'CRON');
    if (lambdaCronTrigger) {
      execution.nextCronExpression = lambdaCronTrigger.cron.periodicExecution;
    }

    return {
      appId: lambda._appId,
      execution,
    };
  }

  async _exec(_req: Request, _res: Response, validate) {
    return await Model.getCoreModel(LambdaExecutionSchemaModel).add(validate.execution, validate.appId);
  }
}
routes.push(ScheduleLambdaExecution);

/**
 * @class EditLambdaDeployment
 */
class EditLambdaDeployment extends Route {
  constructor(services: Services) {
    super(
      'lambda/:id/deployment',
      'EDIT LAMBDA DEPLOYMENT',
      services,
      Model.getCoreModel(LambdaSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  async _validate(req: Request, res: Response) {
    try {
      const branch = req.body?.branch ? req.body.branch : null;
      const hash = req.body?.hash ? req.body.hash : null;
      if (!req.body) {
        this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `no_data_posted`));
      }
      if (!branch) {
        this.log(`[${this.name}] Missing required deployment branch`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_deployment_branch`));
      }
      if (!hash) {
        this.log(`[${this.name}] Missing required deployment hash`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_deployment_hash`));
      }

      const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(req.params.id);
      if (!lambda) {
        this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
      }

      const entryFilePath = req.body.entryFile ? req.body.entryFile : lambda.git.entryFile;
      const entryPoint = req.body.entryPoint ? req.body.entryPoint : lambda.git.entryPoint;
      const lambdaDeployInfo = {
        branch,
        hash,
        entryFilePath,
        entryPoint,
      };
      await Model.getCoreModel(LambdaSchemaModel).pullLambdaCode(lambda, lambdaDeployInfo);

      return Promise.resolve({
        hash: req.body.hash,
        branch: req.body.body,
        lambda,
      });
    } catch (err: any) {
      this.log(`[${this.name}] ${err.message}`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, err.message));
    }
  }

  _exec(req: Request, res: Response, validate) {
    return Model.getCoreModel(LambdaSchemaModel).setDeployment(validate.lambda.id, {
      'git.branch': validate.branch,
      'git.hash': validate.hash,
    });
  }
}
routes.push(EditLambdaDeployment);

/**
 * @class SetLambdaPolicyProperties
 */
class SetLambdaPolicyProperties extends Route {
  constructor(services: Services) {
    super(
      'lambda/:id/policy-property',
      'SET LAMBDA POLICY PROPERTY',
      services,
      Model.getCoreModel(LambdaSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  async _validate(req: Request, res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
    }

    const app = req.context.authApp;
    if (!app) {
      this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
    }

    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
    }

    const exists = await Model.getCoreModel(LambdaSchemaModel).exists(req.params.id);
    if (!exists) {
      this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }

    const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
    if (!policyCheck.passed) {
      this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
    }

    const lambdaToken = await Model.getCoreModel(TokenSchemaModel).findOne({
      _lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(id),
    });
    if (!lambdaToken) {
      this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `can_not_find_lambda_token`));
    }

    return Promise.resolve(lambdaToken);
  }

  async _exec(req: Request, res: Response, validate) {
    await Model.getCoreModel(TokenSchemaModel).setPolicyPropertiesById(validate.id.toString(), req.body);
    return true;
  }
}
routes.push(SetLambdaPolicyProperties);

/**
 * @class UpdateLambdaPolicyProperties
 */
class UpdateLambdaPolicyProperties extends Route {
  constructor(services: Services) {
    super(
      'lambda/:id/update-policy-property',
      'UPDATE LAMBDA POLICY PROPERTY',
      services,
      Model.getCoreModel(LambdaSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  async _validate(req: Request, res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
    }

    const app = req.context.authApp;
    if (!app) {
      this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
    }

    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
    }

    const exists = await Model.getCoreModel(LambdaSchemaModel).exists(req.params.id);
    if (!exists) {
      this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }

    const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
    if (!policyCheck.passed) {
      this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
    }

    const lambdaToken = await Model.getCoreModel(TokenSchemaModel).findOne({
      _lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(id),
    });
    if (!lambdaToken) {
      this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `can_not_find_lambda_token`));
    }

    return Promise.resolve({
      token: lambdaToken,
    });
  }

  async _exec(req: Request, res: Response, validate) {
    await Model.getCoreModel(TokenSchemaModel).updatePolicyProperties(validate.token, req.body);
    return true;
  }
}
routes.push(UpdateLambdaPolicyProperties);

/**
 * @class ClearLambdaPolicyProperties
 */
class ClearLambdaPolicyProperties extends Route {
  constructor(services: Services) {
    super(
      'lambda/:id/clear-policy-property',
      'REMOVE LAMBDA POLICY PROPERTY',
      services,
      Model.getCoreModel(LambdaSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  async _validate(req: Request, _res: Response) {
    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
    }

    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
    }

    const exists = await Model.getCoreModel(LambdaSchemaModel).exists(id);
    if (!exists) {
      this.log('ERROR: Invalid lambda ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }

    const lambdaToken = await Model.getCoreModel(TokenSchemaModel).findOne({
      _lambdaId: Model.getCoreModel(LambdaSchemaModel).createId(id),
    });
    if (!lambdaToken) {
      this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `can_not_find_lambda_token`));
    }

    return Promise.resolve({
      token: lambdaToken,
    });
  }

  async _exec(req: Request, res: Response, validate) {
    await Model.getCoreModel(TokenSchemaModel).clearPolicyPropertiesById(validate.token);
    return true;
  }
}
routes.push(ClearLambdaPolicyProperties);

/**
 * @class DeleteLambda
 */
class DeleteLambda extends Route {
  constructor(services: Services) {
    super('lambda/:id', 'DELETE LAMBDA', services, Model.getCoreModel(LambdaSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  async _validate(req: Request, _res: Response) {
    if (!req.params.id) {
      this.log('ERROR: Missing required lambda ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
    }

    const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(req.params.id);
    if (!lambda) {
      this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
    }

    const lambdaToken = await Model.getCoreModel(TokenSchemaModel).findOne({ _lambdaId: lambda.id });
    if (!lambdaToken) {
      this.log(`ERROR: Could not fetch lambda's token`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `could_fetch_lambda_token`));
    }

    return {
      lambda,
      token: lambdaToken,
    };
  }

  async _exec(req: Request, res: Response, validate) {
    await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${validate.lambda.id}`);
    await Model.getCoreModel(LambdaSchemaModel).rm(validate.lambda.id);
    await Model.getCoreModel(TokenSchemaModel).rm(validate.token.id);

    if (validate.lambda.trigger.some((t) => t.type === 'PATH_MUTATION')) {
      this._nrp?.emit('rest:worker:rebuild-path-mutation-cache', JSON.stringify(validate.lambda));
    }

    return true;
  }
}
routes.push(DeleteLambda);

/**
 * @class LambdaCount
 */
class LambdaCount extends Route {
  constructor(services: Services) {
    super(`lambda/count`, `COUNT LAMBDAS`, services, Model.getCoreModel(LambdaSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.activityDescription = `COUNT LAMBDAS`;
    this.activityBroadcast = false;
  }

  async _validate(req: Request, res: Response) {
    const result = {
      query: {},
    };

    let query: any = {};

    if (!query.$and) {
      query.$and = [];
    }

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      query.$and.push(req.body.query);
    } else if (req.body && !req.body.query) {
      query.$and.push(req.body);
    }

    query = Model.getCoreModel(LambdaSchemaModel).parseQuery(
      query,
      {},
      Model.getCoreModel(LambdaSchemaModel).flatSchemaData,
    );
    result.query = query;
    return result;
  }

  _exec(req: Request, res: Response, validateResult) {
    return Model.getCoreModel(LambdaSchemaModel).count(validateResult.query);
  }
}
routes.push(LambdaCount);

/**
 * @type {*[]}
 */
export default routes;
