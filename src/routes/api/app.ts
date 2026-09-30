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
import Sugar from '../../helpers/sugar.js';
import Logging from '../../helpers/logging.js';
import * as Helpers from '../../helpers/index.js';
import AppSchemaModel, { App, AppAddBody } from '../../model/core/app.js';
import TokenSchemaModel, { Token } from '../../model/core/token.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import { Schema } from '../../helpers/schema.js';
import { QueryParams } from '../../types/bjs-query.js';
import { UpdatePathBody } from '../../types/datastore.js';
import { Services } from '../../bootstrap.js';
import type { CoreRouteClass, CountBody, RequestWithBody, SearchBody } from '../../types/routes.js';

/**
 * @class GetAppList
 */
class GetAppList extends Route {
  constructor(services: Services) {
    super('app', 'GET APP LIST', services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  override _validate(_req: Request, _res: Response) {
    return Promise.resolve(true);
  }

  override _exec(req: Request, _res: Response, _validate: boolean) {
    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log('ERROR: No App ID in token', Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `invalid_token`);
    }

    if (req.context.token?.type !== Route.Constants.Type.SYSTEM) {
      return Model.getCoreModel(AppSchemaModel).find({ id: appId });
    }

    return Model.getCoreModel(AppSchemaModel).findAll();
  }
}

/**
 * @class SearchAppList
 */
class SearchAppList extends Route {
  constructor(services: Services) {
    super('app', 'GET APP LIST', services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.SEARCH;
  }

  override async _validate(req: RequestWithBody<SearchBody<App> | undefined>, _res: Response) {
    const result: QueryParams<App> = {
      query: {},
    };
    result.query.$and = [];

    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    }

    // Before parseQuery, which drops an empty $and
    if (req.context.token?.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      result.query.$and?.push({
        id: req.context.authApp?.id,
      });
    }

    result.query = Model.getCoreModel(AppSchemaModel).parseQuery(
      result.query,
      {},
      Model.getCoreModel(AppSchemaModel).flatSchemaData,
    );

    return result;
  }

  override async _exec(req: Request, res: Response, validate: QueryParams<App>) {
    const appsDB = await Helpers.streamAll<App>(await Model.getCoreModel(AppSchemaModel).find(validate.query));

    // A system token gets every app's token value, any other token only its own app's
    const isSystem = req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM;
    const withToken = (app: App) => isSystem || app.id.toString() === req.context.authApp?.id.toString();

    const tokenIds = appsDB.filter(withToken).map((app) => Model.getCoreModel(TokenSchemaModel).createId(app._tokenId));
    const appTokens = await Helpers.streamAll<Token>(
      await Model.getCoreModel(TokenSchemaModel).find({
        id: {
          $in: tokenIds,
        },
      }),
    );

    return appsDB.reduce<Array<App & { tokenValue?: string }>>((arr, app) => {
      if (!withToken(app)) {
        arr.push(app);
        return arr;
      }

      const appToken = appTokens.find((t) => t.id.toString() === app._tokenId.toString());
      arr.push({
        ...app,
        tokenValue: appToken?.value,
      });
      return arr;
    }, []);
  }
}

/**
 * @class GetApp
 */
class GetApp extends Route {
  constructor(services: Services) {
    // Should change to app apiPath instead of ID
    super('app/:id', 'GET APP', services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log('ERROR: Missing required field', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_fields`));
    }

    if (!Model.getCoreModel(AppSchemaModel).isValidId(id)) {
      this.log('ERROR: Invalid App ID format', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }

    const app = await Model.getCoreModel(AppSchemaModel).findById(id);
    if (!app) {
      this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }

    return app;
  }

  override async _exec(req: Request, res: Response, validate: App & { tokenValue?: string }) {
    const appToken: Token | null = await Model.getCoreModel(TokenSchemaModel).findById(
      Model.getCoreModel(TokenSchemaModel).createId(validate._tokenId),
    );
    validate.tokenValue = appToken?.value;

    return validate;
  }
}

/**
 * @class AddApp
 */
class AddApp extends Route {
  constructor(services: Services) {
    super('app', 'APP ADD', services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  override _validate(req: RequestWithBody<AppAddBody>, _res: Response) {
    return new Promise<boolean>((resolve, reject) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        this.log(`${this.schemaName}: Expected the app as an object`, Route.LogLevel.ERR, req.context.id);
        return reject(new Helpers.Errors.RequestError(400, `invalid_body`));
      }

      const validation = Model.getCoreModel(AppSchemaModel).validate(req.body);
      if (!validation.isValid) {
        if (validation.missing.length > 0) {
          this.log(`${this.schemaName}: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.context.id);
          return reject(
            new Helpers.Errors.RequestError(400, `${this.schemaName}: Missing field: ${validation.missing[0]}`),
          );
        }
        if (validation.invalid.length > 0) {
          this.log(`${this.schemaName}: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.context.id);
          return reject(
            new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid value: ${validation.invalid[0]}`),
          );
        }

        this.log(`${this.schemaName}: Unhandled Error`, Route.LogLevel.ERR, req.context.id);
        return reject(new Helpers.Errors.RequestError(400, `${this.schemaName}: Unhandled error.`));
      }

      req.body.policyPropertiesList = req.body.policyPropertiesList || {};
      if (req.body.policyPropertiesList) {
        const policyPropertiesList = Object.keys(req.body.policyPropertiesList).filter((key) => key !== 'query');
        // It's set by now, TypeScript just can't tell inside the callback
        const validPolicyPropertiesList = policyPropertiesList.every((key) =>
          Array.isArray(req.body.policyPropertiesList![key]),
        );
        if (!validPolicyPropertiesList) {
          this.log('ERROR: Invalid policy property list', Route.LogLevel.ERR);
          return reject(new Helpers.Errors.RequestError(400, `invalid_field`));
        }
      }

      Model.getCoreModel(AppSchemaModel)
        .apiPathProblem(req.body.apiPath)
        .then((problem) => {
          if (problem) throw new Helpers.Errors.RequestError(400, problem);
          return Model.getCoreModel(AppSchemaModel).isDuplicate(req.body);
        })
        .then((res) => {
          if (res === true) {
            this.log(`${this.schemaName}: Duplicate entity`, Route.LogLevel.ERR, req.context.id);
            return reject(new Helpers.Errors.RequestError(400, `duplicate`));
          }
          resolve(true);
        })
        .catch(reject);
    });
  }

  override _exec(req: RequestWithBody<AppAddBody>, _res: Response, _validate: boolean) {
    return new Promise((resolve, reject) => {
      Model.getCoreModel(AppSchemaModel)
        .add(req.body)
        .then((res) => {
          this._nrp?.emit('app:configure-lambda-endpoints', res.app.apiPath);

          return Object.assign(res.app, { token: res.token.value });
        })
        .then(Logging.Promise.logProp('Added App', 'name', Route.LogLevel.INFO))
        .then(resolve, reject);
    });
  }
}

/**
 * @class DeleteApp
 */
class DeleteApp extends Route {
  constructor(services: Services) {
    super('app/:id', 'DELETE APP', services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    if (!id) {
      this.log('ERROR: Missing required field', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `missing_field`);
    }

    const app = await Model.getCoreModel(AppSchemaModel).findById(id);
    if (!app) {
      this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    return app;
  }

  override async _exec(req: Request, res: Response, app: App) {
    await Model.getCoreModel(AppSchemaModel).rm(app);
    return true;
  }
}

/**
 * @class DeleteAppPolicies
 */
class DeleteAllApps extends Route {
  constructor(services: Services) {
    super('app', 'DELETE ALL APPS', services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(_req: Request, _res: Response) {
    return true;
  }

  override async _exec(_req: Request, _res: Response, _validate: boolean) {
    // Get a list of system tokens
    const systemTokens = await Helpers.streamAll<Token>(
      await Model.getCoreModel(TokenSchemaModel).find(
        {
          type: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
        },
        {},
        0,
        0,
        {},
        { _appId: 1 },
      ),
    );

    const systemApps = systemTokens.map((t) => t._appId.toString());
    const appApps = await Model.getCoreModel(AppSchemaModel).find(
      { id: { $nin: systemApps } },
      {},
      0,
      0,
      {},
      { id: 1, _tokenId: 1 },
    );

    for await (const app of appApps as AsyncIterable<Pick<App, 'id' | '_tokenId'>>) {
      if (systemApps.includes(app.id.toString())) continue;

      Logging.logDebug(`Deleting app: ${app.id}`);
      // BUG: apiPath isn't projected, so rm can't tell the REST workers which app's routes to deregister
      await Model.getCoreModel(AppSchemaModel).rm(app as App);
    }

    return true;
  }
}

/**
 * @class GetAppSchema
 */
class GetAppSchema extends Route {
  constructor(services: Services) {
    super('app/schema', 'GET APP SCHEMA', services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.USER;
    this.permissions = Route.Constants.Permissions.READ;

    this.redactResults = false;
    this.addSourceId = false;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `no_authenticated_app`);
    }

    if (!req.context.authApp.__schema) {
      this.log('ERROR: No app schema defined', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `no_authenticated_schema`);
    }

    let schema: Schema[];
    try {
      schema =
        req.query.rawSchema && req.context.authApp.__rawSchema
          ? Helpers.Schema.decode(req.context.authApp.__rawSchema)
          : await Helpers.Schema.buildCollections(Helpers.Schema.decode(req.context.authApp.__schema));
    } catch (err: unknown) {
      if (err instanceof Helpers.Errors.SchemaInvalid) throw new Helpers.Errors.RequestError(400, `invalid_schema`);
      else throw err;
    }

    if (req.query.core) {
      const cores = req.query.core
        .toString()
        .split(',')
        .map((core) => core.trim())
        .filter((core) => core);

      // A core schema can be named more than once (user,users), but is returned once.
      const coreSchemas = new Set<Schema>();
      for (const core of cores) {
        const coreModel = this.__findCoreModel(core);
        if (!coreModel) {
          this.log(`ERROR: Unknown core schema: ${core}`, Route.LogLevel.ERR);
          throw new Helpers.Errors.RequestError(400, `Unknown core schema: ${core}`);
        }
        if (coreModel.isCoreAPI) coreSchemas.add(coreModel.schemaData);
      }
      schema.push(...coreSchemas);
    }

    if (req.query.only) {
      const only = req.query.only.toString().split(',');
      schema = schema.filter((s) => only.includes(s.name));
    }

    return schema;
  }

  // Takes a core model's name (user, app-data-sharing) or its schema's own name (users, appDataSharing).
  __findCoreModel(name: string) {
    return Model.getCoreModelByName(Sugar.String.camelize(name)) ?? Model.getCoreModelBySchemaName(name);
  }

  override async _exec(req: Request, res: Response, collections: Schema[]) {
    const mergedSchema = req.query.rawSchema
      ? collections
      : await Model.getCoreModel(AppSchemaModel).mergeRemoteSchema(req, collections);

    // Quicky, remove extends as nobody needs it outside of buttress
    mergedSchema.forEach((s) => delete s.extends);

    // TODO: Policy should be used to dictate what schema the user can access.

    // Filter the returned schema based token role

    return mergedSchema;
  }
}

/**
 * @class UpdateAppSchema
 */
class UpdateAppSchema extends Route {
  constructor(services: Services) {
    super('app/schema', 'UPDATE APP SCHEMA', services, Model.getCoreModel(AppSchemaModel).schemaData);

    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.redactResults = false;
    this.addSourceId = false;
  }

  override async _validate(req: RequestWithBody<unknown>, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
    }
    if (!req.body) {
      this.log('ERROR: Missing body', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `no_body`));
    }
    if (!Array.isArray(req.body)) {
      this.log(`ERROR: Expected body to be an array but got ${typeof req.body}`, Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_body_type`));
    }

    const rawSchema: unknown[] = req.body;

    const checkedSchema: Schema[] = [];
    // Check the validatiry of the rawSchema
    try {
      for (let i = 0; i < rawSchema.length; i++) {
        const schema = rawSchema[i] as Schema;
        if (!schema.name) {
          this.log(`ERROR: Missing name for schema at index ${i}`, Route.LogLevel.ERR);
          return Promise.reject(new Helpers.Errors.RequestError(400, `schema_missing_name`));
        }
        if (!schema.type) {
          this.log(`ERROR: Missing type for schema at index ${i}`, Route.LogLevel.ERR);
          return Promise.reject(new Helpers.Errors.RequestError(400, `schema_missing_type`));
        }

        if (schema.name.length < 1 || schema.name.length > 20) {
          this.log(
            `ERROR: Schema name needs to be between 1 and 20 alphanumeric characters (${schema.name})`,
            Route.LogLevel.ERR,
          );
          return Promise.reject(new Helpers.Errors.RequestError(400, `schema_invalid_name`));
        }
        if (!/^[a-zA-Z0-9]+$/.test(schema.name)) {
          this.log(`ERROR: Schema name can only contain alphanumeric characters (${schema.name})`, Route.LogLevel.ERR);
          return Promise.reject(new Helpers.Errors.RequestError(400, `schema_invalid_name`));
        }

        if (!Helpers.Schema.validTypes.includes(schema.type)) {
          this.log(`ERROR: Invalid schema type (${schema.type})`, Route.LogLevel.ERR);
          return Promise.reject(new Helpers.Errors.RequestError(400, `schema_invalid_type`));
        }

        checkedSchema.push(schema);
      }
    } catch (err: unknown) {
      Logging.logError(Helpers.getThrownErrorMessage(err));
      throw err;
    }

    // Sort templates
    let compiledSchema = checkedSchema.sort((a, b) =>
      a.type.indexOf('collection') === 0 ? 1 : b.type.indexOf('collection') === 0 ? -1 : 0,
    );

    try {
      compiledSchema = await Model.getCoreModel(AppSchemaModel).mergeRemoteSchema(req, compiledSchema);

      // Merge any schema extends
      compiledSchema = Helpers.Schema.merge(compiledSchema, Model.getCoreModel(AppSchemaModel).localSchema || []);

      // building the schema to check for any timeseries
      compiledSchema = await Helpers.Schema.buildCollections(compiledSchema);

      // merging the built timeseries to get the extends schemas
      compiledSchema = Helpers.Schema.merge(compiledSchema, Model.getCoreModel(AppSchemaModel).localSchema || []);

      return {
        appId: req.context.authApp.id,
        rawSchema: JSON.stringify(rawSchema),
        compiledSchema,
      };
    } catch (err: unknown) {
      Logging.logError(Helpers.getThrownErrorMessage(err));
      throw new Helpers.Errors.RequestError(400, `invalid_body_type`);
    }
  }

  override async _exec(
    _req: Request,
    _res: Response,
    { appId, rawSchema, compiledSchema }: { appId: string; rawSchema: string; compiledSchema: Schema[] },
  ) {
    await Model.getCoreModel(AppSchemaModel).updateSchema(appId, compiledSchema, rawSchema);

    const a = compiledSchema
      .filter((s) => s.type === 'collection')
      .map((s) => {
        delete s.extends;
        return s;
      });

    return a;
  }
}

/**
 * @class GetAppPolicyPropertyList
 */
class GetAppPolicyPropertyList extends Route {
  constructor(services: Services) {
    super(
      'app/policy-property-list{/:apiPath}',
      'GET APP POLICY PROPERTY LIST',
      services,
      Model.getCoreModel(AppSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: Request, _res: Response) {
    let app = req.context.authApp;
    if (!app) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
    }

    const apiPath = req.params.apiPath;
    const isSuper = req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM;
    if (apiPath && apiPath !== app.apiPath && !isSuper) {
      this.log('ERROR: Cannot fetch policy properties list for another app', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `cannot_fetch_list_for_another_app`));
    }

    if (apiPath) {
      app = await Model.getCoreModel(AppSchemaModel).findOne({
        apiPath: {
          $eq: apiPath,
        },
      });
    }

    return app;
  }

  override async _exec(req: Request, res: Response, app: App | null) {
    // BUG: app is null if no app has the requested apiPath, which throws here
    return app!.policyPropertiesList;
  }
}

/**
 * @class SetAppPolicyPropertyList
 */
class SetAppPolicyPropertyList extends Route {
  constructor(services: Services) {
    super(
      'app/policy-property-list/:update{/:appId}',
      'SET APP POLICY PROPERTY LIST',
      services,
      Model.getCoreModel(AppSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override _validate(req: RequestWithBody<App['policyPropertiesList']>, _res: Response) {
    return new Promise<{ appId: string }>((resolve, reject) => {
      if (!req.context.authApp) {
        this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
        return reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
      }

      if (!req.body) {
        this.log('ERROR: Missing body', Route.LogLevel.ERR);
        return reject(new Helpers.Errors.RequestError(400, `no_body`));
      }

      if (typeof req.body !== 'object' || (typeof req.body === 'object' && Array.isArray(req.body))) {
        this.log('ERROR: Policy property list is invalid type', Route.LogLevel.ERR);
        return reject(new Helpers.Errors.RequestError(400, `invalid_type`));
      }

      const policyPropertiesList = Object.keys(req.body).filter((key) => key !== 'query');
      const validPolicyPropertiesList = policyPropertiesList.every((key) => Array.isArray(req.body[key]));
      if (!validPolicyPropertiesList) {
        this.log('ERROR: Invalid policy property list', Route.LogLevel.ERR);
        return reject(new Helpers.Errors.RequestError(400, `invalid_field`));
      }

      const app = req.context.authApp;

      if (req.params.update === 'true') {
        const currentAppListKeys = app.policyPropertiesList !== null ? Object.keys(app.policyPropertiesList) : [];
        Object.keys(req.body).forEach((key) => {
          if (currentAppListKeys.includes(key)) {
            // Each list was checked to be an array above
            req.body[key] = (req.body[key] as Extract<App['policyPropertiesList'][string], unknown[]>)
              .concat(app.policyPropertiesList[key])
              .filter((v, idx, arr) => arr.indexOf(v) === idx);
          }
        });
        const postedPropsList = Object.keys(req.body).reduce<App['policyPropertiesList']>((obj, key) => {
          if (key === 'query') return obj;

          obj[key] = req.body[key];
          return obj;
        }, {});
        req.body = { ...app.policyPropertiesList, ...postedPropsList };
      }

      resolve({
        appId: app.id,
      });
    });
  }

  override async _exec(req: RequestWithBody<App['policyPropertiesList']>, res: Response, { appId }: { appId: string }) {
    const update = Object.assign({}, req.body);
    if (update.query) delete update.query;

    await Model.getCoreModel(AppSchemaModel).setPolicyPropertiesList(appId.toString(), update);
    return update;
  }
}

/**
 * @class AppCount
 */
class AppCount extends Route {
  constructor(services: Services) {
    super(`app/count`, `COUNT APPS`, services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.activityDescription = `COUNT APPS`;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<CountBody<App> | undefined>, _res: Response) {
    const result: QueryParams<App> = {
      query: {},
    };
    result.query.$and = [];

    // TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
    if (req.body && req.body.query) {
      result.query.$and.push(req.body.query);
    } else if (req.body && !req.body.query) {
      result.query.$and.push(req.body);
    }

    // Before parseQuery, which drops an empty $and
    if (req.context.token?.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      result.query.$and?.push({
        id: req.context.authApp?.id,
      });
    }

    result.query = Model.getCoreModel(AppSchemaModel).parseQuery(
      result.query,
      {},
      Model.getCoreModel(AppSchemaModel).flatSchemaData,
    );

    return result;
  }

  override _exec(_req: Request, _res: Response, validateResult: QueryParams<App>) {
    return Model.getCoreModel(AppSchemaModel).count(validateResult.query);
  }
}

/**
 * @class AppUpdateOAuth
 */
class AppUpdateOAuth extends Route {
  constructor(services: Services) {
    super(`app/:id/oauth`, `UPDATE APPS OAUTH`, services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityDescription = `UPDATE APPS OAUTH`;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<unknown, { id: string }>, _res: Response) {
    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
    }

    const app = await Model.getCoreModel(AppSchemaModel).findById(req.params.id);
    if (!app) {
      this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }
    return Promise.resolve(true);
  }

  override async _exec(
    req: RequestWithBody<{ value: string | string[] }, { id: string }>,
    _res: Response,
    _validate: boolean,
  ) {
    const oAuth = Array.isArray(req.body.value) ? req.body.value : [req.body.value];
    await Model.getCoreModel(AppSchemaModel).updateOAuth(req.params.id, oAuth);
    return true;
  }
}

// TODO remove all the other endpoints and use this generic endpoint
/**
 * @class AppUpdate
 */
class AppUpdate extends Route {
  constructor(services: Services) {
    super(`app/:id`, `UPDATE AN APP`, services, Model.getCoreModel(AppSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  override async _validate(req: RequestWithBody<unknown>, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log('ERROR: Missing required field', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
    }

    // Only a system token can update an app other than its own, any other id is answered as an unknown one
    const isSystem = req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM;
    if (!isSystem && id !== req.context.authApp?.id) {
      this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }

    const { validation, body } = Model.getCoreModel(AppSchemaModel).validateUpdate(req.body);
    req.body = body;
    if (!validation.isValid) {
      if (validation.isPathValid === false) {
        this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
        return Promise.reject(
          new Helpers.Errors.RequestError(400, `ERROR: Update path is invalid: ${validation.invalidPath}`),
        );
      }
      if (validation.isValueValid === false) {
        this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
        return Promise.reject(
          new Helpers.Errors.RequestError(400, `ERROR: Update value is invalid: ${validation.invalidValue}`),
        );
      }
    }

    const exists = await Model.getCoreModel(AppSchemaModel).exists(id);
    if (!exists) {
      this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
    }

    // A new api path has to be one the app can have
    for (const update of (Array.isArray(body) ? body : [body]) as UpdatePathBody[]) {
      if (update.path !== 'apiPath') continue;
      const problem = await Model.getCoreModel(AppSchemaModel).apiPathProblem(update.value, id);
      if (problem) return Promise.reject(new Helpers.Errors.RequestError(400, problem));
    }
    return {
      id,
    };
  }

  // _validate replaced the body with the validated updates
  override _exec(req: RequestWithBody<UpdatePathBody[]>, _res: Response, validate: { id: string }) {
    return Model.getCoreModel(AppSchemaModel).updateByPath(req.body, validate.id);
  }
}

/**
 * @type {*[]}
 */
export default [
  GetAppList,
  SearchAppList,
  AddApp,
  DeleteApp,
  DeleteAllApps,
  GetAppSchema,
  UpdateAppSchema,
  GetAppPolicyPropertyList,
  SetAppPolicyPropertyList,
  AppCount,
  AppUpdateOAuth,
  AppUpdate,

  // Register get app at the end to avoid conflicts with app list endpoint
  GetApp,
] satisfies CoreRouteClass[];
