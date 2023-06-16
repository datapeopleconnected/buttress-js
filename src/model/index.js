'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

const path = require('path');
const fs = require('fs');
const Sugar = require('sugar');

const Logging = require('../helpers/logging');
const Schema = require('../schema');
const shortId = require('../helpers').shortId;

const {Errors, DataSharing} = require('../helpers');

const Datastore = require('../datastore');

const StandardModel = require('./type/standard');
const RemoteModel = require('./type/remote');

/**
 * @param {string} model - name of the model to load
 * @private
 */

/**
 * @class Model
 */
class Model {
	constructor() {
		this.models = {};
		this.Schema = {};
		this.Constants = {};
		this.app = false;
		this.appMetadataChanged = false;

		this.coreSchema = [];

		this._nrp = null;
	}

	async init(nrp) {
		Logging.logSilly('Model:init');
		this._nrp = nrp;
	}

	async initCoreModels() {
		Logging.logSilly('Model:initCoreModels');
		// Core Models
		const models = this._getModels();
		Logging.log(models, Logging.Constants.LogLevel.SILLY);

		for (let x = 0; x < models.length; x++) {
			await this._initCoreModel(models[x]);
		}
	}

	// TODO: Might be wise to narrow it down to an app or schema thats changed.
	async initSchema(appId = null) {
		Logging.logSilly('Model:initSchema');
		const rxsApps = await this.models.App.findAll();

		for await (const app of rxsApps) {
			if (!app || !app.__schema) return;
			if (appId && app._id !== appId) continue;

			// Check for connection
			let datastore = null;
			if (app.datastore && app.datastore.connectionString) {
				try {
					datastore = Datastore.createInstance(app.datastore);
					await datastore.connect();
				} catch (err) {
					if (err instanceof Errors.UnsupportedDatastore) {
						Logging.logWarn(`${err} for ${app._id}`);
						return;
					}

					throw err;
				}
			} else {
				datastore = Datastore.getInstance('core');
			}

			let builtSchemas = null;
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

	initModel(modelName) {
		return this[modelName];
	}

	// TODO: We should replace this with an accessor
	__addModelGetter(name) {
		Object.defineProperty(this, name, {get: () => this.models[name], configurable: true});
	}

	/**
	 * @param {string} model - demand loads the schema
	 * @return {object} SchemaModel - initiated schema model built from passed schema object
	 * @private
	 */
	async _initCoreModel(model) {
		const name = Sugar.String.camelize(model);
		const CoreSchemaModel = require(`./core/${model.toLowerCase()}`);

		this.coreSchema.push(name);

		if (!this.models[name]) {
			Logging.logSilly(`Creating core model: ${name}`);
			this.models[name] = new CoreSchemaModel(this._nrp);
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
		let name = `${schemaData.name}`;
		const appShortId = (app) ? shortId(app._id) : null;

		name = (appShortId) ? `${appShortId}-${schemaData.name}` : name;

		if (this.models[name]) {
			this.__addModelGetter(name);
			return this.models[name];
		}

		// Is data sharing
		if (!this.models[name]) {
			if (schemaData.remotes) {
				const remotes = (Array.isArray(schemaData.remotes)) ? schemaData.remotes : [schemaData.remotes];

				const datastores = [];

				for await (const remote of remotes) {
					const [dataSharingName, collection] = remote.split('.');

					if (!dataSharingName || !collection) {
						Logging.logWarn(`Invalid Schema remote descriptor (${dataSharingName}.${collection})`);
						return;
					}

					const dataSharing = await this.AppDataSharing.findOne({
						'name': dataSharingName,
						'_appId': app._id,
					});

					if (!dataSharing) {
						Logging.logError(`Unable to find data sharing (${dataSharingName}.${collection}) for ${app.name}`);
						return;
					}

					if (!dataSharing.active) {
						Logging.logDebug(`Data sharing not active yet, skipping (${dataSharingName}.${collection}) for ${app.name}`);
						return;
					}

					const connectionString = DataSharing.createDataSharingConnectionString(dataSharing.remoteApp);
					const remoteDatastore = Datastore.createInstance({connectionString});

					datastores.push(remoteDatastore);
				}

				// mutiple remotes?
				this.models[name] = new RemoteModel(schemaData, app, this._nrp);

				try {
					await this.models[name].initAdapter(mainDatastore, datastores);
				} catch (err) {
					// Skip defining this model, the error will get picked up later when route is defined ore accessed
					if (err instanceof Errors.SchemaNotFound) return;
					else throw err;
				}

				this.__addModelGetter(name);
				return this.models[name];
			} else {
				this.models[name] = new StandardModel(schemaData, app, this._nrp);
				await this.models[name].initAdapter(mainDatastore);
			}
		}

		this.__addModelGetter(name);
		return this.models[name];
	}

	/**
 * @private
 * @return {array} - list of files containing schemas
 */
	_getModels() {
		const filenames = fs.readdirSync(`${__dirname}/core`);

		const files = [];
		for (let x = 0; x < filenames.length; x++) {
			const file = filenames[x];
			if (path.extname(file) === '.js') {
				files.push(path.basename(file, '.js'));
			}
		}
		return files;
	}
}

module.exports = new Model();
