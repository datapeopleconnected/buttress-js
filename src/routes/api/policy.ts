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
import { ObjectId } from 'bson';
import { Response, Request } from 'express';

import Route from '../route.js';
import Model from '../../model/index.js';
import * as Helpers from '../../helpers/index.js';

import Datastore from '../../datastore/index.js';
import PolicySchemaModel, { Policy } from '../../model/core/policy.js';
import TokenSchemaModel from '../../model/core/token.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import AppSchemaModel from '../../model/core/app.js';

const routes: (typeof Route)[] = [];

/**
 * @class GetPolicy
 */
class GetPolicy extends Route {
  constructor(services) {
    super('policy/:id', 'GET POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.READ;
  }

  async _validate(req: Request, _res: Response) {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!id) {
      this.log(`[${this.name}] Missing required policy id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_policy_id`));
    }
    if (!ObjectId.isValid(id)) {
      this.log(`[${this.name}] Invalid policy id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_id`));
    }

    const policy = await Model.getCoreModel(PolicySchemaModel).findById(id);
    if (!policy) {
      this.log(`[${this.name}] Cannot find a policy with id id`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `policy_does_not_exist`));
    }

    return policy;
  }

  _exec(req: Request, res: Response, policy) {
    return policy;
  }
}
routes.push(GetPolicy);

/**
 * @class GetPolicyList
 */
class GetPolicyList extends Route {
  constructor(services) {
    super('policy', 'GET POLICY LIST', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  _validate(req: Request, _res: Response) {
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
          Datastore.getInstance('core').ID.new(id);
        } catch (err) {
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

  _exec(req: Request, res: Response, validate: { appId: string; ids: string[] }) {
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
  constructor(services) {
    super('policy', 'SEARCH POLICY LIST', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  async _validate(req: Request, res: Response) {
    const result: {
      query: any;
      skip: number;
      limit: number;
      sort: any;
      project: any;
    } = {
      query: {
        $and: [],
      },
      skip: req.body && req.body.skip ? parseInt(req.body.skip) : 0,
      limit: req.body && req.body.limit ? parseInt(req.body.limit) : 0,
      sort: req.body && req.body.sort ? req.body.sort : {},
      project: req.body && req.body.project ? req.body.project : false,
    };

    if (isNaN(result.skip)) throw new Helpers.Errors.RequestError(400, `invalid_value_skip`);
    if (isNaN(result.limit)) throw new Helpers.Errors.RequestError(400, `invalid_value_limit`);

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    }

    result.query = Model.getCoreModel(PolicySchemaModel).parseQuery(
      result.query,
      {},
      Model.getCoreModel(PolicySchemaModel).flatSchemaData,
    );
    return result;
  }

  _exec(req: Request, res: Response, validate) {
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
  constructor(services) {
    super('policy', 'ADD POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  async _validate(req: Request, res: Response) {
    const app = req.context.authApp;
    try {
      if (!app || !req.body.selection || !req.body.name || !req.body.config || req.body.config.length < 1) {
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
    } catch (err) {
      return Promise.reject(err);
    }
  }

  _exec(req: Request, res: Response, validate: { appId: string }) {
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
  constructor(services) {
    super('policy/:id', 'UPDATE POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  _validate(req: Request, res: Response) {
    return new Promise((resolve, reject) => {
      const { validation, body } = Model.getCoreModel(PolicySchemaModel).validateUpdate(req.body);
      req.body = body;
      if (!validation.isValid) {
        if (validation.isPathValid === false) {
          this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
          return reject(
            new Helpers.Errors.RequestError(400, `POLICY: Update path is invalid: ${validation.invalidPath}`),
          );
        }
        if (validation.isValueValid === false) {
          this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
          return reject(
            new Helpers.Errors.RequestError(400, `POLICY: Update value is invalid: ${validation.invalidValue}`),
          );
        }
      }

      Model.getCoreModel(PolicySchemaModel)
        .exists(req.params.id)
        .then((exists) => {
          if (!exists) {
            this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
            return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
          }
          resolve(true);
        });
    });
  }

  _exec(req: Request, res: Response, validate) {
    // Update Policy cache

    return Model.getCoreModel(PolicySchemaModel).updateByPath(req.body, req.params.id);
  }
}
routes.push(UpdatePolicy);

/**
 * @class BulkUpdatePolicy
 */
class BulkUpdatePolicy extends Route {
  constructor(services) {
    super('policy/bulk/update', 'UPDATE POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  async _validate(req: Request, res: Response) {
    for await (const item of req.body) {
      const { validation, body } = Model.getCoreModel(PolicySchemaModel).validateUpdate(item.body);
      item.body = body;
      if (!validation.isValid) {
        if (validation.isPathValid === false) {
          this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
          return Promise.reject(
            new Helpers.Errors.RequestError(400, `POLICY: Update path is invalid: ${validation.invalidPath}`),
          );
        }
        if (validation.isValueValid === false) {
          this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
          return Promise.reject(
            new Helpers.Errors.RequestError(400, `POLICY: Update value is invalid: ${validation.invalidValue}`),
          );
        }
      }

      const exists = Model.getCoreModel(PolicySchemaModel).exists(item.id);
      if (!exists) {
        this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
      }
    }

    return req.body;
  }

  async _exec(req: Request, res: Response, validate) {
    for await (const item of validate) {
      await Model.getCoreModel(PolicySchemaModel).updateByPath(item.body, item.id);
    }
    return true;
  }
}
routes.push(BulkUpdatePolicy);

/**
 * @class SyncPolicies
 */
class SyncPolicies extends Route {
  constructor(services) {
    super('policy/sync', 'SYNC POLICIES', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  async _validate(req: Request, _res: Response) {
    const app = req.context.authApp;

    if (!app || !req.body) {
      this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `missing_field`);
    }

    if (!Array.isArray(req.body)) {
      this.log(`[${this.name}] invalid field`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `invalid_field`);
    }

    for (const policy of req.body) {
      if (!policy.selection || !policy.name) {
        this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
        throw new Helpers.Errors.RequestError(400, `missing_field`);
      }
    }

    return {
      appId: app.id,
    };
  }

  async _exec(req: Request, res: Response, validate: { appId: string }) {
    await Model.getCoreModel(PolicySchemaModel).rmAll({
      _appId: validate.appId,
    });

    for await (const policy of req.body) {
      await Model.getCoreModel(PolicySchemaModel).add(policy, validate.appId);
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
  constructor(services) {
    super(`policy/count`, `COUNT POLICIES`, services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.activityDescription = `COUNT POLICIES`;
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

    query = Model.getCoreModel(PolicySchemaModel).parseQuery(
      query,
      {},
      Model.getCoreModel(PolicySchemaModel).flatSchemaData,
    );
    result.query = query;
    return result;
  }

  _exec(req: Request, res: Response, validateResult) {
    return Model.getCoreModel(PolicySchemaModel).count(validateResult.query);
  }
}
routes.push(PolicyCount);

routes.push(SyncPolicies);

/**
 * @class DeleteTransientPolicy
 */
class DeleteTransientPolicy extends Route {
  constructor(services) {
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

  async _validate(req: Request, _res: Response) {
    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log(`[${this.name}] Missing app id`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(500, `missing_app_id`);
    }

    if (!req.body || !req.body.name) {
      this.log(`[${this.name}] Missing required policy transient name field`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `missing_field`);
    }

    const policy = await Helpers.streamFirst(await Model.getCoreModel(PolicySchemaModel).find({ name: req.body.name }));
    if (!policy) {
      this.log(`[${this.name}] Cannot find a policy with name ${req.body.name}`, Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `policy_does_not_exist`);
    }

    return {
      appId,
      policy,
    };
  }

  async _exec(_req: Request, _res: Response, validate: { appId: string; policy: Policy }) {
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
  constructor(services) {
    super('policy/:id', 'DELETE POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  async _validate(req) {
    if (!req.params.id) {
      this.log('ERROR: Missing required field', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `missing_field`);
    }

    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log('ERROR: Missing app id', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(500, `missing_app_id`);
    }

    const policy = await Model.getCoreModel(PolicySchemaModel).findById(req.params.id);
    if (!policy) {
      this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    return {
      appId,
      policy,
    };
  }

  async _exec(req: Request, res: Response, validate: { appId: string; policy: Policy }) {
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
  constructor(services) {
    super('policy', 'DELETE ALL APP POLICIES', services, Model.getCoreModel(PolicySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  async _validate(req) {
    const rxsPolicies =
      req.token && req.token.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM
        ? await Model.getCoreModel(PolicySchemaModel).findAll()
        : await Model.getCoreModel(PolicySchemaModel).find({
            _appId: Model.getCoreModel(AppSchemaModel).adapter.ID.new(req.authApp.id),
          });

    const policies: any[] = [];
    for await (const policy of rxsPolicies) {
      policies.push(policy);
    }

    return policies.map((p) => p.id.toString());
  }

  _exec(req: Request, res: Response, validate: string[]) {
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
