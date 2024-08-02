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

const Buttress = require('@buttress/api');

import Schema from '../../schema';
import Logging from '../../helpers/logging';
import * as Helpers from '../../helpers';

import StandardModel from '../type/standard';

export default class AppSchemaModel extends StandardModel {

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

		if (body.type === this.__modelManager.Token.Constants.Type.SYSTEM) {
			const adminToken = await this.__modelManager.Token.findOne({
				type: {
					$eq: this.__modelManager.Token.Constants.Type.SYSTEM,
				},
			});

			if (adminToken) {
				return Promise.reject(new Helpers.Errors.RequestError(400, `This Buttress instance already have a system app`));
			}
		}

		const rxsToken = await this.__modelManager.Token.add({
			type: (body.type) ? body.type : this.__modelManager.Token.Constants.Type.APP,
			permissions: body.permissions,
		}, {
			_appId: body.id,
		});

		const token: any = await Helpers.streamFirst(rxsToken);

		const rxsApp = await super.add(body, {_tokenId: token.id});
		const app: any = await Helpers.streamFirst(rxsApp);

		await this.__handleAddingNonSystemApp(body, token);

		Logging.logSilly(`Emitting app-routes:bust-cache`);
		this.__nrp.emit('app-routes:bust-cache', {});
		Logging.logSilly(`Emitting app:created ${app.id}`);
		this.__nrp.emit('app:created', {appId: app.id});
		Logging.logSilly(`Emitting app-schema:updated ${app.id}`);
		this.__nrp.emit('app-schema:updated', {appId: app.id});

		Logging.logSilly(`Emitting app-policy:bust-cache ${app.id}`);
		this.__nrp.emit('app-policy:bust-cache', {
			appId: app.id,
		});

		return Promise.resolve({app: app, token: token});
	}

	async __handleAddingNonSystemApp(body, token) {
		if (body.type === this.__modelManager.Token.Constants.Type.SYSTEM) return;

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

		await this.__modelManager.Policy.add({
			name: `App Policy - ${body.name}`,
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
					schema: ['policy', 'user', 'lambda', 'lambdaExecution', 'deployment', 'appDataSharing', 'secureStore'],
					_appId: {
						'@eq': body.id,
					},
				}],
			}, {
				endpoints: ['GET', 'PUT'],
				query: [{
					schema: ['app'],
					_id: {
						'@eq': body.id,
					},
				}],
			}],
		}, body.id);

		await this.__modelManager.Token.setPolicyPropertiesById(token.id, {
			role: 'APP',
		});

		await this.__modelManager.App.setPolicyPropertiesList({
			id: {
				$eq: body.id,
			},
		}, appPolicyPropertiesList);
	}

	/**
	 * @param {ObjectId} appId - app id which needs to be updated
	 * @param {object} compiledSchema - schema object for the app
	 * @param {object} rawSchema - encoded raw app schema
	 * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
	 */
	async updateSchema(appId, compiledSchema, rawSchema) {
		Logging.logSilly(`Update Schema ${appId}`);

		await super.updateById(appId, {$set: {__schema: Schema.encode(compiledSchema)}});

		if (rawSchema) {
			await super.updateById(appId, {$set: {__rawSchema: rawSchema}});
		}

		Logging.logSilly(`Emitting app-schema:updated ${appId}`);
		this.__nrp.emit('app-schema:updated', {appId: appId});
		this.__nrp.emit('app:update-schema', {
			appId: appId,
			schemas: compiledSchema,
		});
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

		// Load DSA for curent app
		const requiredDSAs = Object.keys(dataSharingSchema);
		if (requiredDSAs.length > 0) {
			const appDSAs = await Helpers.streamAll(await this.__modelManager.AppDataSharing.find({
				'_appId': req.authApp.id,
				'name': {
					$in: requiredDSAs,
				},
				'active': true,
			}));

			for await (const DSAName of Object.keys(dataSharingSchema)) {
				const DSA = appDSAs.find((dsa) => dsa.name === DSAName);
				if (!DSA) continue;
				// Load DSA

				// TODO: Should being using an adapter via the datastore.
				const api = Buttress.new();
				await api.init({
					buttressUrl: DSA.remoteApp.endpoint,
					apiPath: DSA.remoteApp.apiPath,
					appToken: DSA.remoteApp.token,
					allowUnauthorized: true, // Move along, nothing to see here...
				});

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
	 * @param {Object} query - query of which decides the app to be updated
	 * @param {Object} appPolicyPropertiesList - App policy property list
	 * @return {Promise} - resolves when save operation is completed
	 */
	async setPolicyPropertiesList(query, appPolicyPropertiesList) {
		return super.updateOne(query, {$set: {policyPropertiesList: appPolicyPropertiesList}});
	}

	/**
	 * @return {Promise} - resolves to the token
	 */
	getToken(app) {
		return this.__modelManager.Token.findOne({id: app._tokenId});
	}

	/**
	 * @param {App} entity - entity object to be deleted
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async rm(entity) {
		await this.__modelManager.AppDataSharing.rmAll({_appId: entity.id});
		const appShortId = (entity) ? Helpers.shortId(entity.id) : null;

		// Delete Schema collections
		if (appShortId) {
			const appSchemaModels = Object.keys(this.__modelManager.models).filter((k) => k.indexOf(appShortId) !== -1);
			for (let i = 0; i < appSchemaModels.length; i++) {
				if (this.__modelManager[appSchemaModels[i]] && this.__modelManager[appSchemaModels[i]].drop) {
					await this.__modelManager[appSchemaModels[i]].drop();
					delete this.__modelManager[appSchemaModels[i]];
				}
			}
		}

		return super.rm(entity.id);
	}

	/**
	 * @param {string} appId - app entity object to be updated
	 * @param {array} oAuth - oAuth options for the app
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async updateOAuth(appId, oAuth) {
		return super.update({
			'id': this.createId(appId),
		}, {$set: {'oAuth': oAuth}});
	}
}
