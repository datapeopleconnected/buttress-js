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
import {
  CoreBulkUpdate,
  CoreCount,
  CoreGetList,
  CoreGetOne,
  CoreRouteConfig,
  CoreSearch,
  CoreUpdateByPath,
} from '../core-routes.js';
import Model from '../../model/index.js';
import { invalidEntityError, validateSchemaObject } from '../../model/shared.js';
import { checkPolicyConfig, checkPolicyConfigUpdate } from '../../access-control/policy-definition.js';
import type { ValidationIssue } from '../../helpers/schema.js';
import * as Helpers from '../../helpers/index.js';

import PolicySchemaModel, { Policy, PolicyAddBody } from '../../model/core/policy.js';
import { App } from '../../model/core/app.js';
import { Services } from '../../bootstrap.js';
import { UpdatePathBody } from '../../types/datastore.js';
import type { CoreRouteClass, RequestWithBody } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

// _validate requires a version, though add doesn't store it
type AddPolicyBody = PolicyAddBody & { version?: string };

/**
 * @class GetPolicy
 */
class GetPolicy extends CoreGetOne<PolicySchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'policy/:id',
    name: 'GET POLICY',
    model: PolicySchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.READ,
  };
}
routes.push(GetPolicy);

/**
 * @class GetPolicyList
 */
class GetPolicyList extends CoreGetList<PolicySchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'policy',
    name: 'GET POLICY LIST',
    model: PolicySchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.LIST,
    takesIds: true,
  };
}
routes.push(GetPolicyList);

/**
 * @class SearchPolicyList
 */
class SearchPolicyList extends CoreSearch<PolicySchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'policy',
    name: 'SEARCH POLICY LIST',
    model: PolicySchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.LIST,
  };
}
routes.push(SearchPolicyList);

/**
 * @class AddPolicy
 */
class AddPolicy extends Route {
  constructor(services: Services) {
    super('policy', 'ADD POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  override async _validate(req: RequestWithBody<AddPolicyBody>, _res: Response) {
    const app = req.context.authApp;
    try {
      if (!app || !req.body?.selection || !req.body.name || !req.body.config || req.body.config.length < 1) {
        this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('missing_field'));
      }

      // Names are unique within the caller's app, which a system token names too
      const policyExist = await this.scoped(req, PolicySchemaModel).findOne({
        name: {
          $eq: req.body.name,
        },
        _appId: app.id,
      });
      if (policyExist) {
        this.log(`[${this.name}] Policy with name ${req.body.name} already exists`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('policy_with_name_already_exists'));
      }

      const problem = await newPolicyProblem(app, req.body as PolicyAddBody);
      if (problem) {
        this.log(`[${this.name}] ${problem.code}: ${req.body.name}`, Route.LogLevel.ERR);
        return Promise.reject(problem);
      }

      return Promise.resolve({
        appId: app.id,
      });
    } catch (err: unknown) {
      return Promise.reject(err);
    }
  }

  override _exec(req: RequestWithBody<AddPolicyBody>, res: Response, validate: { appId: string }) {
    return this.scoped(req, PolicySchemaModel)
      .add(req.body, { _appId: validate.appId })
      .then((policy) => {
        this._notify(
          'app-policy:bust-cache',
          JSON.stringify({
            appId: validate.appId,
          }),
        );
        return policy;
      });
  }
}
routes.push(AddPolicy);

/**
 * @class UpdatePolicy
 */
class UpdatePolicy extends CoreUpdateByPath<PolicySchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'policy/:id',
    name: 'UPDATE POLICY',
    model: PolicySchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.WRITE,
  };

  // A config an update writes has to be able to grant something
  protected override updateProblem(_req: Request, updates: UpdatePathBody[]) {
    return policyUpdateProblem(updates);
  }
}
routes.push(UpdatePolicy);

/**
 * @class BulkUpdatePolicy
 */
class BulkUpdatePolicy extends CoreBulkUpdate<PolicySchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'policy/bulk/update',
    name: 'UPDATE POLICY',
    model: PolicySchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.WRITE,
  };

  // A config an update writes has to be able to grant something
  protected override updateProblem(_req: Request, updates: UpdatePathBody[]) {
    return policyUpdateProblem(updates);
  }
}
routes.push(BulkUpdatePolicy);

/**
 * The error to refuse a policy for when it's added to `app`, or null if it can be: it needs a name, a selection and
 * config, a selection of properties the app lists, a version, configs that can grant something, and values of the
 * policy schema's types.
 */
const newPolicyProblem = async (app: App, policy: PolicyAddBody) => {
  if (!policy?.selection || !policy.name || !policy.config || policy.config.length < 1) {
    return Helpers.Errors.badRequest('missing_field');
  }

  const policyCheck = await Helpers.checkPolicySelection(app.policyPropertiesList, policy.selection);
  if (!policyCheck.passed) return Helpers.Errors.badRequest('invalid_policy_selection');

  if (!policy.version) return Helpers.Errors.badRequest('invalid_policy_no_version');

  const issues = checkPolicyConfig(policy.config);
  if (issues.length > 0) return invalidPolicy(policy.name, issues);

  const validation = validateSchemaObject(PolicySchemaModel.Schema, policy);
  return validation.isValid ? null : invalidEntityError(PolicySchemaModel.Schema.name, validation);
};

// A policy whose configs would grant nothing, or fail when they're evaluated
const invalidPolicy = (name: string | undefined, issues: ValidationIssue[]) =>
  Helpers.Errors.badRequest('invalid_policy', `${name ?? 'policy'}: Invalid policy config`, { issues });

// The error for updates that write configs that would grant nothing, or null
const policyUpdateProblem = (updates: UpdatePathBody | UpdatePathBody[]) => {
  const issues = (Array.isArray(updates) ? updates : [updates]).flatMap((update) => checkPolicyConfigUpdate(update));
  return issues.length > 0 ? invalidPolicy(undefined, issues) : null;
};

/**
 * @class SyncPolicies
 */
class SyncPolicies extends Route {
  constructor(services: Services) {
    super('policy/sync', 'SYNC POLICIES', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  override async _validate(req: RequestWithBody<PolicyAddBody[]>, _res: Response) {
    const app = req.context.authApp;

    if (!app || !req.body) {
      this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_field');
    }

    if (!Array.isArray(req.body)) {
      this.log(`[${this.name}] invalid field`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('invalid_field');
    }

    // Checked as adding each one is, before any are replaced
    const names = new Set<string>();
    for (const policy of req.body) {
      const problem = await newPolicyProblem(app, policy);
      if (problem) {
        this.log(`[${this.name}] ${problem.code}: ${policy?.name}`, Route.LogLevel.ERR);
        throw problem;
      }
      if (names.has(policy.name as string)) {
        this.log(`[${this.name}] Policy with name ${policy.name} is given twice`, Route.LogLevel.ERR);
        throw Helpers.Errors.badRequest('policy_with_name_already_exists');
      }
      names.add(policy.name as string);
    }

    return {
      appId: app.id,
    };
  }

  override async _exec(req: RequestWithBody<PolicyAddBody[]>, res: Response, validate: { appId: string }) {
    // The caller's app's policies, which a system token names too
    const policies = this.scoped(req, PolicySchemaModel);
    const oldPolicies = await Helpers.streamAll<Policy>(await policies.find({ _appId: validate.appId }));

    // Removed by id, which takes them out of the policy cache too, and before the new ones are added, so the old and
    // new never grant access together
    if (oldPolicies.length > 0) await policies.rmBulk(oldPolicies.map((policy) => policy.id.toString()));

    const added: string[] = [];
    try {
      for (const policy of req.body) {
        added.push((await policies.add(policy, { _appId: validate.appId })).id.toString());
      }
    } catch (err: unknown) {
      // The app is left with the policies it had, rather than some of the new ones
      try {
        if (added.length > 0) await policies.rmBulk(added);
        for (const policy of oldPolicies) await policies.add(policy as PolicyAddBody, { _appId: validate.appId });
      } catch (restoreErr: unknown) {
        this.log(
          `[${this.name}] Failed to put back the app's policies: ${Helpers.getThrownErrorMessage(restoreErr)}`,
          Route.LogLevel.ERR,
        );
      }
      throw err;
    }

    this._notify(
      'app-policy:bust-cache',
      JSON.stringify({
        appId: validate.appId,
      }),
    );

    return true;
  }
}

/**
 * @class PolicyCount
 */
class PolicyCount extends CoreCount<PolicySchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'policy/count',
    name: 'COUNT POLICIES',
    model: PolicySchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.SEARCH,
  };
}
routes.push(PolicyCount);

routes.push(SyncPolicies);

/**
 * @class DeleteTransientPolicy
 */
class DeleteTransientPolicy extends Route {
  constructor(services: Services) {
    super(
      'policy/delete-transient-policy',
      'DELETE POLICY BY NAME',
      services,
      Model.getCoreModel(PolicySchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  override async _validate(req: RequestWithBody<{ name?: string } | undefined>, _res: Response) {
    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log(`[${this.name}] Missing app id`, Route.LogLevel.ERR);
      throw Helpers.Errors.internal('missing_app_id');
    }

    if (!req.body || !req.body.name) {
      this.log(`[${this.name}] Missing required policy transient name field`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_field');
    }

    // streamFirst() rejects rather than resolving falsy when the stream ends with no data,
    // so an empty result has to be caught here to surface the intended 400 error.
    let policy: Policy | null;
    try {
      policy = await Helpers.streamFirst<Policy>(
        // Policy names are only unique within an app, so another app's policy of the same name is left alone
        await this.scoped(req, PolicySchemaModel).find({
          name: req.body.name,
          _appId: appId,
        }),
      );
    } catch (_err: unknown) {
      policy = null;
    }
    if (!policy) {
      this.log(`[${this.name}] Cannot find a policy with name ${req.body.name}`, Route.LogLevel.ERR);
      throw Helpers.Errors.notFound('not_found', 'No policy has that name', { schema: 'policy', name: req.body.name });
    }

    return {
      appId,
      policy,
    };
  }

  override async _exec(req: Request, _res: Response, validate: { appId: string; policy: Policy }) {
    if (!validate) return true;

    await this.scoped(req, PolicySchemaModel).rm(validate.policy.id.toString());

    this._notify(
      'app-policy:bust-cache',
      JSON.stringify({
        appId: validate.appId,
      }),
    );

    // Trigger socket process to re-evaluate rooms
    this._notify(
      'worker:socket:evaluateUserRooms',
      JSON.stringify({
        appId: validate.appId,
      }),
    );

    return true;
  }
}
routes.push(DeleteTransientPolicy);

/**
 * @class DeletePolicy
 */
class DeletePolicy extends Route {
  constructor(services: Services) {
    super('policy/:id', 'DELETE POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: RequestWithBody<unknown, { id: string }>, _res: Response) {
    if (!req.params.id) {
      this.log('ERROR: Missing required field', Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_field');
    }

    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log('ERROR: Missing app id', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('missing_app_id');
    }

    const policy = await this.scoped(req, PolicySchemaModel).findByIdOrFail(req.params.id);

    return {
      appId,
      policy,
    };
  }

  override async _exec(req: Request, res: Response, validate: { appId: string; policy: Policy }) {
    await this.scoped(req, PolicySchemaModel).rm(validate.policy.id.toString());

    this._notify(
      'app-policy:bust-cache',
      JSON.stringify({
        appId: validate.appId,
      }),
    );

    return true;
  }
}
routes.push(DeletePolicy);

/**
 * @class DeleteAppPolicies
 */
class DeleteAppPolicies extends Route {
  constructor(services: Services) {
    super('policy', 'DELETE ALL APP POLICIES', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: Missing app id', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('missing_app_id');
    }

    // Every app's policies for a system token, unlike DeleteAllUsers, which keeps one to its own app (D-30)
    const rxsPolicies = await this.scoped(req, PolicySchemaModel).findAll();

    const policies = await Helpers.streamAll<Policy>(rxsPolicies);

    return policies.map((p) => p.id.toString());
  }

  override _exec(req: Request, res: Response, validate: string[]) {
    return new Promise((resolve, reject) => {
      this.scoped(req, PolicySchemaModel)
        .rmBulk(validate)
        .then(() => true)
        .then(resolve, reject);
    });
  }
}
routes.push(DeleteAppPolicies);

/**
 * @type {*[]}
 */
export default routes;
