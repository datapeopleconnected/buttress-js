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
import { CoreBulkUpdate, CoreCount, CoreRouteConfig, CoreSearch, CoreUpdateByPath } from '../core-routes.js';
import Model from '../../model/index.js';
import { invalidEntityError, validateSchemaObject } from '../../model/shared.js';
import Datastore from '../../datastore/index.js';
import * as Helpers from '../../helpers/index.js';

import SecureStoreSchemaModel, { SecureStore, SecureStoreAddBody } from '../../model/core/secure-store.js';
import { Services } from '../../bootstrap.js';
import type { CoreRouteClass, RequestWithBody } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

const invalidId = () => Helpers.Errors.badRequest('invalid_id', 'The id is not valid');

/**
 * @class AddSecureStore
 */
class AddSecureStore extends Route {
  constructor(services: Services) {
    super('secure-store', 'ADD SECURE STORE', services, Model.getCoreModel(SecureStoreSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  override async _validate(req: RequestWithBody<SecureStoreAddBody>, _res: Response) {
    const app = req.context.authApp;

    if (!app || !req.body?.name) {
      this.log(`[${this.name}] Missing required secure store field`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    // Read as the schema types it, before its name is looked for
    const validation = validateSchemaObject(SecureStoreSchemaModel.Schema, req.body);
    if (!validation.isValid) {
      const err = invalidEntityError(SecureStoreSchemaModel.Schema.name, validation);
      this.log(`[${this.name}] ${err.message}`, Route.LogLevel.ERR);
      return Promise.reject(err);
    }

    const secureStoreExist = await this.scoped(req, SecureStoreSchemaModel).findOne({
      name: req.body.name,
      _appId: app.id,
    });
    if (secureStoreExist) {
      this.log('ERROR: Secure Store with this name already exists', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('already_exist'));
    }

    // Authentication refuses a token whose app it can't find, so the app always has an id
    return Promise.resolve({
      appId: app.id,
    });
  }

  override _exec(req: RequestWithBody<SecureStoreAddBody>, _res: Response, validate: { appId: string }) {
    return this.scoped(req, SecureStoreSchemaModel).add(req.body, { _appId: validate.appId });
  }
}
routes.push(AddSecureStore);

/**
 * @class AddManySecureStore
 */
class AddManySecureStore extends Route {
  constructor(services: Services) {
    super('secure-store/bulk/add', 'ADD SECURE STORE', services, Model.getCoreModel(SecureStoreSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  override async _validate(req: RequestWithBody<SecureStoreAddBody[]>, _res: Response) {
    const app = req.context.authApp;

    if (!app) {
      this.log(`[${this.name}] Missing required secure store field`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    if (!Array.isArray(req.body)) {
      this.log(`[${this.name}] Invalid request body`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_body'));
    }

    const missingField = req.body.find((ss) => !ss.name);
    if (missingField) {
      this.log(`[${this.name}] Missing required secure store field`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    const names = req.body.map((ss) => ss.name);
    const repeated = names.find((name, idx) => names.indexOf(name) !== idx);
    if (repeated) {
      this.log(`ERROR: Secure Store name ${repeated} is given more than once`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('already_exist'));
    }

    // Names are unique within an app, as AddSecureStore checks
    for await (const secureStore of req.body) {
      const secureStoreExist = await this.scoped(req, SecureStoreSchemaModel).findOne({
        name: secureStore.name,
        _appId: app.id,
      });
      if (secureStoreExist) {
        this.log(`ERROR: Secure Store with this name ${secureStore.name} already exists`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('already_exist'));
      }
    }

    return Promise.resolve({
      appId: app.id,
    });
  }

  override async _exec(req: RequestWithBody<SecureStoreAddBody[]>, _res: Response, validate: { appId: string }) {
    const secureStores = this.scoped(req, SecureStoreSchemaModel);
    for await (const secureStore of req.body) {
      await secureStores.add(secureStore, { _appId: validate.appId });
    }

    return true;
  }
}
routes.push(AddManySecureStore);

/**
 * @class GetSecureStore
 */
class GetSecureStore extends Route {
  constructor(services: Services) {
    super('secure-store/:id', 'GET SECURE STORE', services, Model.getCoreModel(SecureStoreSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp?.id) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required secure store id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }
    if (!Datastore.getInstance('core').ID.isValid(id)) {
      this.log(`[${this.name}] Invalid secure store id`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_id', 'The id is not valid'));
    }

    const query = {
      _id: Model.getCoreModel(SecureStoreSchemaModel).createId(id),
      _appId: req.context.authApp.id,
    };

    // streamFirst() rejects rather than resolving falsy when the stream ends with no data,
    // so an empty result has to be caught here to surface the intended 400 error.
    let secureStore: SecureStore | null;
    try {
      secureStore = await Helpers.streamFirst<SecureStore>(await this.scoped(req, SecureStoreSchemaModel).find(query));
    } catch (_err: unknown) {
      secureStore = null;
    }
    if (!secureStore) {
      this.log(`[${this.name}] Cannot find a secure store with id ${id}`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.entityNotFound('secureStore', id));
    }

    return secureStore;
  }

  override _exec(req: Request, res: Response, validate: SecureStore) {
    return validate;
  }
}
routes.push(GetSecureStore);

/**
 * @class FindSecureStore
 */
class FindSecureStore extends Route {
  constructor(services: Services) {
    super(
      'secure-store/name/:name',
      'FIND SECURE STORE BY NAME',
      services,
      Model.getCoreModel(SecureStoreSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: RequestWithBody<unknown, { name: string }>, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    const appId = req.context.authApp.id;

    const name = req.params.name;
    if (!name) {
      this.log(`[${this.name}] Missing request parameter`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_field');
    }

    const secureStore = await this.scoped(req, SecureStoreSchemaModel).findOne({
      name: {
        $eq: name,
      },
      _appId: appId,
    });

    if (!secureStore) {
      this.log(`[${this.name}] Cannot find a secure store with name ${name}`, Route.LogLevel.ERR);
      throw Helpers.Errors.notFound('not_found', 'No secure store has that name', { schema: 'secureStore', name });
    }

    return secureStore;
  }

  override _exec(req: Request, res: Response, validate: SecureStore) {
    return validate;
  }
}
routes.push(FindSecureStore);

/**
 * @class UpdateSecureStore
 */
class UpdateSecureStore extends CoreUpdateByPath<SecureStoreSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'secure-store/:id',
    name: 'UPDATE SECURE STORE',
    model: SecureStoreSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.WRITE,
    // A system token too reaches only its own app's secure stores
    scope: 'own-app',
  };
}
routes.push(UpdateSecureStore);

/**
 * @class BulkUpdateSecureStore
 */
class BulkUpdateSecureStore extends CoreBulkUpdate<SecureStoreSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'secure-store/bulk/update',
    name: 'BULK UPDATE SECURE STORE',
    model: SecureStoreSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.WRITE,
    // A system token too reaches only its own app's secure stores
    scope: 'own-app',
    activityBroadcast: false,
  };
}
routes.push(BulkUpdateSecureStore);

/**
 * @class SearchSecureStoreList
 */
class SearchSecureStoreList extends CoreSearch<SecureStoreSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'secure-store',
    name: 'SEARCH SECURE STORE LIST',
    model: SecureStoreSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.LIST,
    // A system token too reaches only its own app's secure stores
    scope: 'own-app',
  };
}
routes.push(SearchSecureStoreList);

/**
 * @class DeleteSecureStore
 */
class DeleteSecureStore extends Route {
  constructor(services: Services) {
    super('secure-store/:id', 'DELETE SECURE STORE', services, Model.getCoreModel(SecureStoreSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    const appId = req.context.authApp.id;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!id) {
      this.log('ERROR: Missing required secure store ID', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    if (!Model.getCoreModel(SecureStoreSchemaModel).isValidId(id)) throw invalidId();
    const secureStore = await this.scoped(req, SecureStoreSchemaModel).findOne({
      _id: Model.getCoreModel(SecureStoreSchemaModel).createId(id),
      _appId: appId,
    });

    if (!secureStore) {
      this.log(`[${this.name}] Cannot find a secure store with ID ${id}`, Route.LogLevel.ERR);
      throw Helpers.Errors.entityNotFound('secureStore', id);
    }

    return secureStore;
  }

  override async _exec(req: Request, res: Response, secureStore: SecureStore) {
    await this.scoped(req, SecureStoreSchemaModel).rm(secureStore.id);
    return true;
  }
}
routes.push(DeleteSecureStore);

/**
 * @class SecureStoreCount
 */
class SecureStoreCount extends CoreCount<SecureStoreSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'secure-store/count',
    name: 'COUNT SECURE STORES',
    model: SecureStoreSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.SEARCH,
    // A system token too reaches only its own app's secure stores
    scope: 'own-app',
  };
}
routes.push(SecureStoreCount);

/**
 * @type {*[]}
 */
export default routes;
