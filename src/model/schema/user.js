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
const Model = require('../');
const Logging = require('../../logging');
// const Shared = require('../shared');
const ObjectId = require('mongodb').ObjectId;
const Config = require('node-env-obj')('../');
const NRP = require('node-redis-pubsub');
const nrp = new NRP(Config.redis);

const collectionName = 'users';
const collection = Model.mongoDb.collection(collectionName);

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
	constructor(MongoDb) {
		const schema = UserSchemaModel.Schema;
		super(MongoDb, schema);
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
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @param {Object} auth - OPTIONAL authentication details for a user token
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	add(body, auth) {
		const user = {
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

		let _user = null;
		return super.add(user, {
			_apps: [Model.authApp._id],
		})
			.then((cursor) => cursor.toArray().then((data) => data.slice(0, 1).shift()))
			.then((user) => {
				_user = user;
				if (!auth) {
					return false;
				}

				return Model.Token.add(auth, {
					_app: Model.authApp._id,
					_user: _user._id,
				});
			})
			.then((cursor) => cursor.toArray().then((data) => data.slice(0, 1).shift()))
			.then((token) => {
				_user.tokens = [];

				nrp.emit('app-routes:bust-cache', {});

				if (token) {
					_user.tokens.push({
						value: token.value,
						role: token.role,
					});
				}

				return _user;
			});
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
		return super.update(update, user._id).then(() => true);
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

		return super.update({
			_apps: user._apps,
		}, user._id);
	}

	exists(id) {
		return collection.find({_id: new ObjectId(id)})
			.limit(1)
			.count()
			.then((count) => count > 0);
	}

	/**
	 * @param {ObjectId} appId - id of the App that owns the user
	 * @param {int} tokenAuthLevel - level of the current token in use.
	 * @return {Promise} - resolves to an array of Apps
	 */
	findAll(appId, tokenAuthLevel) {
		// Logging.logSilly(`findAll: ${appId}`);

		return new Promise((resolve) => {
			let findTask = () => super.find({_apps: appId});
			if (tokenAuthLevel && tokenAuthLevel === Model.Token.Constants.AuthLevel.SUPER) {
				findTask = () => super.find({});
			}

			return Promise.all([
				findTask(),
				Model.Token.find({
					type: 'user',
					_app: new ObjectId(appId),
				}),
			])
				.then((data) => {
					resolve(data[0].map((user) => {
						const tokens = data[1].filter((t) => user._id.equals(t._user));
						user.tokens = [];

						if (tokens) {
							user.tokens = tokens;
						}

						return user;
					}));
				});
		});
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
