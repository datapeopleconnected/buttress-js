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

const SchemaModel = require('../schemaModel');
const ObjectId = require('mongodb').ObjectId;
const Model = require('../');
const Logging = require('../../logging');
const Schema = require('../../schema');
// const Sugar = require('sugar');
const Shared = require('../shared');
// const Helpers = require('../../helpers');
// const Config = require('node-env-obj')('../../');

/**
 * Constants
*/
const visibility = ['public', 'private'];
const Visibility = {
	PUBLIC: visibility[0],
	PRIVATE: visibility[1],
};

class ActivitySchemaModel extends SchemaModel {
	constructor(MongoDb) {
		const schema = ActivitySchemaModel.Schema;
		super(MongoDb, schema);
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
			collection: 'activities',
			extends: [],
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
					__type: 'string',
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
				authLevel: {
					__type: 'number',
					__default: 0,
					__allowUpdate: false,
				},
				permissions: {
					__type: 'string',
					__default: '',
					__allowUpdate: false,
				},
				params: { },
				query: { },
				body: { },
				response: { },
				_token: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				_app: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				_user: {
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
	__add(body) {
		return (prev) => {
			const user = body.req.authUser;
			const userName = user ? `${user._id}` : 'System';

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
				authLevel: body.auth,
				params: body.req.params,
				query: q,
				body: Schema.encode(body.req.body), // HACK - Due to schema update results.
				timestamp: new Date(),
				_token: body.req.token._id,
				_user: (body.req.authUser) ? body.req.authUser._id : null,
				_app: body.req.authApp._id,
			};

			if (body.id) {
				md._id = new ObjectId(body.id);
			}

			const validated = Shared.applyAppProperties(false, body);
			return prev.concat([Object.assign(md, validated)]);
		};
	}

	add(body, internals) {
		body.req.body = Schema.encode(body.req.body);

		const sharedAddFn = Shared.add(this.collection, (item) => this.__add(item, internals));
		return sharedAddFn(body);
	}

	findAll(appId, tokenAuthLevel) {
		Logging.log(`getAll: ${appId}`, Logging.Constants.LogLevel.DEBUG);

		if (tokenAuthLevel && tokenAuthLevel === Model.Token.Constants.AuthLevel.SUPER) {
			return this.collection.find({});
		}

		return this.collection.find({
			_app: new ObjectId(appId),
			visibility: ActivitySchemaModel.Constants.Visibility.PUBLIC,
		});
	}
}

/**
 * Exports
 */
module.exports = ActivitySchemaModel;
