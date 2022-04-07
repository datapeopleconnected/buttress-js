'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file user.js
 * @description User model definition.
 * @module Model
 * @exports model, schema, constants
 * @author Chris Bates-Keegan
 *
 */

const Model = require('../');
const Logging = require('../../logging');
// const Shared = require('../shared');
const Helpers = require('../../helpers');
const Config = require('node-env-obj')();
const NRP = require('node-redis-pubsub');
const nrp = new NRP(Config.redis);

const SchemaModel = require('../schemaModel');

/**
 * Constants
*/
const apps = ['google', 'facebook', 'twitter', 'linkedin'];
const App = {
	GOOGLE: apps[0],
	FACEBOOK: apps[1],
	TWITTER: apps[2],
	LINKEDIN: apps[3],
};

class UserSchemaModel extends SchemaModel {
	constructor(datastore) {
		const schema = UserSchemaModel.Schema;
		super(schema, null, datastore);
	}

	static get Constants() {
		return {
			App: App,
		};
	}
	get Constants() {
		return UserSchemaModel.Constants;
	}

	static get Schema() {
		return {
			name: 'users',
			type: 'collection',
			collection: 'users',
			extends: [],
			properties: {
				auth: {
					__type: 'array',
					__required: true,
					__allowUpdate: true,
					__schema: {
						app: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						appId: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						username: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						profileUrl: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						images: {
							profile: {
								__type: 'string',
								__default: '',
								__allowUpdate: true,
							},
							banner: {
								__type: 'string',
								__default: '',
								__allowUpdate: true,
							},
						},
						email: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						locale: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						token: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						tokenSecret: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						refreshToken: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
						extras: {
							__type: 'string',
							__default: '',
							__allowUpdate: true,
						},
					},
				},
				_apps: {
					__type: 'array',
					__required: true,
					__allowUpdate: true,
				},
				_attribute: {
					__type: 'array',
					__required: true,
					__allowUpdate: true,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @param {Object} auth - OPTIONAL authentication details for a user token
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async add(body, auth) {
		const userBody = {
			auth: [{
				app: body.app,
				appId: body.id,
				username: body.username,
				profileUrl: body.profileUrl,
				images: {
					profile: body.profileImgUrl,
					banner: body.bannerImgUrl,
				},
				email: body.email,
				token: body.token,
				tokenSecret: body.tokenSecret,
			}],
		};

		const rxsUser = await super.add(userBody, {
			_attribute: body.attributes,
			_apps: [Model.authApp._id],
		});
		const user = await Helpers.streamFirst(rxsUser);

		user.tokens = [];

		if (!auth) {
			return user;
		}

		const rxsToken = await Model.Token.add(auth, {
			_app: Model.authApp._id,
			_user: user._id,
		});
		const token = await Helpers.streamFirst(rxsToken);

		nrp.emit('app-routes:bust-cache', {});

		if (token) {
			user.tokens.push({
				value: token.value,
				role: token.role,
			});
		}

		return user;
	}

	addAuth(auth) {
		Logging.log(`addAuth: ${auth.app}`, Logging.Constants.LogLevel.INFO);
		const existing = this.auth.find((a) => a.app === auth.app && a.id == auth.id); // eslint-disable-line eqeqeq
		if (existing) {
			Logging.log(`present: ${auth.app}:${auth.id}`, Logging.Constants.LogLevel.DEBUG);
			return Promise.resolve(this);
		}

		Logging.log(`not present: ${auth.app}:${auth.id}`, Logging.Constants.LogLevel.DEBUG);
		this.auth.push(new Model.Appauth({
			app: auth.app,
			appId: auth.id,
			username: auth.username,
			profileUrl: auth.profileUrl,
			images: {
				profile: auth.profileImgUrl,
				banner: auth.bannerImgUrl,
			},
			email: auth.email,
			token: auth.token,
			tokenSecret: auth.tokenSecret,
			refreshToken: auth.refreshToken,
		}));
		return this.save();
	}

	/**
	 * @param {object} user - user object of which the token is being updated
	 * @param {object} app - app object of which the token is being updated
	 * @param {Object} updated - updated app information passed through from a PUT request
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	updateAppInfo(user, app, updated) {
		const authIdx = user.auth.findIndex((a) => a.app === app);
		if (authIdx === -1) {
			Logging.log(`Unable to find Appauth for ${app}`, Logging.Constants.LogLevel.DEBUG);
			return Promise.resolve(false);
		}

		const auth = user.auth[authIdx];
		auth.username = updated.username;
		auth.profileUrl = updated.profileUrl;
		auth.images.profile = updated.profileImgUrl;
		auth.images.banner = updated.bannerImgUrl;
		auth.email = updated.email;
		auth.token = updated.token;
		auth.tokenSecret = updated.tokenSecret;
		auth.refreshToken = updated.refreshToken;

		const update = {};
		update[`auth.${authIdx}`] = auth;
		return super.updateById(user._id, update).then(() => true);
	}

	updateApps(user, app) {
		Logging.log(`updateApps: ${Model.authApp._id}`, Logging.Constants.LogLevel.INFO);
		if (!user._apps) {
			user._apps = [];
		}
		const matches = user._apps.filter(function(a) {
			return a._id === app._id;
		});
		if (matches.length > 0) {
			Logging.log(`present: ${Model.authApp._id}`, Logging.Constants.LogLevel.DEBUG);
			return Promise.resolve();
		}

		Logging.log(`not present: ${Model.authApp._id}`, Logging.Constants.LogLevel.DEBUG);
		user._apps.push(app._id);

		return super.updateById(user._id, {$set: {_apps: user._apps}});
	}

	/**
	 * @param {ObjectId} appId - id of the App that owns the user
	 * @param {int} tokenAuthLevel - level of the current token in use.
	 * @return {Promise} - resolves to an array of Apps
	 */
	findAll(appId, tokenAuthLevel) {
		if (tokenAuthLevel && tokenAuthLevel === Model.Token.Constants.AuthLevel.SUPER) {
			return super.find({});
		}

		return super.find({_apps: appId});
	}

	/**
	 * @param {String} id - entity id to get
	 * @param {ObjectId} appId - id of the App that owns the user
	 * @return {Promise} - resolves to an array of Companies
	 */
	findById(id, appId) {
		// Logging.logSilly(`User:findById: ${this.collectionName} ${id}`);

		return super.findById(id);
	}

	/**
	 * @param {string} username - username to check for
	 * @return {Promise} - resolves to a User object or null
	 */
	getByUsername(username) {
		return super.findOne({username: username}, {_id: 1});
	}

	/**
	 * @param {string} appName - Name of the authenticating App (facebook|twitter|google) that owns the user
	 * @param {string} appUserId - AppId of the user
	 * @return {Promise} - resolves to an array of Apps
	 */
	getByAppId(appName, appUserId) {
		return super.findOne({
			'auth.app': appName,
			'auth.appId': appUserId,
		}, {});
	}
}

/**
 * Exports
 */
module.exports = UserSchemaModel;
