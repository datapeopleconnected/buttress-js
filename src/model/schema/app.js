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

const Config = require('node-env-obj')();

const NRP = require('node-redis-pubsub');

const Model = require('../');
const Schema = require('../../schema');
const Logging = require('../../logging');
const Helpers = require('../../helpers');

const SchemaModel = require('../schemaModel');

const nrp = new NRP(Config.redis);

/**
 * Constants
*/
const type = ['server', 'ios', 'android', 'browser'];
const Type = {
	SERVER: type[0],
	IOS: type[1],
	ANDROID: type[2],
	BROWSER: type[3],
};

class AppSchemaModel extends SchemaModel {
	constructor(datastore) {
		const schema = AppSchemaModel.Schema;
		super(schema, null, datastore);

		this._localSchema = null;
	}

	static get Constants() {
		return {
			Type: Type,
			PUBLIC_DIR: true,
		};
	}
	get Constants() {
		return AppSchemaModel.Constants;
	}

	static get Schema() {
		return {
			name: 'apps',
			type: 'collection',
			collection: 'apps',
			extends: [],
			properties: {
				name: {
					__type: 'string',
					__default: null,
					__allowUpdate: true,
				},
				apiPath: {
					__type: 'string',
					__default: null,
					__allowUpdate: true,
				},
				_token: {
					__type: 'id',
					__required: false,
					__allowUpdate: false,
				},
				__schema: {
					__type: 'text',
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
	async add(body) {
		body.id = this.createId();

		const rxsToken = await Model.Token.add({
			type: Model.Token.Constants.Type.APP,
			authLevel: body.authLevel,
			permissions: body.permissions,
		}, {
			_app: body.id,
		});

		const token = await Helpers.streamFirst(rxsToken);

		const rxsApp = await super.add(body, {_token: token._id});
		const app = await Helpers.streamFirst(rxsApp);

		Logging.logSilly(`Emitting app-routes:bust-cache`);
		nrp.emit('app-routes:bust-cache', {});
		Logging.logSilly(`Emitting app-schema:updated ${app._id}`);
		nrp.emit('app-schema:updated', {appId: app._id});

		return Promise.resolve({app: app, token: token});
	}

	/**
	 * @param {ObjectId} appId - app id which needs to be updated
	 * @param {object} appSchema - schema object for the app
	 * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
	 */
	updateSchema(appId, appSchema) {
		Logging.logSilly(`Update Schema ${appId}`);

		appSchema = Schema.encode(appSchema);

		return super.updateById(appId, {$set: {__schema: appSchema}})
			.then((res) => {
				Logging.logSilly(`Emitting app-schema:updated ${appId}`);
				nrp.emit('app-schema:updated', {appId: appId});
				return res;
			});
	}

	setLocalSchema(schema) {
		this._localSchema = schema;
	}

	get localSchema() {
		return this._localSchema;
	}

	/**
	 * @param {string} route - route for the permission
	 * @param {*} permission - permission to apply to the route
	 * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
	 */
	addOrUpdatePermission(route, permission) {
		Logging.log(route, Logging.Constants.LogLevel.DEBUG);
		Logging.log(permission, Logging.Constants.LogLevel.DEBUG);

		return this.getToken()
			.then((token) => {
				if (!token) {
					throw new Error('No valid authentication token.');
				}

				return token.addOrUpdatePermission();
			});
	}

	/**
	 * @return {Promise} - resolves to the token
	 */
	getToken() {
		return Model.Token.findOne({_id: this._token});
	}

	/**
	 * @param {App} entity - entity object to be deleted
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async rm(entity) {
		await Model.AppDataSharing.rmAll({_appId: entity._id});
		const appShortId = (entity) ? Helpers.shortId(entity._id) : null;

		// Delete Schema collections
		if (appShortId) {
			const appSchemaModels = Object.keys(Model.models).filter((k) => k.indexOf(appShortId) !== -1);
			for (let i = 0; i < appSchemaModels.length; i++) {
				if (Model[appSchemaModels[i]] && Model[appSchemaModels[i]].drop) {
					await Model[appSchemaModels[i]].drop();
					delete Model[appSchemaModels[i]];
				}
			}
		}

		return super.rm(entity);
	}
}

/**
 * Exports
 */
module.exports = AppSchemaModel;
