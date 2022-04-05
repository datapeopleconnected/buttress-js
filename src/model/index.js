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
const Logging = require('../logging');
const Sugar = require('sugar');
const Schema = require('../schema');
const SchemaModel = require('./schemaModel');
const shortId = require('../helpers').shortId;

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
		this.mongoDb = null;
		this.app = false;
		this.appMetadataChanged = false;
	}

	init(db) {
		this.mongoDb = db;

		// Core Models
		return this.initCoreModels()
			.then(() => this.initSchema());
	}

	initCoreModels(db) {
		return new Promise((resolve) => {
			if (db) this.mongoDb = db;
			// Core Models
			const models = _getModels();
			Logging.log(models, Logging.Constants.LogLevel.SILLY);
			for (let x = 0; x < models.length; x++) {
				this._initModel(models[x]);
			}
			resolve();
		});
	}

	initSchema(db) {
		if (db) this.mongoDb = db;

		return this.models.App.findAll().toArray()
			.then((apps) => {
				apps.forEach((app) => {
					if (app.__schema) {
						Schema.buildCollections(Schema.decode(app.__schema)).forEach((schemaData) => {
							this._initSchemaModel(app, schemaData);
						});
					}
				});
			});
	}

	initModel(modelName) {
		return this[modelName];
	}

	/**
	 * @param {string} model - demand loads the schema
	 * @return {object} SchemaModel - initiated schema model built from passed schema object
	 * @private
	 */
	_initModel(model) {
		const CoreSchemaModel = require(`./schema/${model.toLowerCase()}`);

		if (!this.models[model]) {
			this.models[model] = new CoreSchemaModel(this.mongoDb);
		}

		this.__defineGetter__(model, () => this.models[model]);
		return this.models[model];
	}

	/**
	 * @param {object} app - application container
	 * @param {object} schemaData - schema data object
	 * @return {object} SchemaModel - initiated schema model built from passed schema object
	 * @private
	 */
	_initSchemaModel(app, schemaData) {
		let name = `${schemaData.collection}`;
		const appShortId = (app) ? shortId(app._id) : null;

		if (appShortId) {
			name = `${appShortId}-${schemaData.collection}`;
		}

		if (!this.models[name]) {
			this.models[name] = new SchemaModel(this.mongoDb, schemaData, app);
		}

		this.__defineGetter__(name, () => this.models[name]);
		return this.models[name];
	}
}

/**
 * @private
 * @return {array} - list of files containing schemas
 */
function _getModels() {
	const filenames = fs.readdirSync(`${__dirname}/schema`);

	const files = [];
	for (let x = 0; x < filenames.length; x++) {
		const file = filenames[x];
		if (path.extname(file) === '.js') {
			files.push(Sugar.String.capitalize(path.basename(file, '.js')));
		}
	}
	return files;
}

module.exports = new Model();
