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

const Model = require('../');
const StandardModel = require('../type/standard');
const Helpers = require('../../helpers');

class SecureStoreSchemaModel extends StandardModel {
	constructor(nrp) {
		const schema = SecureStoreSchemaModel.Schema;
		super(schema, null, nrp);
	}

	static get Schema() {
		return {
			name: 'secureStore',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				name: {
					__type: 'string',
					__itemtype: null,
					__required: true,
					__allowUpdate: true,
				},
				storeData: {
					__type: 'object',
					__default: null,
					__required: false,
					__allowUpdate: true,
				},
				_appId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
			},
		};
	}

	/**
	 * @param {Object} req - request object
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with secure store value Object when the database request is completed
	 */
	async add(req, body) {
		const data = {
			id: (body.id) ? body.id : null,
			name: (body.name) ? body.name : null,
			storeData: (body.storeData) ? body.storeData : {},
		};

		// TODO This logic should be moved out to the route, to keep req logic
		// with the http handling. appId should just be passed through with the
		// body.
		let appId = Model?.authApp?.id;
		if (!appId) {
			const token = await this._getToken(req);
			if (token && token._appId) {
				appId = token._appId;
			}
			if (token && token._lambdaId) {
				const lambda = await Model.Lambda.findById(token._lambdaId);
				appId = lambda._appId;
			}
			if (token && token._userId) {
				const user = await Model.User.findById(token._userId);
				appId = user._appId;
			}
		}

		const rxsSecureStore = await super.add(data, {
			_appId: appId,
		});
		const secureStore = await Helpers.streamFirst(rxsSecureStore);

		return secureStore;
	}
}

/**
 * Exports
 */
module.exports = SecureStoreSchemaModel;
