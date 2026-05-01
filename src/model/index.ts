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

import * as Helpers from '../helpers/index.js';
import { Schema } from '../helpers/schema.js';
import Logging from '../helpers/logging.js';

import Datastores, { Datastore } from '../datastore/index.js';

import StandardModel from './type/standard.js';
import RemoteCombinedModel from './type/remote-combined.js';

import Activity from './core/activity.js';
import AppDataSharing from './core/app-data-sharing.js';
import Deployment from './core/deployment.js';
import Lambda from './core/lambda.js';
import LambdaExecution from './core/lambda-execution.js';
import Policy from './core/policy.js';
import SecureStore from './core/secure-store.js';
import Token from './core/token.js';
import Tracking from './core/tracking.js';
import User from './core/user.js';
import AppSchemaModel, { App } from './core/app.js';
import AppDataSharingSchemaModel from './core/app-data-sharing.js';

type StandardModelExtended<T extends StandardModel> = new (...args: any[]) => T;

const CoreModels = {
  Activity,
  App: AppSchemaModel,
  AppDataSharing,
  Deployment,
  Lambda,
  LambdaExecution,
  Policy,
  SecureStore,
  Token,
  Tracking,
  User,
};

/**
 * Model manager class used for caching and accessing data models from within Buttress.
 * @class Model
 */
export class ModelManager {
  models: {
    core: {
      [key: string]: StandardModel;
    };
    [key: string]: {
      [key: string]: StandardModel;
    };
  };
  Schema: { [key: string]: any };

  Constants: { [key: string]: any };

  app: any;

  coreSchema: any[];

  _services: any;

  constructor() {
    this.models = {
      core: {},
    };
    this.Schema = {};
    this.Constants = {};
    this.app = false;

    this.coreSchema = [];

    this._services = null;
  }

  async init(services) {
    Logging.logSilly('Model:init');
    this._services = services;
  }

  async clean() {
    Logging.logSilly('Model:clean');
    this.models = {
      core: {},
    };
    this.Schema = {};
    this.Constants = {};
    this.app = false;

    this.coreSchema = [];
  }

  async initCoreModels() {
    Logging.logSilly('Model:initCoreModels');

    // We don't need to dynamicly include the core models, there arn't that many
    // and they're not going to change. We'll just staticlly define them instead.
    const models = Object.keys(CoreModels);
    Logging.log(models, Logging.Constants.LogLevel.SILLY);

    for (let x = 0; x < models.length; x++) {
      await this._initCoreModel(models[x]);
    }
  }

  async initSchema(appId = null) {
    Logging.logSilly('Model:initSchema');
    const rxsApps = (await this.getCoreModel(AppSchemaModel).findAll()) as App[];

    for await (const app of rxsApps) {
      if (!app || !app.__schema) continue;
      if (appId && app.id.toString() !== appId) continue;

      Logging.logSilly(`Model:initSchema: ${app.id}`);

      // Check for connection
      let datastore: Datastore | null = null;
      if (app.datastore && app.datastore.connectionString) {
        try {
          datastore = Datastores.createInstance({ connectionString: app.datastore.connectionString });
          await datastore.connect();
        } catch (err) {
          if (err instanceof Helpers.Errors.UnsupportedDatastore) {
            Logging.logWarn(`${err} for ${app.id}`);
            return;
          }

          throw err;
        }
      } else {
        datastore = Datastores.getInstance('core');
      }

      let builtSchemas: any[];
      try {
        builtSchemas = await Helpers.Schema.buildCollections(Helpers.Schema.decode(app.__schema));
      } catch (err) {
        if (err instanceof Helpers.Errors.SchemaInvalid) continue;
        else throw err;
      }

      for await (const schema of builtSchemas) {
        await this._initSchemaModel(app, schema, datastore);
      }
    }

    Logging.logSilly('Model:initSchema:end');
  }

  getCoreModel<T extends StandardModel>(modelClass: StandardModelExtended<T>): T {
    const name = modelClass.name;

    if (!this.models.core[name]) {
      throw new Error(`Core model '${name}' has not been initialized.`);
    }

    return this.models.core[name] as unknown as T;
  }
  getCoreModelByName<T extends StandardModel>(name: string): T {
    return this.models.core[name] as unknown as T;
  }

  get CoreModels() {
    return CoreModels;
  }

  /**
   * Unlike fetching the core models, app models might not be initialized yet, so this
   * is an async function.
   */
  async getAppModel<T extends StandardModel>(appId: string, name: string): Promise<T> {
    return this.models[appId][name] as unknown as T;
  }

  /**
   * @param {string} name - demand loads the schema
   * @return {object} SchemaModel - initiated schema model built from passed schema object
   * @private
   */
  async _initCoreModel(name) {
    const CoreSchemaModel = CoreModels[name];

    this.coreSchema.push(name);

    if (!this.models.core[name]) {
      Logging.logSilly(`Creating core model: ${name}`);
      this.models.core[name] = new CoreSchemaModel(this._services);
      await this.models.core[name].initAdapter(Datastores.getInstance('core'));
    }

    return this.models.core[name];
  }

  /**
   * @param {object} app - application container
   * @param {object} schemaData - schema data object
   * @param {object} mainDatastore - datastore object to be used
   * @return {object} SchemaModel - initiated schema model built from passed schema object
   * @private
   */
  async _initSchemaModel(app: App, schemaData: Schema, mainDatastore) {
    const modelName = schemaData.name;

    // Is data sharing
    if (schemaData.remotes) {
      const remotes = Array.isArray(schemaData.remotes) ? schemaData.remotes : [schemaData.remotes];

      const datastores: any[] = [];

      for await (const remote of remotes) {
        if (!remote.name || !remote.schema) {
          Logging.logWarn(`Invalid Schema remote descriptor (${remote.name}.${remote.schema})`);
          return;
        }

        const dataSharing = await this.getCoreModel(AppDataSharingSchemaModel).findOne({
          name: remote.name,
          _appId: app.id,
        });

        if (!dataSharing) {
          Logging.logError(`Unable to find data sharing (${remote.name}.${remote.schema}) for ${app.name}`);
          return;
        }

        if (!dataSharing.active) {
          Logging.logDebug(`Data sharing not active yet, skipping (${remote.name}.${remote.schema}) for ${app.name}`);
          return;
        }

        const connectionString = Helpers.DataSharing.createDataSharingConnectionString(dataSharing.remoteApp);
        const remoteDatastore = Datastores.createInstance({ connectionString });

        // ? Datastore shouldn't really care about the data sharing ID.
        remoteDatastore.dataSharingId = dataSharing.id;

        datastores.push(remoteDatastore);
      }

      this._setModel(app.id, modelName, new RemoteCombinedModel(schemaData, app, this._services));

      try {
        await (this.models[app.id][modelName] as RemoteCombinedModel).initAdapter(mainDatastore, datastores);
      } catch (err) {
        // Skip defining this model, the error will get picked up later when route is defined ore accessed
        if (err instanceof Helpers.Errors.SchemaNotFound) return;
        else throw err;
      }

      return this.models[app.id][modelName];
    } else {
      this._setModel(app.id, modelName, new StandardModel(schemaData, app, this._services));
      await this.models[app.id][modelName].initAdapter(mainDatastore);
    }

    return this.models[app.id][modelName];
  }

  private _setModel<T extends StandardModel>(appId: string, modelName: string, modelInstance: T) {
    if (!this.models[appId]) this.models[appId] = {};
    this.models[appId][modelName] = modelInstance;
  }

  async dropAndCleanAppModels(appId: string) {
    if (!this.models[appId]) return;

    const modelNames = Object.keys(this.models[appId]);
    for await (const modelName of modelNames) {
      try {
        await this.models[appId][modelName].drop();
      } catch (err) {
        Logging.logError(`Error dropping model ${modelName} for app ${appId}: ${err}`);
      }
      delete this.models[appId][modelName];
    }

    delete this.models[appId];
  }
}

export default new ModelManager();
