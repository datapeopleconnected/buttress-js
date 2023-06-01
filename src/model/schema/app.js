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

const Buttress = require('@buttress/api');

const Model = require('../');
const Schema = require('../../schema');
const Logging = require('../../logging');
const Helpers = require('../../helpers');

const SchemaModel = require('../schemaModel');


class AppSchemaModel extends SchemaModel {
	constructor(nrp) {
		const schema = AppSchemaModel.Schema;
		super(schema, null, nrp);

		this._localSchema = null;

		this._nrp = nrp;
	}

	static get Constants() {
		return {
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
					__enum: [
						'GOOGLE',
						'MICROSOFT',
						'LOCAL_STRATEGY',
					],
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
					__type: 'text',
					__required: false,
					__default: '[]',
					__allowUpdate: true,
				},
				__rawSchema: {
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

		if (body.type === Model.Token.Constants.Type.SYSTEM) {
			const adminToken = await Model.Token.findOne({
				type: {
					$eq: Model.Token.Constants.Type.SYSTEM,
				},
			});

			if (adminToken) {
				return Promise.reject(new Helpers.Errors.RequestError(400, `This Buttress instance already have a system app`));
			}
		}

		const rxsToken = await Model.Token.add({
			type: (body.type) ? body.type : Model.Token.Constants.Type.APP,
			permissions: body.permissions,
		}, {
			_appId: body.id,
		});

		const token = await Helpers.streamFirst(rxsToken);

		const rxsApp = await super.add(body, {_tokenId: token._id});
		const app = await Helpers.streamFirst(rxsApp);

		await this.__handleAddingNonSystemApp(body, token);

		Logging.logSilly(`Emitting app-routes:bust-cache`);
		this._nrp.emit('app-routes:bust-cache', {});
		Logging.logSilly(`Emitting app-schema:updated ${app._id}`);
		this._nrp.emit('app-schema:updated', {appId: app._id});

		Logging.logSilly(`Emitting app-policy:bust-cache ${app._id}`);
		this._nrp.emit('app-policy:bust-cache', {
			appId: app._id,
		});

		return Promise.resolve({app: app, token: token});
	}

	async __handleAddingNonSystemApp(body, token) {
		if (body.type === Model.Token.Constants.Type.SYSTEM) return;

		let appPolicyPropertiesList = body.policyPropertiesList;
		const list = {
			role: ['APP'],
		};
		const currentAppListKeys = Object.keys(appPolicyPropertiesList);
		Object.keys(list).forEach((key) => {
			if (currentAppListKeys.includes(key)) {
				list[key] = list[key].concat(appPolicyPropertiesList[key]).filter((v, idx, arr) => arr.indexOf(v) === idx);
			}
		});
		appPolicyPropertiesList = {...appPolicyPropertiesList, ...list};

		await Model.Policy.add({
			name: `${body.name} policy`,
			selection: {
				role: {
					'@eq': 'APP',
				},
			},
			config: [{
				endpoints: ['%ALL%'],
				query: [{
					schema: ['%APP_SCHEMA%'],
					access: '%FULL_ACCESS%',
				}, {
					schema: ['policy', 'user', 'lambda', 'appDataSharing', 'secureStore'],
					query: {
						_appId: {
							'@eq': body.id,
						},
					},
				}],
			}, {
				endpoints: ['GET', 'PUT'],
				query: [{
					schema: ['app'],
					query: {
						_id: {
							'@eq': body.id,
						},
					},
				}],
			}],
		}, body.id);

		await Model.Token.setPolicyPropertiesById(token._id, {
			role: 'APP',
		});

		await Model.App.setPolicyPropertiesList(body.id, appPolicyPropertiesList);
	}

	/**
	 * @param {ObjectId} appId - app id which needs to be updated
	 * @param {object} appSchema - schema object for the app
	 * @param {object} rawSchema - encoded raw app schema
	 * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
	 */
	async updateSchema(appId, appSchema, rawSchema) {
		Logging.logSilly(`Update Schema ${appId}`);

		appSchema = Schema.encode(appSchema);
		await super.updateById(appId, {$set: {__schema: appSchema}});

		if (rawSchema) {
			await super.updateById(appId, {$set: {__rawSchema: rawSchema}});
		}

		Logging.logSilly(`Emitting app-schema:updated ${appId}`);
		this._nrp.emit('app-schema:updated', {appId: appId});
		this._nrp.emit('app:update-schema', {
			appId: appId,
			schemas: Schema.decode(appSchema),
		});
		const updatedSchema = (await super.findById(appId))?.__rawSchema;
		return updatedSchema;
	}

	async mergeRemoteSchema(req, collections) {
		const schemaWithRemoteRef = collections.filter((s) => s.remote);

		// TODO: Check params for any core scheam thats been requested.
		const dataSharingSchema = schemaWithRemoteRef.reduce((map, collection) => {
			const [DSA, ...schema] = collection.remote.split('.');
			if (!map[DSA]) map[DSA] = [];
			map[DSA].push(schema);
			return map;
		}, {});

		// TODO: fetch app models & use schema data instead of doing the work here

		// Load DSA for curent app
		const requiredDSAs = Object.keys(dataSharingSchema);
		if (requiredDSAs.length > 0) {
			const appDSAs = await Helpers.streamAll(await Model.AppDataSharing.find({
				'_appId': req.authApp._id,
				'name': {
					$in: requiredDSAs,
				},
				'active': true,
			}));

			for await (const DSAName of Object.keys(dataSharingSchema)) {
				const DSA = appDSAs.find((dsa) => dsa.name === DSAName);
				if (!DSA) continue;
				// Load DSA

				const api = Buttress.new();
				await api.init({
					buttressUrl: DSA.remoteApp.endpoint,
					apiPath: DSA.remoteApp.apiPath,
					appToken: DSA.remoteApp.token,
					allowUnauthorized: true, // Move along, nothing to see here...
				});

				const remoteSchema = await api.App.getSchema({
					params: {
						only: dataSharingSchema[DSAName].join(','),
					},
				});

				remoteSchema.forEach((rs) => {
					schemaWithRemoteRef
						.filter((s) => s.remote === `${DSAName}.${rs.name}`)
						.forEach((s) => {
							// Merge RS into schema
							delete s.remote;
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
	 * @param {ObjectId} appId - app id which needs to be updated
	 * @param {Object} appPolicyPropertiesList - App policy property list
	 * @return {Promise} - resolves when save operation is completed
	 */
	async setPolicyPropertiesList(appId, appPolicyPropertiesList) {
		Logging.logSilly(`Add App Policy Property List ${appId}`);
		return super.updateById(appId, {$set: {policyPropertiesList: appPolicyPropertiesList}});
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
		return Model.Token.findOne({_id: this._tokenId});
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

	/**
	 * @param {string} appId - app entity object to be updated
	 * @param {array} oAuth - oAuth options for the app
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async updateOAuth(appId, oAuth) {
		return super.update({
			'_id': this.createId(appId),
		}, {$set: {'oAuth': oAuth}});
	}
}

/**
 * Exports
 */
module.exports = AppSchemaModel;
