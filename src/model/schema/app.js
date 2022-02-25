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

const ObjectId = require('mongodb').ObjectId;
const Config = require('node-env-obj')();

const NRP = require('node-redis-pubsub');

const Model = require('../');
const Schema = require('../../schema');
const Logging = require('../../logging');
const SchemaModelMongoDB = require('../type/mongoDB');
const shortId = require('../../helpers').shortId;

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

class AppSchemaModel extends SchemaModelMongoDB {
	constructor(MongoDb) {
		const schema = AppSchemaModel.Schema;
		super(MongoDb, schema);

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
					__type: 'string',
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
	add(body) {
		const app = {
			id: new ObjectId(),
			name: body.name,
			type: body.type,
			authLevel: body.authLevel,
			permissions: body.permissions,
			domain: body.domain,
			apiPath: body.apiPath,
		};
		let _token = null;

		return Model.Token.add({
			type: Model.Token.Constants.Type.APP,
			authLevel: body.authLevel,
			permissions: body.permissions,
		}, {
			_app: new ObjectId(app.id),
		})
			.then((tokenCursor) => tokenCursor.next())
			.then((token) => {
				_token = token;

				nrp.emit('app-routes:bust-cache', {});
				nrp.emit('app-schema:updated', {appId: app.id});

				return super.add(app, {_token: token._id});
			})
			.then((appCursor) => appCursor.next())
			.then((app) => {
				return Promise.resolve({app: app, token: _token});
			});
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

		return new Promise((resolve, reject) => {
			this.collection.updateOne({_id: appId}, {$set: {__schema: appSchema}}, {}, (err, object) => {
				if (err) throw new Error(err);

				nrp.emit('app-schema:updated', {appId: appId});

				resolve(object);
			});
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

		return new Promise((resolve, reject) => {
			this.collection.updateOne({_id: appId}, {$set: {__roles: roles}}, {}, (err, object) => {
				if (err) throw new Error(err);

				resolve(object);
			});
		});
	}

	/**
	 * @param {string} route - route for the permission
	 * @param {*} permission - permission to apply to the route
	 * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
	 */
	addOrUpdatePermission(route, permission) {
		Logging.log(route, Logging.Constants.LogLevel.DEBUG);
		Logging.log(permission, Logging.Constants.LogLevel.DEBUG);

		return new Promise((resolve, reject) => {
			this.getToken()
				.then((token) => {
					if (!token) {
						return reject(new Error('No valid authentication token.'));
					}
					token.addOrUpdatePermission().then(resolve, reject);
				});
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

		const appShortId = (entity) ? shortId(entity._id) : null;

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
