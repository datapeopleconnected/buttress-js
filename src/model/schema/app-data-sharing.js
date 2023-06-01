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
const Helpers = require('../../helpers');
const Schema = require('../../schema');
const Model = require('..');

const SchemaModel = require('../schemaModel');

/**
 * @class AppDataSharingSchemaModel
 */
class AppDataSharingSchemaModel extends SchemaModel {
	constructor(nrp) {
		const schema = AppDataSharingSchemaModel.Schema;
		super(schema, null, nrp);

		this._localSchema = null;

		this._nrp = nrp;
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
			extends: [],
			core: true,
			properties: {
				name: {
					__type: 'string',
					__required: true,
					__allowUpdate: true,
				},
				active: {
					__type: 'boolean',
					__default: false,
					__required: false,
					__allowUpdate: true,
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
			id: (body.id) ? body.id : this.createId(),
			name: body.name,

			active: false,

			remoteApp: {
				endpoint: Helpers.trimSlashes(body.remoteApp.endpoint),
				apiPath: Helpers.trimSlashes(body.remoteApp.apiPath),
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
			policyProperties: body.auth.policyProperties,
			type: Model.Token.Constants.Type.DATA_SHARING,
			permissions: [{route: '*', permission: '*'}],
		}, {
			_appId: this.createId(body._appId),
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

		return this.updateById(this.createId(appDataSharingId), update);
	}

	/**
	 * @param {ObjectId} appDataSharingId - Data Sharing Id id which needs to be updated
	 * @param {String} token - activation token for remote app
	 * @return {Promise} - resolves when save operation is completed
	 */
	updateActivationToken(appDataSharingId, token) {
		const update = {$set: {}};

		update.$set['remoteApp.token'] = token;
		update.$set['remoteApp.active'] = false;

		return this.updateById(this.createId(appDataSharingId), update);
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

		this._nrp.emit('dataShare:activated', {appDataSharingId: appDataSharingId});

		return this.updateById(this.createId(appDataSharingId), update);
	}

	/**
	 * @param {ObjectId} appDataSharingId - Data Sharing Id id which needs to be updated
	 * @return {Promise} - resolves when save operation is completed
	 */
	deactivate(appDataSharingId) {
		const update = {
			$set: {
				active: false,
			},
		};

		// TODO implement socket deactivation
		this._nrp.emit('dataShare:deactivated', {appDataSharingId: appDataSharingId});

		return this.updateById(this.createId(appDataSharingId), update);
	}
}

/**
 * Exports
 */
module.exports = AppDataSharingSchemaModel;
