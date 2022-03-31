'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file app.js
 * @description App model definition.
 * @module Model
 * @exports model, schema, constants
 * @author Chris Bates-Keegan
 *
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
					__default: '',
					__allowUpdate: true,
				},
				apiPath: {
					__type: 'string',
					__default: '',
					__allowUpdate: true,
				},
				_token: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				__schema: {
					__type: 'text',
					__required: true,
					__default: '[]',
					__allowUpdate: true,
				},
				__roles: {
					__type: 'array',
					__required: true,
					__allowUpdate: true,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with App Object when the database request is completed
	 */
	async add(body) {
		const appBody = {
			id: this.createId(),
			name: body.name,
			type: body.type,
			authLevel: body.authLevel,
			permissions: body.permissions,
			domain: body.domain,
			apiPath: body.apiPath,
		};

		const rxsToken = await Model.Token.add({
			type: Model.Token.Constants.Type.APP,
			authLevel: body.authLevel,
			permissions: body.permissions,
		}, {
			_app: this.createId(appBody.id),
		});

		const token = await Helpers.streamFirst(rxsToken);

		const rxsApp = await super.add(appBody, {_token: token._id});
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
		this._localSchema.forEach((cS) => {
			const appSchemaIdx = appSchema.findIndex((s) => s.name === cS.name);
			const schema = appSchema[appSchemaIdx];
			if (!schema) {
				return appSchema.push(cS);
			}
			schema.properties = Object.assign(schema.properties, cS.properties);
			appSchema[appSchemaIdx] = schema;
		});

		// Merge in local schema
		appSchema = Schema.encode(appSchema);
		// this.__schema = appSchema;

		return super.update({_id: appId}, {$set: {__schema: appSchema}})
			.then((res) => {
				Logging.logSilly(`Emitting app-schema:updated ${appId}`);
				nrp.emit('app-schema:updated', {appId: appId});
				return res;
			});
	}

	setLocalSchema(schema) {
		this._localSchema = schema;
	}

	/**
	 * @param {ObjectId} appId - app id which needs to be updated
	 * @param {object} roles - roles object
	 * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
	 */
	updateRoles(appId, roles) {
		// nrp.emit('app-metadata:changed', {appId: appId});

		return super.update({_id: appId}, {$set: {__roles: roles}});
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
