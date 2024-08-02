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

const Helpers = require('../../helpers');
const Schema = require('../../schema');
const Logging = require('../../helpers/logging');

const StandardModel = require('../type/standard');

/**
 * @class AppDataSharingSchemaModel
 */
class AppDataSharingSchemaModel extends StandardModel {
	constructor(services) {
		const schema = AppDataSharingSchemaModel.Schema;
		super(schema, null, services);

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
			id: (body.id) ? this.createId(body.id) : this.createId(),
			name: body.name,

			active: false,

			remoteApp: {
				endpoint: Helpers.trimSlashes(body.remoteApp.endpoint),
				apiPath: Helpers.trimSlashes(body.remoteApp.apiPath),
				token: body.remoteApp.token,
			},

			policy: (body.policy) ? body.policy : [],

			_appId: this.createId(body._appId),
			_tokenId: null,
		};

		const rxsToken = await this.__modelManager.Token.add({
			type: this.__modelManager.Token.Constants.Type.DATA_SHARING,
		}, {
			_appId: appDataSharingBody._appId,
			_appDataSharingId: appDataSharingBody.id,
		});
		const token = await Helpers.streamFirst(rxsToken);

		await this.__createDataSharingPolicy(appDataSharingBody, token.id);

		Logging.logSilly(`Emitting app-policy:bust-cache ${appDataSharingBody._appId}`);
		this.__nrp.emit('app-policy:bust-cache', {
			appId: appDataSharingBody._appId,
		});

		const rxsDataShare = await super.add(appDataSharingBody, {
			_appId: appDataSharingBody._appId,
			_tokenId: token.id,
		});
		const dataSharing = await Helpers.streamFirst(rxsDataShare);

		return {dataSharing, token};
	}

	async __createDataSharingPolicy(body, tokenId) {
		return await this.__modelManager.Policy.add({
			name: `Data Sharing Policy - ${body.name}`,
			selection: {
				'#tokenType': {
					'@eq': 'DATA_SHARING',
				},
				'id': {
					'@eq': tokenId,
				},
			},
			config: body.policy,
		}, body._appId);
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
	 * @param {String} newToken - The new token which will be used to talk to the remote app
	 * @return {Promise} - resolves when save operation is completed
	 */
	activate(appDataSharingId, newToken = null) {
		const update = {
			$set: {
				active: true,
			},
		};

		if (newToken) {
			update.$set['remoteApp.token'] = newToken;
		}

		this.__nrp.emit('dataShare:activated', {appDataSharingId: appDataSharingId});

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
		this.__nrp.emit('dataShare:deactivated', {appDataSharingId: appDataSharingId});

		return this.updateById(this.createId(appDataSharingId), update);
	}
}

/**
 * Exports
 */
module.exports = AppDataSharingSchemaModel;
