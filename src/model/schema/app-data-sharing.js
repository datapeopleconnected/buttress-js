'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file app-data-sharing.js
 * @description App Data Sharing model definition.
 * @module Model
 * @exports AppDataSharingSchemaModel
 * @author Tom Cahill
 */

const Config = require('node-env-obj')();

const NRP = require('node-redis-pubsub');

const Helpers = require('../../helpers');
const Schema = require('../../schema');
const Model = require('..');

const SchemaModel = require('../schemaModel');

const nrp = new NRP(Config.redis);

/**
 * @class AppDataSharingSchemaModel
 */
class AppDataSharingSchemaModel extends SchemaModel {
	constructor(datastore) {
		const schema = AppDataSharingSchemaModel.Schema;
		super(schema, null, datastore);

		this._localSchema = null;
	}

	static get Constants() {
		return {};
	}
	get Constants() {
		return AppDataSharingSchemaModel.Constants;
	}

	static get Schema() {
		return {
			name: 'appDataSharing',
			type: 'collection',
			collection: 'appDataSharing',
			extends: [],
			properties: {
				name: {
					__type: 'string',
					__required: true,
					__allowUpdate: false,
				},
				active: {
					__type: 'boolean',
					__default: false,
					__required: false,
					__allowUpdate: false,
				},
				remoteApp: {
					endpoint: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					apiPath: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					token: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
				},
				dataSharing: {
					localApp: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					remoteApp: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
				},
				_appId: {
					__type: 'id',
					__required: false,
					__allowUpdate: false,
				},
				_tokenId: {
					__type: 'id',
					__required: false,
					__allowUpdate: false,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with App Object when the database request is completed
	 */
	async add(body) {
		const appDataSharingBody = {
			id: this.createId(),
			name: body.name,

			active: false,

			remoteApp: {
				endpoint: body.remoteApp.endpoint,
				apiPath: body.remoteApp.apiPath,
				token: body.remoteApp.token,
			},

			dataSharing: {
				localApp: null,
				remoteApp: null,
			},

			_appId: null,
			_tokenId: null,
		};

		const rxsToken = await Model.Token.add({
			type: Model.Token.Constants.Type.DATA_SHARING,
			authLevel: Model.Token.Constants.AuthLevel.USER,
			permissions: [{route: '*', permission: '*'}],
		}, {
			_app: this.createId(body._appId),
			_appDataSharingId: this.createId(appDataSharingBody.id),
		});
		const token = await Helpers.streamFirst(rxsToken);

		const rxsDataShare = await super.add(appDataSharingBody, {
			_appId: this.createId(body._appId),
			_tokenId: token._id,
		});
		const dataSharing = await Helpers.streamFirst(rxsDataShare);

		return {dataSharing: dataSharing, token: token};
	}

	/**
	 * @param {ObjectId} appId - app id which needs to be updated
	 * @param {ObjectId} appDataSharingId - Data Sharing Id id which needs to be updated
	 * @param {String} type - data sharing type
	 * @param {Object} policy - policy object for the app
	 * @return {Promise} - resolves when save operation is completed
	 */
	updatePolicy(appId, appDataSharingId, type, policy) {
		policy = Schema.encode(policy);

		const update = {$set: {}};

		if (type === 'remote') {
			update.$set['dataSharing.remoteApp'] = policy;
		} else {
			update.$set['dataSharing.localApp'] = policy;
		}

		return this.update({
			'_id': this.createId(appDataSharingId),
			'_appId': this.createId(appId),
		}, update);
	}

	/**
	 * @param {ObjectId} appDataSharingId - Data Sharing Id id which needs to be updated
	 * @param {String} remoteAppToken - token for remote app
	 * @return {Promise} - resolves when save operation is completed
	 */
	activate(appDataSharingId, remoteAppToken = null) {
		const update = {
			$set: {
				active: true,
			},
		};

		if (remoteAppToken) {
			update.$set['remoteApp.token'] = remoteAppToken;
		}

		nrp.emit('dataShare:activated', {appDataSharingId: appDataSharingId});

		return this.update({
			'_id': this.createId(appDataSharingId),
		}, update);
	}
}

/**
 * Exports
 */
module.exports = AppDataSharingSchemaModel;
