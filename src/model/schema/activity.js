'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file activity.js
 * @description Activity model definition.
 * @module Model
 * @exports model, schema, constants
 * @author Chris Bates-Keegan
 *
 */
const Model = require('../');
const Logging = require('../../logging');
const Schema = require('../../schema');
// const Sugar = require('sugar');
const Shared = require('../shared');
// const Helpers = require('../../helpers');
// const Config = require('node-env-obj')('../../');

const SchemaModel = require('../schemaModel');

/**
 * Constants
*/
const visibility = ['public', 'private'];
const Visibility = {
	PUBLIC: visibility[0],
	PRIVATE: visibility[1],
};

class ActivitySchemaModel extends SchemaModel {
	constructor(datastore) {
		const schema = ActivitySchemaModel.Schema;
		super(schema, null, datastore);
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
	__parseAddBody(body) {
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
			md._id = this.adapter.createId(body.id);
		}

		const validated = Shared.applyAppProperties(false, body);
		return Object.assign(md, validated);
	}

	add(body, internals) {
		body.req.body = Schema.encode(body.req.body);

		return super.add(body);
	}

	findAll(appId, tokenAuthLevel) {
		Logging.log(`getAll: ${appId}`, Logging.Constants.LogLevel.DEBUG);

		if (tokenAuthLevel && tokenAuthLevel === Model.Token.Constants.AuthLevel.SUPER) {
			return super.findAll({});
		}

		return super.find({
			_app: this.createId(appId),
			visibility: ActivitySchemaModel.Constants.Visibility.PUBLIC,
		});
	}
}

/**
 * Exports
 */
module.exports = ActivitySchemaModel;
