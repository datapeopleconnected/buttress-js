/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import ButtressExport from '@buttress/api';
// TODO: Look into why the export from @buttress/api is not working as expected.
const { default: ButtressAPI } = ButtressExport;

import { Schema } from '../../helpers/schema.js';
import Logging from '../../helpers/logging.js';
import * as Helpers from '../../helpers/index.js';

import StandardModel from '../type/standard.js';
import TokenSchemaModel from './token.js';
import PolicySchemaModel from './policy.js';
import AppDataSharingSchemaModel from './app-data-sharing.js';
import UserSchemaModel from './user.js';
import DeploymentSchemaModel from './deployment.js';
import LambdaSchemaModel from './lambda.js';
import LambdaExecutionSchemaModel from './lambda-execution.js';

export interface App {
  id: string;
  name: string;
  version: string;
  apiPath: string;
  policyPropertiesList: any;
  adminActive: boolean;
  oAuth: string[];
  suspend: Date | null;
  _tokenId: string;
  __schema: string;
  __rawSchema: string;
  datastore: {
    connectionString: string | null;
  };
}

export default class AppSchemaModel extends StandardModel {
  static name = 'App';

  private _localSchema: any;

  constructor(services) {
    const schema = AppSchemaModel.Schema;
    super(schema, null, services);

    this._localSchema = null;
  }

  static get Constants() {
    return {
      PUBLIC_DIR: true,
    };
  }
  get Constants() {
    return AppSchemaModel.Constants;
  }

  static get Schema(): Schema {
    return {
      name: 'apps',
      type: 'collection',
      extends: [],
      core: true,
      properties: {
        name: {
          __type: 'string',
          __default: null,
          __allowUpdate: true,
        },
        version: {
          __type: 'string',
          __default: null,
          __allowUpdate: true,
        },
        apiPath: {
          __type: 'string',
          __default: null,
          __allowUpdate: true,
        },
        policyPropertiesList: {
          __type: 'object',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        adminActive: {
          __type: 'boolean',
          __default: false,
          __required: false,
          __allowUpdate: false,
        },
        oAuth: {
          __type: 'array',
          __itemtype: 'string',
          __allowUpdate: true,
          __enum: ['GOOGLE', 'MICROSOFT', 'LOCAL_STRATEGY'],
        },
        suspend: {
          __type: 'date',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        _tokenId: {
          __type: 'id',
          __required: false,
          __allowUpdate: false,
        },
        __schema: {
          __type: 'string',
          __required: false,
          __default: '[]',
          __allowUpdate: true,
        },
        __rawSchema: {
          __type: 'string',
          __required: false,
          __default: '[]',
          __allowUpdate: true,
        },
        datastore: {
          connectionString: {
            __type: 'string',
            __default: null,
            __allowUpdate: true,
          },
        },
      },
    };
  }

  /**
   * @param {Object} body - body passed through from a POST request
   * @return {Promise} - fulfilled with App Object when the database request is completed
   */
  async add(body, internals?: { type?: string }) {
    body.id = this.createId();

    const isSuper = internals?.type === TokenSchemaModel.Constants.Type.SYSTEM;
    if (isSuper) {
      const adminToken = await this.__modelManager
        .getCoreModel(TokenSchemaModel)
        .findOne({ type: { $eq: TokenSchemaModel.Constants.Type.SYSTEM } });

      if (adminToken) {
        return Promise.reject(new Helpers.Errors.RequestError(400, `This Buttress instance already have a system app`));
      }
    }

    const rxsToken = await this.__modelManager.getCoreModel(TokenSchemaModel).add(
      {
        type: isSuper ? TokenSchemaModel.Constants.Type.SYSTEM : TokenSchemaModel.Constants.Type.APP,
      },
      {
        _appId: body.id,
      },
    );

    const token: any = await Helpers.streamFirst(rxsToken);

    const rxsApp = await super.add(body, { _tokenId: token.id });
    const app: any = await Helpers.streamFirst(rxsApp);

    if (!isSuper) await this.__handleAddingNonSystemApp(body, token);

    Logging.logSilly(`Emitting app-routes:bust-cache`);
    this.__nrp?.emit('app-routes:bust-cache', '{}');
    Logging.logSilly(`Emitting app:created ${app.id}`);
    this.__nrp?.emit('app:created', JSON.stringify({ appId: app.id }));
    Logging.logSilly(`Emitting app-schema:updated ${app.id}`);
    this.__nrp?.emit('app-schema:updated', JSON.stringify({ appId: app.id }));

    Logging.logSilly(`Emitting app-policy:bust-cache ${app.id}`);
    this.__nrp?.emit(
      'app-policy:bust-cache',
      JSON.stringify({
        appId: app.id,
      }),
    );

    return Promise.resolve({ app: app, token: token });
  }

  async __handleAddingNonSystemApp(body, token) {
    let appPolicyPropertiesList = body.policyPropertiesList;
    const list = {
      role: ['APP'],
    };
    const bodyAppListKeys = Object.keys(appPolicyPropertiesList);
    Object.keys(list).forEach((key) => {
      if (bodyAppListKeys.includes(key)) {
        list[key] = list[key].concat(appPolicyPropertiesList[key]).filter((v, idx, arr) => arr.indexOf(v) === idx);
      }
    });
    appPolicyPropertiesList = { ...appPolicyPropertiesList, ...list };

    await this.__modelManager.getCoreModel(PolicySchemaModel).add(
      {
        name: `App Policy - ${body.name}`,
        selection: {
          role: {
            '@eq': 'APP',
          },
        },
        config: [
          {
            verbs: ['%ALL%'],
            schema: ['%APP_SCHEMA%'],
            query: {
              access: '%FULL_ACCESS%',
            },
          },
          {
            verbs: ['GET', 'SEARCH', 'PUT'],
            schema: ['app'],
            query: {
              _id: {
                '@eq': body.id,
              },
            },
          },
          {
            verbs: ['%ALL%'],
            schema: [
              'policy',
              'user',
              'token',
              'lambda',
              'lambdaExecution',
              'deployment',
              'appDataSharing',
              'secureStore',
            ],
            query: {
              _appId: {
                '@eq': body.id,
              },
            },
          },
        ],
      },
      body.id,
    );

    await this.__modelManager.getCoreModel(TokenSchemaModel).setPolicyPropertiesById(token.id.toString(), {
      role: 'APP',
    });

    await this.__modelManager
      .getCoreModel(AppSchemaModel)
      .setPolicyPropertiesList(body.id.toString(), appPolicyPropertiesList);
  }

  async findByApiPath(apiPath) {
    Logging.logSilly(`Find by ApiPath ${apiPath}`);
    const app = await super.findOne({ apiPath: apiPath });

    if (!app) {
      Logging.logSilly(`App not found for ApiPath ${apiPath}`);
      return null;
    }

    Logging.logSilly(`Found app for ApiPath ${apiPath}`);
    return app;
  }

  /**
   * @param {ObjectId} appId - app id which needs to be updated
   * @param {object} compiledSchema - schema object for the app
   * @param {object} rawSchema - encoded raw app schema
   * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
   */
  async updateSchema(appId, compiledSchema, rawSchema?) {
    Logging.logSilly(`Update Schema ${appId}`);

    await super.updateById(appId, { $set: { __schema: Helpers.Schema.encode(compiledSchema) } });

    if (rawSchema) {
      await super.updateById(appId, { $set: { __rawSchema: rawSchema } });
    }

    Logging.logSilly(`Emitting app-schema:updated ${appId}`);
    this.__nrp?.emit('app-schema:updated', JSON.stringify({ appId: appId }));
    this.__nrp?.emit(
      'app:update-schema',
      JSON.stringify({
        appId: appId,
        schemas: compiledSchema,
      }),
    );
    const updatedSchema = (await super.findById(appId))?.__rawSchema;
    return updatedSchema;
  }

  async mergeRemoteSchema(req, collections) {
    const schemaWithRemoteRef = collections.filter((s) => s.remotes);

    // TODO: Check params for any core scheam thats been requested.
    // TODO: Handle mutiple remotes
    const dataSharingSchema = schemaWithRemoteRef.reduce((map, collection) => {
      collection.remotes.forEach((remote) => {
        if (!map[remote.name]) map[remote.name] = [];
        map[remote.name].push(remote.schema);
      });
      return map;
    }, {});

    // TODO: fetch app models & use schema data instead of doing the work here

    // Load DSA for current app
    const requiredDSAs = Object.keys(dataSharingSchema);
    if (requiredDSAs.length > 0) {
      const appDSAs = await Helpers.streamAll(
        await this.__modelManager.getCoreModel(AppDataSharingSchemaModel).find({
          _appId: req.authApp.id,
          name: {
            $in: requiredDSAs,
          },
          active: true,
        }),
      );

      for await (const DSAName of Object.keys(dataSharingSchema)) {
        const DSA = appDSAs.find((dsa) => dsa.name === DSAName);
        if (!DSA) continue;
        // Load DSA

        // TODO: Should being using an adapter via the datastore.
        const api = ButtressAPI.new();
        await api.init({
          buttressUrl: DSA.remoteApp.endpoint,
          apiPath: DSA.remoteApp.apiPath,
          appToken: DSA.remoteApp.token,
          allowUnauthorized: true, // Move along, nothing to see here...
          version: 1,
        });

        if (!api.App) {
          throw new Error('Unable to load DSA due to missing App API');
        }

        const remoteSchema = await api.App.getSchema(false, {
          params: {
            only: dataSharingSchema[DSAName].join(','),
          },
        });

        remoteSchema.forEach((rs) => {
          schemaWithRemoteRef
            .filter((s) => s.remotes && s.remotes.some((r) => r.name === DSAName && r.schema === rs.name))
            .forEach((s) => {
              // Merge RS into schema
              const collectionIdx = collections.findIndex((s) => s.name === rs.name);
              if (collectionIdx === -1) return;
              collections[collectionIdx] = Helpers.mergeDeep(rs, s);
            });
        });
      }
    }

    return collections;
  }

  setLocalSchema(schema) {
    this._localSchema = schema;
  }

  get localSchema() {
    return this._localSchema;
  }

  /**
   * @param {Object} appId - The App ID of the app to update
   * @param {Object} appPolicyPropertiesList - App policy property list
   * @return {Promise} - resolves when save operation is completed
   */
  async setPolicyPropertiesList(appId: string, appPolicyPropertiesList) {
    return super.updateById(appId, { $set: { policyPropertiesList: appPolicyPropertiesList } });
  }

  /**
   * @return {Promise} - resolves to the token
   */
  getToken(app) {
    return this.__modelManager.getCoreModel(TokenSchemaModel).findOne({ id: app._tokenId });
  }

  /**
   * @param {App} entity - entity object to be deleted
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  async rm(entity) {
    Logging.logSilly(`Deleting all app data sharing for app ${entity.id}`);
    await this.__modelManager.getCoreModel(AppDataSharingSchemaModel).rmAll({ _appId: entity.id });

    Logging.logSilly(`Deleting all tokens for app ${entity.id}`);
    await this.__modelManager.getCoreModel(TokenSchemaModel).rmAll({ _appId: entity.id });

    Logging.logSilly(`Deleting all users for app ${entity.id}`);
    await this.__modelManager.getCoreModel(UserSchemaModel).rmAll({ _appId: entity.id });

    // TODO: Delete all lambdas
    Logging.logSilly(`Deleting all lambdas for app ${entity.id}`);
    await this.__modelManager.getCoreModel(LambdaSchemaModel).rmAll({ _appId: entity.id });

    // TODO: Delete all deployments
    Logging.logSilly(`Deleting all deployments for app ${entity.id}`);
    await this.__modelManager.getCoreModel(DeploymentSchemaModel).rmAll({ _appId: entity.id });

    // TODO: Delete all lambda executions
    Logging.logSilly(`Deleting all lambda executions for app ${entity.id}`);
    await this.__modelManager.getCoreModel(LambdaExecutionSchemaModel).rmAll({ _appId: entity.id });

    // TODO: Delete all policy
    Logging.logSilly(`Deleting all policy for app ${entity.id}`);
    await this.__modelManager.getCoreModel(PolicySchemaModel).rmAll({ _appId: entity.id });

    Logging.logSilly(`Deleting schema for app ${entity.id}`);
    await this.__modelManager.dropAndCleanAppModels(entity.id);

    const payload = JSON.stringify({ appId: entity.id, apiPath: entity.apiPath });

    // ? We don't know that his is being called within the rest worker...
    this.__nrp?.emit('rest:worker:rebuild-path-mutation-cache', payload);
    this.__nrp?.emit('rest:worker:app-deleted', payload);

    return super.rm(entity.id.toString());
  }

  /**
   * @param {string} appId - app entity object to be updated
   * @param {array} oAuth - oAuth options for the app
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  async updateOAuth(appId, oAuth) {
    return super.updateById(this.createId(appId), { $set: { oAuth: oAuth } });
  }
}
