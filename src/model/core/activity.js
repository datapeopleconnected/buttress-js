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
const Logging = require('../../helpers/logging');
const Schema = require('../../schema');
// const Sugar = require('sugar');
const Shared = require('../shared');
// const Helpers = require('../../helpers');
// const Config = require('node-env-obj')('../../');

const StandardModel = require('../type/standard');

/**
 * Constants
*/
const visibility = ['public', 'private'];
const Visibility = {
	PUBLIC: visibility[0],
	PRIVATE: visibility[1],
};

class ActivitySchemaModel extends StandardModel {
	constructor(services) {
		const schema = ActivitySchemaModel.Schema;
		super(schema, null, services);
	}

	static get Constants() {
		return {
			Visibility: Visibility,
		};
	}
	get Constants() {
		return ActivitySchemaModel.Constants;
	}

	static get Schema() {
		return {
			name: 'activities',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				timestamp: {
					__type: 'date',
					__default: 'now',
					__allowUpdate: false,
				},
				title: {
					__type: 'string',
					__default: '',
					__allowUpdate: false,
				},
				description: {
					__type: 'text',
					__default: '',
					__allowUpdate: false,
				},
				visibility: {
					__type: 'string',
					__default: 'private',
					__enum: visibility,
					__allowUpdate: false,
				},
				path: {
					__type: 'string',
					__default: '',
					__allowUpdate: false,
				},
				verb: {
					__type: 'string',
					__default: '',
					__allowUpdate: false,
				},
				authType: {
					__type: 'string',
					__default: '',
					__allowUpdate: false,
				},
				permissions: {
					__type: 'string',
					__default: '',
					__allowUpdate: false,
				},
				params: {
					id: {
						__type: 'id',
						__default: null,
						__allowUpdate: false,
					},
				},
				body: {
					__type: 'text',
					__default: '',
					__allowUpdate: false,
				},
				_tokenId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				_appId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				_userId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - fulfilled with App Object when the database request is completed
	 */
	__parseAddBody(body) {
		const user = body.req.authUser;
		const userName = user ? `${user.id}` : 'App';

		body.activityTitle = body.activityTitle.replace('%USER_NAME%', userName);
		body.activityDescription = body.activityDescription.replace('%USER_NAME%', userName);

		const q = Object.assign({}, body.req.query);
		delete q.token;
		delete q.urq;

		const md = {
			title: body.activityTitle,
			description: body.activityDescription,
			visibility: body.activityVisibility,
			path: body.path,
			verb: body.verb,
			permissions: body.permissions,
			authType: body.auth,
			params: body.req.params,
			query: q,
			body: Schema.encode(body.req.body), // HACK - Due to schema update results.
			timestamp: new Date(),
			_tokenId: body.req.token.id,
			_userId: (body.req.authUser) ? body.req.authUser.id : null,
			_appId: body.req.authApp.id,
		};

		if (body.id) {
			md.id = this.adapter.ID.new(body.id);
		}

		delete body.req;
		delete body.res;

		return Shared.sanitizeSchemaObject(ActivitySchemaModel.Schema, body);
	}

	add(body, internals) {
		body.req.body = Schema.encode(body.req.body);

		return super.add(body);
	}

	findAll(appId, token) {
		Logging.log(`getAll: ${appId}`, Logging.Constants.LogLevel.DEBUG);

		if (token && token.type === Model.Token.Constants.Type.SYSTEM) {
			return super.findAll({});
		}

		return super.find({
			_appId: this.createId(appId),
			visibility: ActivitySchemaModel.Constants.Visibility.PUBLIC,
		});
	}
}

/**
 * Exports
 */
module.exports = ActivitySchemaModel;
