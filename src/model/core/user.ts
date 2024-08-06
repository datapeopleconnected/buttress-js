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

import Logging from '../../helpers/logging';
// import * as Shared from '../shared';
import * as Helpers from '../../helpers';

import StandardModel from '../type/standard';

/**
 * Constants
*/
const apps = ['google', 'facebook', 'twitter', 'linkedin', 'microsoft'];
const App = {
	GOOGLE: apps[0],
	FACEBOOK: apps[1],
	TWITTER: apps[2],
	LINKEDIN: apps[3],
	MICROSOFT: apps[4],
};

export default class UserSchemaModel extends StandardModel {
	constructor(services) {
		const schema = UserSchemaModel.Schema;
		super(schema, null, services);
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
			extends: [],
			core: true,
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
						password: {
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
				_appId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
			},
		};
	}

	// Pre-lambda user addition
	// /**
	//  * @param {Object} body - body passed through from a POST request
	//  * @param {Object} auth - OPTIONAL authentication details for a user token
	//  * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	//  */
	// async add(body, auth) {
	// 	const userBody = {
	// 		auth: [{
	// 			app: body.app,
	// 			appId: body.id,
	// 			username: body.username,
	// 			password: body.password,
	// 			profileUrl: body.profileUrl,
	// 			images: {
	// 				profile: body.profileImgUrl,
	// 				banner: body.bannerImgUrl,
	// 			},
	// 			email: body.email,
	// 			token: body.token,
	// 			tokenSecret: body.tokenSecret,
	// 			refreshToken: body.refreshToken,
	// 		}],
	// 	};

	// 	const rxsUser = await super.add(userBody, {
	// 		_appId: this.__modelManager.authApp.id,
	// 		_appMetadata: [{
	// 			appId: this.__modelManager.authApp.id,
	// 			policyProperties: (body.policyProperties) ? body.policyProperties : null,
	// 		}],
	// 	});
	// 	const user = await Helpers.streamFirst(rxsUser);

	// 	user.tokens = [];

	// 	if (!auth) {
	// 		return user;
	// 	}

	// 	const rxsToken = await this.__modelManager.Token.add(auth, {
	// 		_appId: this.__modelManager.authApp.id,
	// 		_userId: user.id,
	// 	});
	// 	const token = await Helpers.streamFirst(rxsToken);

	// 	this.__nrp.emit('app-routes:bust-cache', {});

	// 	if (token) {
	// 		user.tokens.push({
	// 			value: token.value,
	// 		});
	// 	}

	// 	return user;
	// }

	/**
	 * @param {Object} body - body passed through from a POST request
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async add(body) {
		const userBody: {
			id: string,
			auth: Array<{
				app: string,
				appId: string,
				username: string,
				password: string,
				profileUrl: string,
				images: {
					profile: string,
					banner: string,
				},
				email: string,
				token: string,
				tokenSecret: string,
				refreshToken: string,
			}>
		}= {
			id: (body.id) ? this.createId(body.id) : this.createId(),
			auth: [],
		};
		body.auth.forEach((item) => {
			userBody.auth.push({
				app: item.app,
				appId: (item.appId) ? item.appId : null,
				username: item.username,
				password: item.password,
				profileUrl: item.profileUrl,
				images: {
					profile: item.profileImgUrl,
					banner: item.bannerImgUrl,
				},
				email: item.email,
				token: item.token,
				tokenSecret: item.tokenSecret,
				refreshToken: item.refreshToken,
			});
		});

		const rxsUser = await super.add(userBody, {
			_appId: this.__modelManager.authApp.id,
		});
		const user: any = await Helpers.streamFirst(rxsUser);

		user.tokens = [];

		const tokenBody = body.token;
		if (tokenBody && tokenBody.domains && tokenBody.policyProperties) {
			const userToken = {
				type: this.__modelManager.Token.Constants.Type.USER,
				permissions: [{route: '*', permission: '*'}],
				domains: tokenBody.domains,
				policyProperties: tokenBody.policyProperties,
			};

			const rxsToken = await this.__modelManager.Token.add(userToken, {
				_appId: this.__modelManager.authApp.id,
				_userId: user.id,
			});
			const token: any = await Helpers.streamFirst(rxsToken);

			if (token) {
				user.tokens.push({
					value: token.value,
					policyProperties: token.policyProperties,
				});
			}
		}

		this.__nrp?.emit('app-routes:bust-cache', '{}');

		return user;
	}

	// addAuth(auth) {
	// 	Logging.log(`addAuth: ${auth.app}`, Logging.Constants.LogLevel.INFO);
	// 	const existing = this.auth.find((a) => a.app === auth.app && a.id == auth.id); // eslint-disable-line eqeqeq
	// 	if (existing) {
	// 		Logging.log(`present: ${auth.app}:${auth.id}`, Logging.Constants.LogLevel.DEBUG);
	// 		return Promise.resolve(this);
	// 	}

	// 	Logging.log(`not present: ${auth.app}:${auth.id}`, Logging.Constants.LogLevel.DEBUG);
	// 	this.auth.push(new this.__modelManager.Appauth({
	// 		app: auth.app,
	// 		appId: auth.id,
	// 		username: auth.username,
	// 		profileUrl: auth.profileUrl,
	// 		images: {
	// 			profile: auth.profileImgUrl,
	// 			banner: auth.bannerImgUrl,
	// 		},
	// 		email: auth.email,
	// 		token: auth.token,
	// 		tokenSecret: auth.tokenSecret,
	// 		refreshToken: auth.refreshToken,
	// 	}));

	// 	return this.save();
	// }

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
		return super.updateById(user.id, update).then(() => true);
	}

	/**
	 * @param {string} username - username to check for
	 * @return {Promise} - resolves to a User object or null
	 */
	getByUsername(username) {
		return super.findOne({username: username}, {id: 1});
	}

	/**
	 * @param {string} authAppName - Name of the authenticating App (facebook|twitter|google) that owns the user
	 * @param {string} authAppUserId - Id of the user in the authenticating App
	 * @param {string} appId - Buttress App Id of the user
	 * @return {Promise} - resolves to an array of Apps
	 */
	getByAuthAppId(authAppName, authAppUserId, appId = undefined) {
		return super.findOne({
			'auth.app': authAppName,
			'auth.appId': authAppUserId,
			...(appId) ? {_appId: this.createId(appId)} : {},
		});
	}
}