'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

import Schema from '../schema';
import Logging from '../helpers/logging';
import {shortId, Errors, DataSharing} from '../helpers';

import Datastore from '../datastore';

import StandardModel from './type/standard';
import RemoteCombinedModel from './type/remote-combined';

import Activity from './core/activity';
import App from './core/app';
import AppDataSharing from './core/app-data-sharing';
import Deployment from './core/deployment';
import Lambda from './core/lambda';
import LambdaExecution from './core/lambda-execution';
import Policy from './core/policy';
import SecureStore from './core/secure-store';
import Token from './core/token';
import Tracking from './core/tracking';
import User from './core/user';

const CoreModels = {
  Activity,
  App,
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
 * @class Model
 */
class Model {
	models: {[key: string]: any};
	Schema: {[key: string]: any};

	Constants: {[key: string]: any};

	app: any;
	appMetadataChanged: boolean;

	coreSchema: any[];

	_services: any;

	constructor() {
		this.models = {};
		this.Schema = {};
		this.Constants = {};
		this.app = false;
		this.appMetadataChanged = false;

		this.coreSchema = [];

		this._services = null;
	}

	async init(services) {
		Logging.logSilly('Model:init');
		this._services = services;
	}

	async clean() {
		Logging.logSilly('Model:clean');
		this.models = {};
		this.Schema = {};
		this.Constants = {};
		this.app = false;
		this.appMetadataChanged = false;

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
		const rxsApps = await this.models.App.findAll();

		for await (const app of rxsApps) {
			if (!app || !app.__schema) continue;
			if (appId && app.id.toString() !== appId) continue;

			Logging.logSilly(`Model:initSchema: ${app.id}`);

			// Check for connection
			let datastore: any = null;
			if (app.datastore && app.datastore.connectionString) {
				try {
					datastore = Datastore.createInstance(app.datastore);
					await datastore.connect();
				} catch (err) {
					if (err instanceof Errors.UnsupportedDatastore) {
						Logging.logWarn(`${err} for ${app.id}`);
						return;
					}

					throw err;
				}
			} else {
				datastore = Datastore.getInstance('core');
			}

			let builtSchemas: any[];
			try {
				builtSchemas = await Schema.buildCollections(Schema.decode(app.__schema));
			} catch (err) {
				if (err instanceof Errors.SchemaInvalid) continue;
				else throw err;
			}

			for await (const schema of builtSchemas) {
				await this._initSchemaModel(app, schema, datastore);
			}
		}

		Logging.logSilly('Model:initSchema:end');
	}

	/**
	 * Use to access a defined model, should be used in place of the
	 * object property accessor.
	 * @param {string} name
	 * @return {Standard}
	 */
	getModel(name: string) {
		return this.models[name];
	}

	get CoreModels() {
		return CoreModels;
	}

	/**
	 * Used to define a object property accessor for a defined model.
	 * @param {string} name
	 * @deprecated
	 */
	__addModelGetter(name) {
		Object.defineProperty(this, name, {get: () => this.models[name], configurable: true});
	}

	/**
	 * @param {string} name - demand loads the schema
	 * @return {object} SchemaModel - initiated schema model built from passed schema object
	 * @private
	 */
	async _initCoreModel(name) {
		const CoreSchemaModel = CoreModels[name];

		this.coreSchema.push(name);

		if (!this.models[name]) {
			Logging.logSilly(`Creating core model: ${name}`);
			this.models[name] = new CoreSchemaModel(this._services);
			await this.models[name].initAdapter(Datastore.getInstance('core'));

			this.__addModelGetter(name);
		}

		return this.models[name];
	}

	/**
	 * @param {object} app - application container
	 * @param {object} schemaData - schema data object
	 * @param {object} mainDatastore - datastore object to be used
	 * @return {object} SchemaModel - initiated schema model built from passed schema object
	 * @private
	 */
	async _initSchemaModel(app, schemaData, mainDatastore) {
		let modelName = `${schemaData.name}`;
		const appShortId = (app) ? shortId(app.id) : null;

		modelName = (appShortId) ? `${appShortId}-${schemaData.name}` : modelName;

		// if (this.models[modelName]) {
		// 	this.__addModelGetter(modelName);
		// 	return this.models[modelName];
		// }

		// Is data sharing
		if (schemaData.remotes) {
			const remotes = (Array.isArray(schemaData.remotes)) ? schemaData.remotes : [schemaData.remotes];

			const datastores: any[] = [];

			for await (const remote of remotes) {
				if (!remote.name || !remote.schema) {
					Logging.logWarn(`Invalid Schema remote descriptor (${remote.name}.${remote.schema})`);
					return;
				}

				const dataSharing = await this.getModel('AppDataSharing').findOne({
					'name': remote.name,
					'_appId': app.id,
				});

				if (!dataSharing) {
					Logging.logError(`Unable to find data sharing (${remote.name}.${remote.schema}) for ${app.name}`);
					return;
				}

				if (!dataSharing.active) {
					Logging.logDebug(`Data sharing not active yet, skipping (${remote.name}.${remote.schema}) for ${app.name}`);
					return;
				}

				const connectionString = DataSharing.createDataSharingConnectionString(dataSharing.remoteApp);
				const remoteDatastore = Datastore.createInstance({connectionString});

				// ? Datastore shouldn't really care about the data sharing ID.
				remoteDatastore.dataSharingId = dataSharing.id;

				datastores.push(remoteDatastore);
			}

			this.models[modelName] = new RemoteCombinedModel(schemaData, app, this._services);

			try {
				await this.models[modelName].initAdapter(mainDatastore, datastores);
			} catch (err) {
				// Skip defining this model, the error will get picked up later when route is defined ore accessed
				if (err instanceof Errors.SchemaNotFound) return;
				else throw err;
			}

			this.__addModelGetter(modelName);
			return this.models[modelName];
		} else {
			this.models[modelName] = new StandardModel(schemaData, app, this._services);
			await this.models[modelName].initAdapter(mainDatastore);
		}

		this.__addModelGetter(modelName);
		return this.models[modelName];
	}
}

export default new Model();
