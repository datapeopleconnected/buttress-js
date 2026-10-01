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

import fs from 'node:fs';
import { Request, Response } from 'express';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Route from '../route.js';
import Model from '../../model/index.js';
import { invalidEntityError, invalidUpdateError, validateSchemaObject } from '../../model/shared.js';
import Sugar from '../../helpers/sugar.js';
import * as Helpers from '../../helpers/index.js';
import * as Git from '../../helpers/git.js';

import Datastore from '../../datastore/index.js';
import LambdaSchemaModel, { Lambda, LambdaAddBody } from '../../model/core/lambda.js';
import TokenSchemaModel, { Token } from '../../model/core/token.js';
import { App } from '../../model/core/app.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import DeploymentSchemaModel from '../../model/core/deployment.js';
import LambdaExecutionSchemaModel, { LambdaExecution } from '../../model/core/lambda-execution.js';

import { Services } from '../../bootstrap.js';

import { QueryParams } from '../../types/bjs-query.js';
import { UpdatePathBody } from '../../types/datastore.js';
import type { BulkUpdateItem, CountBody, RequestWithBody, SearchBody } from '../../types/routes.js';

// Should contain a list of route classes that extend Route.
type LambdaRouteConstructor = new (services: Services) => Route;
const routes: LambdaRouteConstructor[] = [];

// The body of a set or update policy property request, e.g. `{ role: { '@eq': 'ADMIN' } }`
type PolicyPropertiesBody = Record<string, unknown>;

type AddLambdaBody = {
  lambda: LambdaAddBody & { policyProperties?: Token['policyProperties'] };
  auth: Partial<Token>;
};

type ScheduleLambdaExecutionBody = {
  deploymentId?: string;
  // A date expression, see Sugar.Date.create
  executeAfter?: string;
  metadata?: LambdaExecution['metadata'];
};

type EditLambdaDeploymentBody = {
  branch: string;
  hash: string;
  entryFile?: string;
  entryPoint?: string;
};

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

  override async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    return this.scoped(req, LambdaSchemaModel).findByIdOrFail(id);
  }

  override async _exec(_req: Request, _res: Response, lambda: Lambda) {
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

  override _validate(req: Request, _res: Response) {
    const rawIds = req.query.ids;
    const ids = Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' ? rawIds.split(',').filter(Boolean) : [];

    if (ids.length > 0) {
      ids.forEach((id) => {
        try {
          Datastore.getInstance('core').ID.new(id.toString());
        } catch (_err) {
          this.log(`LAMBDA: Invalid ID: ${id}`, Route.LogLevel.ERR, req.context.id);
          throw Helpers.Errors.badRequest('invalid_id', 'The id is not valid');
        }
      });
    }

    return Promise.resolve(ids);
  }

  override async _exec(req: Request, res: Response, ids: unknown[]) {
    if (ids.length > 0) {
      // TODO: needs to be scoped by appId - Disabled until fixed.
      // return Model.getCoreModel(LambdaSchemaModel).findByIds(ids);
    }

    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log(`[${this.name}] Unable to get app id from request context`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('unable_to_get_app_id'));
    }

    return await this.scoped(req, LambdaSchemaModel).findAll();
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

  override async _validate(req: RequestWithBody<SearchBody<Lambda> | undefined>, _res: Response) {
    const result: QueryParams<Lambda> = {
      query: {},
    };
    result.query.$and = [];

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    }

    const lambdas = this.scoped(req, LambdaSchemaModel);
    result.query = lambdas.parseQuery(result.query, {}, lambdas.flatSchemaData);

    return result;
  }

  override _exec(req: Request, res: Response, validate: QueryParams<Lambda>) {
    return this.scoped(req, LambdaSchemaModel).find(validate.query);
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

  override async _validate(req: RequestWithBody<AddLambdaBody>, _res: Response) {
    try {
      const name = req.body?.lambda?.name;
      const url = req.body?.lambda?.git?.url;
      const branch = req.body?.lambda?.git?.branch;
      const gitHash = req.body?.lambda?.git?.hash;

      if (
        !req.context.authApp ||
        !req.body?.lambda?.trigger ||
        !req.body.lambda.git ||
        !req.body.lambda.git.entryFile ||
        !req.body.lambda.git.entryPoint ||
        !name ||
        !url ||
        !gitHash ||
        !branch
      ) {
        this.log(`[${this.name}] Missing required lambda field`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('missing_field'));
      }

      if (req.body.lambda && req.body.lambda.policyProperties) {
        req.body.auth.policyProperties = req.body.lambda.policyProperties;
      }

      if (!req.body.auth) {
        this.log(`[${this.name}] Auth properties are required when creating a lambda`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('missing_auth'));
      }

      if (!req.body.auth.domains || !req.body.auth.policyProperties) {
        this.log(`[${this.name}] Missing required field (auth.domains, auth.policyProperties)`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('missing_field'));
      }

      if (!Helpers.isDomainList(req.body.auth.domains)) {
        this.log(`[${this.name}] auth.domains must be a list of domain names`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('invalid_domains'));
      }

      Git.assertLambdaSharedModules(req.body.lambda.git.sharedModules);

      const validation = validateSchemaObject(LambdaSchemaModel.Schema, req.body.lambda);
      if (!validation.isValid) {
        const err = invalidEntityError(LambdaSchemaModel.Schema.name, validation);
        this.log(`[${this.name}] ${err.message}`, Route.LogLevel.ERR);
        return Promise.reject(err);
      }

      return Promise.resolve(true);
    } catch (err: unknown) {
      return Promise.reject(err);
    }
  }

  override async _exec(req: RequestWithBody<AddLambdaBody>, _res: Response, _validate: boolean) {
    // Authentication refuses a token whose app it can't find, so there's always one; _validate checked
    const app = req.context.authApp as App;
    const lambda = await this.scoped(req, LambdaSchemaModel).add(req.body.lambda, {
      _appId: app.id,
      auth: req.body.auth,
      app,
    });

    const hasPathMutation = lambda.trigger.some((t) => t.type === 'PATH_MUTATION');
    if (hasPathMutation) {
      this._nrp?.emit('rest:worker:add-path-mutation', JSON.stringify(lambda));
    }

    return lambda;
  }
}
routes.push(AddLambda);

/**
 * Whether a change to a lambda may change which paths the Lambda manager runs it for: it watches paths, or the change
 * is to its triggers, which may have.
 */
const changesPathMutations = (lambda: Lambda, updates: UpdatePathBody[] = []) =>
  lambda.trigger.some((t) => t.type === 'PATH_MUTATION') || updates.some((update) => /^trigger\b/.test(update.path));

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

  override _validate(req: RequestWithBody<unknown>, _res: Response) {
    return new Promise<{ id: string }>((resolve, reject) => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const lambdas = this.scoped(req, LambdaSchemaModel);
      const { validation, body } = lambdas.validateUpdate(req.body);
      req.body = body;

      if (!validation.isValid) {
        const err = invalidUpdateError(this.schemaName, validation);
        this.log(`ERROR: ${err.message}`, Route.LogLevel.ERR);
        return reject(err);
      }

      lambdas
        .assertExists(id)
        .then(() => resolve({ id }))
        .catch(reject);
    });
  }

  // _validate replaced the body with the validated updates
  override async _exec(req: RequestWithBody<UpdatePathBody[]>, _res: Response, validate: { id: string }) {
    const lambdas = this.scoped(req, LambdaSchemaModel);
    const updated = await lambdas.updateByPath(req.body, validate.id);

    const lambda = (await lambdas.findById(validate.id)) as Lambda;
    if (req.body.some((update) => update.path.replace(/\./g, '_').toUpperCase() === 'GIT_HASH')) {
      await (await lambdas.owned(lambda.id)).pullLambdaCode(lambda);
    }
    if (changesPathMutations(lambda, req.body)) this._nrp?.emit('rest:worker:rebuild-path-mutation-cache', '');
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

  override async _validate(req: RequestWithBody<BulkUpdateItem[]>, _res: Response) {
    if (!Array.isArray(req.body) || req.body.some((item) => !item || typeof item !== 'object')) {
      this.log(`[${this.name}] Expected an array of {id, body} updates`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('array_required');
    }

    const lambdas = this.scoped(req, LambdaSchemaModel);
    for await (const item of req.body) {
      const { validation, body } = lambdas.validateUpdate(item.body);
      item.body = body;
      if (!validation.isValid) {
        const err = invalidUpdateError(this.schemaName, validation);
        this.log(`ERROR: ${err.message}`, Route.LogLevel.ERR);
        return Promise.reject(err);
      }

      await lambdas.assertExists(item.id);
    }

    return req.body as BulkUpdateItem<UpdatePathBody[]>[];
  }

  override async _exec(req: Request, res: Response, validate: BulkUpdateItem<UpdatePathBody[]>[]) {
    const lambdas = this.scoped(req, LambdaSchemaModel);
    let pathMutationsChanged = false;
    for await (const item of validate) {
      await lambdas.updateByPath(item.body, item.id);
      const lambda = (await lambdas.findById(item.id)) as Lambda;
      if (item.body.some((update) => update.path.replace(/\./g, '_').toUpperCase() === 'GIT_HASH')) {
        await (await lambdas.owned(lambda.id)).pullLambdaCode(lambda);
      }
      if (changesPathMutations(lambda, item.body)) pathMutationsChanged = true;
    }
    if (pathMutationsChanged) this._nrp?.emit('rest:worker:rebuild-path-mutation-cache', '');
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

  override async _validate(req: RequestWithBody<ScheduleLambdaExecutionBody>, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_post_body'));
    }

    const lambda = await this.scoped(req, LambdaSchemaModel).findByIdOrFail(id);

    // Find deployment
    const deploymentQuery: {
      lambdaId: string;
      id?: string;
    } = {
      lambdaId: lambda.id,
    };
    const deployments = this.scoped(req, DeploymentSchemaModel);
    if (req.body.deploymentId) {
      if (!Model.getCoreModel(DeploymentSchemaModel).isValidId(req.body.deploymentId)) {
        return Promise.reject(Helpers.Errors.badRequest('invalid_id', 'The deployment id is not valid'));
      }
      deploymentQuery.id = deployments.createId(req.body.deploymentId);
    }

    const deployment = await deployments.findOne(deploymentQuery);
    if (!deployment) {
      this.log('ERROR: Deployment not found', Route.LogLevel.ERR);
      return Promise.reject(
        req.body.deploymentId
          ? Helpers.Errors.entityNotFound('deployment', req.body.deploymentId)
          : Helpers.Errors.notFound('not_found', 'The lambda has no deployment', { schema: 'deployment' }),
      );
    }

    const executeAfter = Sugar.Date.create(req.body.executeAfter);
    if (!Sugar.Date.isValid(executeAfter)) {
      this.log('ERROR: Invalid executeAfter date expression', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_execute_after_date'));
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

  override async _exec(req: Request, _res: Response, validate: { appId: string; execution: Partial<LambdaExecution> }) {
    return await this.scoped(req, LambdaExecutionSchemaModel).add(validate.execution, { _appId: validate.appId });
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

  override async _validate(req: RequestWithBody<EditLambdaDeploymentBody, { id: string }>, _res: Response) {
    try {
      const branch = req.body?.branch ? req.body.branch : null;
      const hash = req.body?.hash ? req.body.hash : null;
      if (!req.body) {
        this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('no_data_posted'));
      }
      if (!branch) {
        this.log(`[${this.name}] Missing required deployment branch`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('missing_required_deployment_branch'));
      }
      if (!hash) {
        this.log(`[${this.name}] Missing required deployment hash`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('missing_required_deployment_hash'));
      }

      const lambdas = this.scoped(req, LambdaSchemaModel);
      const lambda = await lambdas.findByIdOrFail(req.params.id);

      // An added lambda always has its entry file and point set
      const entryFilePath = req.body.entryFile ? req.body.entryFile : (lambda.git.entryFile as string);
      const entryPoint = req.body.entryPoint ? req.body.entryPoint : (lambda.git.entryPoint as string);
      const lambdaDeployInfo = {
        branch,
        hash,
        entryFilePath,
        entryPoint,
      };
      await (await lambdas.owned(lambda.id)).pullLambdaCode(lambda, lambdaDeployInfo);

      return Promise.resolve({
        hash,
        branch,
        entryFile: entryFilePath,
        entryPoint,
        lambda,
      });
    } catch (err: unknown) {
      const errMessage = Helpers.getThrownErrorMessage(err);
      this.log(`[${this.name}] ${errMessage}`, Route.LogLevel.ERR);
      // A refusal is kept. Any other failure, such as git's, would give away commands and paths
      if (err instanceof Helpers.Errors.ApiError) return Promise.reject(err);
      return Promise.reject(
        Helpers.Errors.badRequest('lambda_deployment_failed', "The lambda's code could not be deployed"),
      );
    }
  }

  override async _exec(
    req: Request,
    res: Response,
    validate: { hash: string; branch: string; entryFile: string; entryPoint: string; lambda: Lambda },
  ) {
    // The entry file and point the new code was checked for
    const lambdas = await this.scoped(req, LambdaSchemaModel).owned(validate.lambda.id);
    const deployment = await lambdas.setDeployment(validate.lambda.id, {
      'git.branch': validate.branch,
      'git.hash': validate.hash,
      'git.entryFile': validate.entryFile,
      'git.entryPoint': validate.entryPoint,
    });
    // The manager keeps each path-watching lambda's hash
    if (changesPathMutations(validate.lambda)) this._nrp?.emit('rest:worker:rebuild-path-mutation-cache', '');
    return deployment;
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

  override async _validate(req: RequestWithBody<PolicyPropertiesBody>, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const app = req.context.authApp;
    if (!app) {
      this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    // A named route param, so a string
    await this.scoped(req, LambdaSchemaModel).assertExists(req.params.id as string);

    const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
    if (!policyCheck.passed) {
      this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_field'));
    }

    const lambdaToken = await this.scoped(req, TokenSchemaModel).findOne({ _lambdaId: id });
    if (!lambdaToken) {
      this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
      return Promise.reject(
        Helpers.Errors.notFound('not_found', "The lambda's token was not found", { schema: 'token' }),
      );
    }

    return Promise.resolve(lambdaToken);
  }

  override async _exec(req: RequestWithBody<PolicyPropertiesBody>, res: Response, validate: Token) {
    const tokens = await this.scoped(req, TokenSchemaModel).owned(validate.id.toString());
    await tokens.setPolicyPropertiesById(validate.id.toString(), req.body);
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

  override async _validate(req: RequestWithBody<PolicyPropertiesBody>, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const app = req.context.authApp;
    if (!app) {
      this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    // A named route param, so a string
    await this.scoped(req, LambdaSchemaModel).assertExists(req.params.id as string);

    const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
    if (!policyCheck.passed) {
      this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_field'));
    }

    const lambdaToken = await this.scoped(req, TokenSchemaModel).findOne({ _lambdaId: id });
    if (!lambdaToken) {
      this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
      return Promise.reject(
        Helpers.Errors.notFound('not_found', "The lambda's token was not found", { schema: 'token' }),
      );
    }

    return Promise.resolve({
      token: lambdaToken,
    });
  }

  override async _exec(req: RequestWithBody<PolicyPropertiesBody>, res: Response, validate: { token: Token }) {
    const tokens = await this.scoped(req, TokenSchemaModel).owned(validate.token.id.toString());
    await tokens.updatePolicyProperties(validate.token, req.body);
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

  override async _validate(req: RequestWithBody<unknown>, _res: Response) {
    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    await this.scoped(req, LambdaSchemaModel).assertExists(id);

    const lambdaToken = await this.scoped(req, TokenSchemaModel).findOne({ _lambdaId: id });
    if (!lambdaToken) {
      this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
      return Promise.reject(
        Helpers.Errors.notFound('not_found', "The lambda's token was not found", { schema: 'token' }),
      );
    }

    return Promise.resolve({
      token: lambdaToken,
    });
  }

  override async _exec(req: Request, res: Response, validate: { token: Token }) {
    const tokens = await this.scoped(req, TokenSchemaModel).owned(validate.token.id.toString());
    await tokens.clearPolicyPropertiesById(validate.token.id);
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

  override async _validate(req: RequestWithBody<unknown, { id: string }>, _res: Response) {
    if (!req.params.id) {
      this.log('ERROR: Missing required lambda ID', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const lambda = await this.scoped(req, LambdaSchemaModel).findByIdOrFail(req.params.id);

    const lambdaToken = await this.scoped(req, TokenSchemaModel).findOne({ _lambdaId: lambda.id });
    if (!lambdaToken) {
      this.log(`ERROR: Could not fetch lambda's token`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('could_fetch_lambda_token'));
    }

    return {
      lambda,
      token: lambdaToken,
    };
  }

  override async _exec(req: Request, res: Response, validate: { lambda: Lambda; token: Token }) {
    const deployments = await Helpers.streamAll<{ hash: string }>(
      await this.scoped(req, DeploymentSchemaModel).find({ lambdaId: validate.lambda.id }),
    );
    const hashes = new Set([validate.lambda.git.hash, ...deployments.map((deployment) => deployment.hash)]);

    await this.scoped(req, LambdaSchemaModel).rm(validate.lambda.id);
    await this.scoped(req, TokenSchemaModel).rm(validate.token.id);

    // Code is checked out once for each hash, and shared by every lambda on it, whichever app it's in
    const everyAppsLambdas = this.unscopedModel(LambdaSchemaModel, "a hash's code is shared by every app's lambdas");
    for (const hash of hashes) {
      if (!Git.isGitHash(hash)) continue;
      if (await everyAppsLambdas.findOne({ 'git.hash': hash })) continue;
      fs.rmSync(`${Config.paths.lambda.code}/lambda-${hash}`, { recursive: true, force: true });
    }

    if (validate.lambda.trigger.some((t) => t.type === 'PATH_MUTATION')) {
      this._nrp?.emit('rest:worker:rebuild-path-mutation-cache', '');
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

  override async _validate(req: RequestWithBody<CountBody<Lambda> | undefined>, _res: Response) {
    const result: QueryParams<Lambda> = {
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

    const lambdas = this.scoped(req, LambdaSchemaModel);
    result.query = lambdas.parseQuery(result.query, {}, lambdas.flatSchemaData);

    return result;
  }

  override _exec(req: Request, res: Response, validateResult: QueryParams<Lambda>) {
    return this.scoped(req, LambdaSchemaModel).count(validateResult.query);
  }
}
routes.push(LambdaCount);

/**
 * @type {*[]}
 */
export default routes;
