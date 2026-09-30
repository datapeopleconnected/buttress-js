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
import Model from '../../model/index.js';
import { describeInvalidUpdate } from '../../model/shared.js';
import * as Helpers from '../../helpers/index.js';

import Datastore from '../../datastore/index.js';
import PolicySchemaModel, { Policy, PolicyAddBody } from '../../model/core/policy.js';
import TokenSchemaModel from '../../model/core/token.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import AppSchemaModel, { App } from '../../model/core/app.js';
import { QueryParams } from '../../types/bjs-query.js';
import { Services } from '../../bootstrap.js';
import { UpdatePathBody } from '../../types/datastore.js';
import type { BulkUpdateItem, CoreRouteClass, CountBody, RequestWithBody, SearchListBody } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

// _validate requires a version, though add doesn't store it
type AddPolicyBody = PolicyAddBody & { version?: string };

/**
 * @class GetPolicy
 */
class GetPolicy extends Route {
  constructor(services: Services) {
    super('policy/:id', 'GET POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      this.log(`[${this.name}] Missing required policy id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_policy_id`));
    }
    if (!Datastore.getInstance('core').ID.isValid(id)) {
      this.log(`[${this.name}] Invalid policy id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_id`));
    }

    const policy = await Model.getCoreModel(PolicySchemaModel).findOne({
      _id: Model.getCoreModel(PolicySchemaModel).createId(id),
      ...this._tenantFilter(req),
    });
    if (!policy) {
      this.log(`[${this.name}] Cannot find a policy with id id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `policy_does_not_exist`));
    }

    return policy;
  }

  override _exec(req: Request, res: Response, policy: Policy) {
    return policy;
  }
}
routes.push(GetPolicy);

/**
 * @class GetPolicyList
 */
class GetPolicyList extends Route {
  constructor(services: Services) {
    super('policy', 'GET POLICY LIST', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  override _validate(req: Request, _res: Response) {
    const rawIds = req.query.ids;
    const ids = Array.isArray(rawIds) ? rawIds : typeof rawIds === 'string' ? rawIds.split(',').filter(Boolean) : [];

    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log(`[${this.name}] Missing app id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(500, `missing_app_id`));
    }

    if (ids.length > 0) {
      ids.forEach((id) => {
        try {
          Datastore.getInstance('core').ID.new(id.toString());
        } catch (_err) {
          this.log(`POLICY: Invalid ID: ${id}`, Route.LogLevel.ERR, req.context.id);
          throw new Helpers.Errors.RequestError(400, 'invalid_id');
        }
      });
    }

    return Promise.resolve({
      appId,
      ids,
    });
  }

  override _exec(req: Request, res: Response, validate: { appId: string; ids: string[] }) {
    if (validate.ids.length > 0) {
      // TODO: needs to be scoped by appId - Disabled until fixed.
      // return Model.getCoreModel(PolicySchemaModel).findByIds(validate.ids);
    }

    if (req.context.token && req.context.token.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      return Model.getCoreModel(PolicySchemaModel).findAll();
    }

    return Model.getCoreModel(PolicySchemaModel).find({ _appId: validate.appId });
  }
}
routes.push(GetPolicyList);

/**
 * @class SearchPolicyList
 */
class SearchPolicyList extends Route {
  constructor(services: Services) {
    super('policy', 'SEARCH POLICY LIST', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  override async _validate(req: RequestWithBody<SearchListBody<Policy> | undefined>, _res: Response) {
    // The search options are read off the body, and an array has a sort method of its own
    if (Array.isArray(req.body)) throw new Helpers.Errors.RequestError(400, `invalid_body`);

    const result: QueryParams<Policy> = {
      query: {},
      // parseInt takes numbers too, it converts them to a string first
      skip: req.body && req.body.skip ? parseInt(req.body.skip as string) : 0,
      limit: req.body && req.body.limit ? parseInt(req.body.limit as string) : 0,
      sort: req.body && req.body.sort ? req.body.sort : {},
      project: req.body && req.body.project ? req.body.project : false,
    };
    result.query.$and = [];

    if (isNaN(result.skip ?? 0)) throw new Helpers.Errors.RequestError(400, `invalid_value_skip`);
    if (isNaN(result.limit ?? 0)) throw new Helpers.Errors.RequestError(400, `invalid_value_limit`);

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    }

    // Before parseQuery, which drops an empty $and
    if (req.context.token?.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      result.query.$and?.push({
        _appId: req.context.authApp?.id,
      });
    }

    result.query = Model.getCoreModel(PolicySchemaModel).parseQuery(
      result.query,
      {},
      Model.getCoreModel(PolicySchemaModel).flatSchemaData,
    );

    return result;
  }

  override _exec(req: Request, res: Response, validate: QueryParams<Policy>) {
    return Model.getCoreModel(PolicySchemaModel).find(
      validate.query,
      {},
      validate.limit,
      validate.skip,
      validate.sort,
      validate.project,
    );
  }
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
        return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
      }

      const policyExist = await Model.getCoreModel(PolicySchemaModel).findOne({
        name: {
          $eq: req.body.name,
        },
        _appId: Model.getCoreModel(AppSchemaModel).createId(app.id),
      });
      if (policyExist) {
        this.log(`[${this.name}] Policy with name ${req.body.name} already exists`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `policy_with_name_already_exists`));
      }

      const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body.selection);
      if (!policyCheck.passed) {
        this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_selection`));
      }

      if (!req.body.version) {
        this.log(`[${this.name}] a version property is required: ${req.body.name}`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_no_version`));
      }

      return Promise.resolve({
        appId: app.id,
      });
    } catch (err: unknown) {
      return Promise.reject(err);
    }
  }

  override _exec(req: RequestWithBody<AddPolicyBody>, res: Response, validate: { appId: string }) {
    return Model.getCoreModel(PolicySchemaModel)
      .add(req.body, validate.appId)
      .then((policy) => {
        this._nrp?.emit(
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
class UpdatePolicy extends Route {
  constructor(services: Services) {
    super('policy/:id', 'UPDATE POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  override _validate(req: RequestWithBody<unknown, { id: string }>, _res: Response) {
    return new Promise<boolean>((resolve, reject) => {
      const { validation, body } = Model.getCoreModel(PolicySchemaModel).validateUpdate(req.body);
      req.body = body;
      if (!validation.isValid) {
        const message = describeInvalidUpdate(validation);
        this.log(`ERROR: ${message}`, Route.LogLevel.ERR);
        return reject(new Helpers.Errors.RequestError(400, `POLICY: ${message}`));
      }

      Model.getCoreModel(PolicySchemaModel)
        .exists(req.params.id, null, this._tenantFilter(req))
        .then((exists) => {
          if (!exists) {
            this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
            return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
          }
          resolve(true);
        })
        .catch(reject);
    });
  }

  // _validate replaced the body with the validated updates
  override _exec(req: RequestWithBody<UpdatePathBody[], { id: string }>, _res: Response, _validate: boolean) {
    // Update Policy cache

    return Model.getCoreModel(PolicySchemaModel).updateByPath(req.body, req.params.id);
  }
}
routes.push(UpdatePolicy);

/**
 * @class BulkUpdatePolicy
 */
class BulkUpdatePolicy extends Route {
  constructor(services: Services) {
    super('policy/bulk/update', 'UPDATE POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  override async _validate(req: RequestWithBody<BulkUpdateItem[]>, _res: Response) {
    if (!Array.isArray(req.body) || req.body.some((item) => !item || typeof item !== 'object')) {
      this.log(`[${this.name}] Expected an array of {id, body} updates`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `array_required`);
    }

    for await (const item of req.body) {
      const { validation, body } = Model.getCoreModel(PolicySchemaModel).validateUpdate(item.body);
      item.body = body;
      if (!validation.isValid) {
        const message = describeInvalidUpdate(validation);
        this.log(`ERROR: ${message}`, Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `POLICY: ${message}`));
      }

      const exists = await Model.getCoreModel(PolicySchemaModel).exists(item.id, null, this._tenantFilter(req));
      if (!exists) {
        this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
      }
    }

    return req.body as BulkUpdateItem<UpdatePathBody[]>[];
  }

  override async _exec(req: Request, res: Response, validate: BulkUpdateItem<UpdatePathBody[]>[]) {
    for await (const item of validate) {
      await Model.getCoreModel(PolicySchemaModel).updateByPath(item.body, item.id);
    }
    return true;
  }
}
routes.push(BulkUpdatePolicy);

/**
 * Why a policy can't be added to `app`, or null if it can: it needs a name, a selection and config, a selection of
 * properties the app lists, and a version.
 */
const newPolicyProblem = async (app: App, policy: PolicyAddBody) => {
  if (!policy?.selection || !policy.name || !policy.config || policy.config.length < 1) return 'missing_field';

  const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, policy.selection);
  if (!policyCheck.passed) return 'invalid_policy_selection';

  if (!policy.version) return 'invalid_policy_no_version';

  return null;
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
      throw new Helpers.Errors.RequestError(400, `missing_field`);
    }

    if (!Array.isArray(req.body)) {
      this.log(`[${this.name}] invalid field`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `invalid_field`);
    }

    // Checked as adding each one is, before any are replaced
    const names = new Set<string>();
    for (const policy of req.body) {
      const problem = await newPolicyProblem(app, policy);
      if (problem) {
        this.log(`[${this.name}] ${problem}: ${policy?.name}`, Route.LogLevel.ERR);
        throw new Helpers.Errors.RequestError(400, problem);
      }
      if (names.has(policy.name as string)) {
        this.log(`[${this.name}] Policy with name ${policy.name} is given twice`, Route.LogLevel.ERR);
        throw new Helpers.Errors.RequestError(400, `policy_with_name_already_exists`);
      }
      names.add(policy.name as string);
    }

    return {
      appId: app.id,
    };
  }

  override async _exec(req: RequestWithBody<PolicyAddBody[]>, res: Response, validate: { appId: string }) {
    const policyModel = Model.getCoreModel(PolicySchemaModel);
    const oldPolicies = await Helpers.streamAll<Policy>(await policyModel.find({ _appId: validate.appId }));

    // Removed by id, which takes them out of the policy cache too, and before the new ones are added, so the old and
    // new never grant access together
    if (oldPolicies.length > 0) await policyModel.rmBulk(oldPolicies.map((policy) => policy.id.toString()));

    const added: string[] = [];
    try {
      for (const policy of req.body) {
        added.push((await policyModel.add(policy, validate.appId)).id.toString());
      }
    } catch (err: unknown) {
      // The app is left with the policies it had, rather than some of the new ones
      try {
        if (added.length > 0) await policyModel.rmBulk(added);
        for (const policy of oldPolicies) await policyModel.add(policy as PolicyAddBody, validate.appId);
      } catch (restoreErr: unknown) {
        this.log(
          `[${this.name}] Failed to put back the app's policies: ${Helpers.getThrownErrorMessage(restoreErr)}`,
          Route.LogLevel.ERR,
        );
      }
      throw err;
    }

    this._nrp?.emit(
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
class PolicyCount extends Route {
  constructor(services: Services) {
    super(`policy/count`, `COUNT POLICIES`, services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.activityDescription = `COUNT POLICIES`;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<CountBody<Policy> | undefined>, _res: Response) {
    const result: QueryParams<Policy> = {
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

    // Before parseQuery, which drops an empty $and
    if (req.context.token?.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      result.query.$and?.push({
        _appId: req.context.authApp?.id,
      });
    }

    result.query = Model.getCoreModel(PolicySchemaModel).parseQuery(
      result.query,
      {},
      Model.getCoreModel(PolicySchemaModel).flatSchemaData,
    );

    return result;
  }

  override _exec(req: Request, res: Response, validateResult: QueryParams<Policy>) {
    return Model.getCoreModel(PolicySchemaModel).count(validateResult.query);
  }
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
      throw new Helpers.Errors.RequestError(500, `missing_app_id`);
    }

    if (!req.body || !req.body.name) {
      this.log(`[${this.name}] Missing required policy transient name field`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `missing_field`);
    }

    // streamFirst() rejects rather than resolving falsy when the stream ends with no data,
    // so an empty result has to be caught here to surface the intended 400 error.
    let policy: Policy | null;
    try {
      policy = await Helpers.streamFirst<Policy>(
        // Policy names are only unique within an app, so another app's policy of the same name is left alone
        await Model.getCoreModel(PolicySchemaModel).find({
          name: req.body.name,
          _appId: Model.getCoreModel(AppSchemaModel).createId(appId),
        }),
      );
    } catch (_err: unknown) {
      policy = null;
    }
    if (!policy) {
      this.log(`[${this.name}] Cannot find a policy with name ${req.body.name}`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `policy_does_not_exist`);
    }

    return {
      appId,
      policy,
    };
  }

  override async _exec(_req: Request, _res: Response, validate: { appId: string; policy: Policy }) {
    if (!validate) return true;

    await Model.getCoreModel(PolicySchemaModel).rm(validate.policy.id.toString());

    this._nrp?.emit(
      'app-policy:bust-cache',
      JSON.stringify({
        appId: validate.appId,
      }),
    );

    // Trigger socket process to re-evaluate rooms
    this._nrp?.emit(
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
      throw new Helpers.Errors.RequestError(400, `missing_field`);
    }

    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log('ERROR: Missing app id', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(500, `missing_app_id`);
    }

    const policy = await Model.getCoreModel(PolicySchemaModel).findOne({
      _id: Model.getCoreModel(PolicySchemaModel).createId(req.params.id),
      ...this._tenantFilter(req),
    });
    if (!policy) {
      this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    return {
      appId,
      policy,
    };
  }

  override async _exec(req: Request, res: Response, validate: { appId: string; policy: Policy }) {
    await Model.getCoreModel(PolicySchemaModel).rm(validate.policy.id.toString());

    this._nrp?.emit(
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
      throw new Helpers.Errors.RequestError(500, `missing_app_id`);
    }

    const rxsPolicies =
      req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM
        ? await Model.getCoreModel(PolicySchemaModel).findAll()
        : await Model.getCoreModel(PolicySchemaModel).find({
            _appId: Model.getCoreModel(AppSchemaModel).adapter.ID.new(req.context.authApp.id),
          });

    const policies = await Helpers.streamAll<Policy>(rxsPolicies);

    return policies.map((p) => p.id.toString());
  }

  override _exec(req: Request, res: Response, validate: string[]) {
    return new Promise((resolve, reject) => {
      Model.getCoreModel(PolicySchemaModel)
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
