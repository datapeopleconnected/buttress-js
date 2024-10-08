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

import Crypto from 'crypto';
// import * as Shared from '../shared';
import Logging from '../../helpers/logging';

import StandardModel from '../type/standard';

/**
 * Constants
*/
const type = ['system', 'app', 'user', 'dataSharing', 'lambda'];
const Type = {
	SYSTEM: type[0],
	APP: type[1],
	USER: type[2],
	DATA_SHARING: type[3],
	LAMBDA: type[4],
};

class TokenSchemaModel extends StandardModel {
	constructor(services) {
		const schema = TokenSchemaModel.Schema;
		super(schema, null, services);
	}

	static get Constants() {
		return {
			Type: Type,
		};
	}
	get Constants() {
		return TokenSchemaModel.Constants;
	}

	static get Schema() {
		return {
			name: 'tokens',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				type: {
					__type: 'string',
					__default: 'user',
					__enum: type,
					__allowUpdate: true,
				},
				value: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				domains: {
					__type: 'array',
					__required: true,
					__allowUpdate: true,
				},
				permissions: {
					__type: 'array',
					__required: true,
					__allowUpdate: true,
					__schema: {
						route: {
							__type: 'string',
							__required: true,
							__allowUpdate: true,
						},
						permission: {
							__type: 'string',
							__required: true,
							__allowUpdate: true,
						},
					},
				},
				tags: {
					__type: 'array',
					__itemtype: 'string',
					__required: true,
					__allowUpdate: true,
				},
				policyProperties: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				_appId: {
					__type: 'id',
					__default: null,
					__required: true,
					__allowUpdate: false,
				},
				_lambdaId: {
					__type: 'id',
					__default: null,
					__required: true,
					__allowUpdate: false,
				},
				_userId: {
					__type: 'id',
					__default: null,
					__required: true,
					__allowUpdate: false,
				},
				_entityId: {
					__type: 'id',
					__default: null,
					__required: true,
					__allowUpdate: false,
				},
				_appDataSharingId: {
					__type: 'id',
					__default: null,
					__required: true,
					__allowUpdate: false,
				},
			},
		};
	}

	/**
	 * @return {string} - cryptographically secure token string
	 */
	createTokenString() {
		const length = 36;
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		const mask = 0x3d;
		let string = '';

		const bytes = Crypto.randomBytes(length);
		for (let x = 0; x < bytes.length; x++) {
			const byte = bytes[x];
			string += chars[byte & mask];
		}

		return string;
	}

	/*
		* @param {Object} body - body passed through from a POST request
		* @return {Promise} - returns a promise that is fulfilled when the database request is completed
		*/
	add(body, internals) {
		body.value = this.createTokenString();
		return super.add(body, internals);
	}

	/**
	 * @param {String} userId - DB id for the user
	 * @param {String} appId - DB id for the app
	 * @return {Promise} - resolves to an array of Tokens
	 */
	findUserAuthTokens(userId, appId) {
		return this.find({
			_appId: this.createId(appId),
			_userId: this.createId(userId),
		});
	}

	findByValue(value) {
		return this.findOne({
			value: value,
		});
	}

	/**
	 * @param {String} tokenId - id of the token
	 * @param {Object} policyProperties - Policy properties
	 * @return {Promise} - resolves after updating token policy properties
	 */
	async setPolicyPropertiesById(tokenId, policyProperties) {
		if (policyProperties.query) {
			delete policyProperties.query; // What is this line for??
		}

		await super.update({
			'id': this.createId(tokenId),
		}, {$set: {'policyProperties': policyProperties}});

		this.__nrp?.emit('app-routes:bust-cache', '{}');
	}

	/**
	 * @param {String} token - token object
	 * @param {Object} policyProperties - Policy properties
	 * @return {Promise} - resolves to an array of Apps
	 */
	async updatePolicyPropertiesById(token, policyProperties) {
		if (policyProperties.query) {
			delete policyProperties.query; // Again, what is this line for??
		}

		const tokenPolicy = (token.policyProperties || {});
		const policy = Object.keys(policyProperties).reduce((obj, key) => {
			obj[key] = policyProperties[key];
			return obj;
		}, []);

		await super.update({
			'id': this.createId(token.id),
		}, {
			$set: {
				'policyProperties': {
					...tokenPolicy,
					...policy,
				},
			},
		});

		this.__nrp?.emit('app-routes:bust-cache', '{}');
	}

	/**
	 * @param {String} tokenId - tokenId
	 * @return {Promise}
	 */
	async clearPolicyPropertiesById(tokenId) {
		await super.update({
			'id': this.createId(tokenId),
		}, {
			$set: {
				'policyProperties': {},
			},
		});

		this.__nrp?.emit('app-routes:bust-cache', '{}');
	}
}

/**
 * Schema Virtual Methods
 */
// schema.virtual('details').get(function() {
//   return {
//     id: this.id,
//     type: this.type,
//     app: this.app,
//     user: this.user,
//     authLevel: this.authLevel,
//     domains: this.domains,
//     permissions: this.permissions.map(p => {
//       return {route: p.route, permission: p.permission};
//     })
//   };
// });

/**
 * Exports
 */
export default TokenSchemaModel;
