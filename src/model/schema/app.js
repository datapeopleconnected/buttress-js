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

const fs = require('fs');
const crypto = require('crypto');
const SchemaModel = require('../schemaModel');
const ObjectId = require('mongodb').ObjectId;
const Model = require('../');
const Schema = require('../../schema');
const Logging = require('../../logging');
const Config = require('node-env-obj')('../');
const NRP = require('node-redis-pubsub');
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
				type: {
					__type: 'string',
					__default: 'server',
					__enum: type,
					__allowUpdate: true,
				},
				domain: {
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
	 * @param {String} name - name of the data folder to create
	 * @param {Boolean} isPublic - true for /public (which is available via the static middleware) otherwise /private
	 * @return {String} - UID
	 */
	mkDataDir(name, isPublic) {
		const uid = this.getPublicUID();
		const baseName = `${Config.paths.appData}/${isPublic ? 'public' : 'private'}/${uid}`;

		return new Promise((resolve, reject) => {
			fs.mkdir(baseName, (err) => {
				if (err && err.code !== 'EEXIST') {
					reject(err);
					return;
				}
				const dirName = `${baseName}/${name}`;
				fs.mkdir(dirName, (err) => {
					if (err && err.code !== 'EEXIST') {
						reject(err);
						return;
					}
					resolve();
				});
			});
		});
	}

	/**
	 * @return {String} - UID
	 */
	getPublicUID() {
		return this.genPublicUID(this.name, this._id);
	}

	/**
	 * @return {Promise} - resolves to the token
	 */
	getToken() {
		return Model.Token.findOne({_id: this._token});
	}

	/**
	 * @param {String} name - name of application
	 * @param {String} id - application id
	 * @return {String} - UID
	 */
	genPublicUID(name, id) {
		const hash = crypto.createHash('sha512');
		// Logging.log(`Create UID From: ${this.name}.${this.tokenValue}`, Logging.Constants.LogLevel.DEBUG);
		hash.update(`${name}.${id}`);
		const bytes = hash.digest();

		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const mask = 0x3d;
		let uid = '';

		for (let byte = 0; byte < 32; byte++) {
			uid += chars[bytes[byte] & mask];
		}

		// Logging.log(`Got UID: ${uid}`, Logging.Constants.LogLevel.SILLY);
		return uid;
	}
}
/**
 * Schema Virtual Methods
 */
// schema.virtual('details').get(function() {
//   return {
//     id: this._id,
//     name: this.name,
//     type: this.type,
//     token: this.tokenValue,
//     owner: this.ownerDetails,
//     publicUid: this.getPublicUID(),
//     metadata: this.metadata.map(m => ({key: m.key, value: JSON.parse(m.value)}))
//   };
// });

/**
 * Exports
 */
module.exports = AppSchemaModel;
