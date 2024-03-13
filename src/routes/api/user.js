/* eslint-disable max-lines */
'use strict'; // eslint-disable-line max-lines

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
const Route = require('../route');
const Model = require('../../model');
const Logging = require('../../helpers/logging');
const Helpers = require('../../helpers');
const Datastore = require('../../datastore');

const routes = [];

/**
 * @class GetUserList
 */
class GetUserList extends Route {
	constructor(nrp, redisClient) {
		super('user', 'GET USER LIST', nrp, redisClient);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.User.findAll(req.authApp.id, req.token);
	}
}
routes.push(GetUserList);

/**
 * @class GetUser
 */
class GetUser extends Route {
	constructor(nrp) {
		super('user/:id', 'GET USER', nrp);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;

		this._user = false;
	}

	async _validate(req, res, token) {
		if (!req.params.id) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `missing_field`);
		}

		if (req.params.id === 'me') {
			if (!token) {
				this.log(`[${this.name}] Missing token`, Route.LogLevel.ERR);
				throw new Helpers.Errors.RequestError(400, `missing_token`);
			}
			req.params.id = token._userId;
		}

		let user = null;
		let userTokens = [];
		let userId = null;
		try {
			userId = Model.User.createId(req.params.id);
		} catch (err) {
			throw new Helpers.Errors.RequestError(400, `inavlid_id`);
		}

		user = await Model.User.findOne({
			'$or': [{
				'id': {
					$eq: userId,
				},
			}],
			...(req.authApp.id) ? {_appId: Model.App.createId(req.authApp.id)} : {},
		});

		if (!user) {
			this.log(`[${this.name}] Could not fetch user data using ${userId}`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(404, `user_not_found`);
		}

		if (userTokens.length < 1 && user) {
			userTokens = await Helpers.streamAll(await Model.Token.findUserAuthTokens(user.id, req.authApp.id));
		}
		if (userTokens.length < 1) {
			this.log(`[${this.name}] User does not have a token yet ${userId}`, Route.LogLevel.ERR);
		}

		const output = {
			id: user.id,
			auth: user.auth,
			tokens: (userTokens.length > 0) ? userTokens.map((t) => {
				return {
					value: t.value,
					policyProperties: t.policyProperties,
				};
			}) : null,
		};

		return output;
	}

	_exec(req, res, user) {
		return user;
	}
}
routes.push(GetUser);

/**
 * @class FindUser
 */
class FindUser extends Route {
	constructor(nrp) {
		super('user/:app(twitter|facebook|google|linkedin|microsoft|app-*)/:id', 'FIND USER', nrp);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const _user = await Model.User.getByAuthAppId(req.params.app, req.params.id, req.authApp.id);
		if (!_user) {
			this.log(`[${this.name}] Could not fetch user`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(404, `user_not_found`));
		}

		const output = {
			id: _user.id,
			auth: _user.auth,
			tokens: [],
		};

		const userTokens = await Helpers.streamAll(await Model.Token.findUserAuthTokens(_user.id, req.authApp.id));
		output.tokens = (userTokens.length > 0) ? userTokens.map((t) => {
			return {
				value: t.value,
				policyProperties: t.policyProperties,
			};
		}) : null;

		return Promise.resolve(output);
	}

	_exec(req, res, validate) {
		return Promise.resolve(validate);
	}
}
routes.push(FindUser);

/**
 * @class GetUserByToken
 */
class GetUserByToken extends Route {
	constructor(nrp) {
		super('user/get-by-token', 'GET USER BY TOKEN', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.READ;

		this._user = false;
	}

	async _validate(req) {
		const {token} = req.body;
		if (!token) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `missing_field`);
		}

		const userToken = await Model.Token.findOne({
			value: {
				$eq: token,
			},
		});
		if (!userToken) {
			this.log('ERROR: Invalid User Token', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `invalid_token`);
		}

		const user = await Model.User.findById(userToken._userId);
		if (!user) {
			this.log('ERROR: Can not find a user with the provided token', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(404, `user_not_found`);
		}

		return {
			id: user.id,
			auth: user.auth,
			token: userToken.value,
			policyProperties: userToken.policyProperties || null,
		};
	}

	_exec(req, res, user) {
		return user;
	}
}
routes.push(GetUserByToken);

/**
 * @class CreateUserAuthToken
 */
class CreateUserAuthToken extends Route {
	constructor(nrp) {
		super('user/:id/token', 'CREATE USER AUTH TOKEN', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.redactResults = false;
	}

	async _validate(req, res, token) {
		if (!req.body ||
			!req.body.policyProperties ||
			!req.body.permissions ||
			!req.body.domains) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		req.body.type = Model.Token.Constants.Type.USER;

		if (!req.params.id) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const user = await Model.User.findById(req.params.id);
		if (!user) {
			this.log(`[${this.name}] User not found`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(404, `user_not_found`));
		}

		const policyCheck = await Helpers.checkAppPolicyProperty(req.authApp.policyPropertiesList, req.body.policyProperties);
		if (!policyCheck.passed) {
			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_property`));
		}

		return Promise.resolve(user);
	}

	async _exec(req, res, user) {
		const rxsToken = await Model.Token.add(req.body, {
			_appId: Datastore.getInstance('core').ID.new(req.authApp.id),
			_userId: Datastore.getInstance('core').ID.new(user.id),
		});
		const token = await Helpers.streamFirst(rxsToken);

		// We'll make sure to add the user to the app
		// if (user._appId !== req.authApp.id.toString()) {
		// 	await Model.User.updateApps(user, req.authApp.id);
		// }

		this._nrp.emit('app-routes:bust-cache', {});

		return {
			value: token.value,
			policyProperties: token.policyProperties,
		};
	}
}
routes.push(CreateUserAuthToken);

// Pre-lambda user addition
// /**
//  * @class AddUser
//  */
// class AddUser extends Route {
// 	constructor() {
// 		super('user/:app?', 'ADD USER');
// 		this.verb = Route.Constants.Verbs.POST;
// 		this.auth = Route.Constants.Auth.ADMIN;
// 		this.permissions = Route.Constants.Permissions.ADD;
// 	}

// 	async _validate(req, res, token) {
// 		Logging.log(req.body.user, Logging.Constants.LogLevel.DEBUG);
// 		const app = req.body.user.app ? req.body.user.app : req.params.app;

// 		if (!app ||
// 				!req.body.user.id ||
// 				!req.body.user.token ||
// 				req.body.user.policyProperties === undefined) {
// 			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
// 			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
// 		}

// 		if (req.body.auth) {
// 			this.log(req.body.auth);
// 			this.log('User Auth Token Reqested');
// 			if (!req.body.auth.authLevel ||
// 					!req.body.auth.permissions ||
// 					!req.body.auth.domains) {
// 				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
// 				return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
// 			}

// 			req.body.auth.type = Model.Token.Constants.Type.USER;
// 			req.body.auth.app = req.authApp.id;
// 		} else {
// 			this.log(`[${this.name}] Auth properties are required when creating a user`, Route.LogLevel.ERR);
// 			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_auth`));
// 		}

// 		const policyCheck = await Helpers.checkAppPolicyProperty(req?.authApp?.policyPropertiesList, req.body.user.policyProperties);
// 		if (!policyCheck.passed) {
// 			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
// 			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
// 		}

// 		return Promise.resolve(true);
// 	}

// 	async _exec(req, res, validate) {
// 		const user = await Model.User.add(req.body.user, req.body.auth);
// 		// TODO: Strip back return data, should match find user
// 		let policyProperties = null;
// 		if (user._appMetadata) {
// 			const _appMetadata = user._appMetadata.find((md) => md.appId.toString() === req.authApp.id.toString());
// 			policyProperties = (_appMetadata) ? _appMetadata.policyProperties : null;
// 		}

// 		return {
// 			id: user.id,
// 			auth: user.auth,
// 			tokens: user.tokens,
// 			policyProperties,
// 		};
// 	}
// }
// routes.push(AddUser);

/**
 * @class AddUser
 */
class AddUser extends Route {
	constructor(nrp) {
		super('user', 'ADD USER', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		Logging.log(req.body, Logging.Constants.LogLevel.DEBUG);

		if (!req.body.auth) {
			this.log(`[${this.name}] Missing required user auth block`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_user_auth`));
		}

		if (!Array.isArray(req.body.auth) || (Array.isArray(req.body.auth) && req.body.auth.length < 1)) {
			this.log(`[${this.name}] Invalid user auth block`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_user_auth`));
		}

		const existingUsers = [];
		for await (const auth of req.body.auth) {
			const user = await Model.User.findOne({
				'auth.email': auth.email,
				'auth.app': auth.app,
				'_appId': Model.App.createId(req.authApp.id),
			});
			if (user) {
				existingUsers.push(user);
			}
		}

		if (existingUsers.length > 0) {
			this.log(`[${this.name}] A user already exists with one of the auth username(s)`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_already_exists_with_that_name`));
		}

		if (req.body.token && req.body.token.policyProperties) {
			const policyCheck = await Helpers.checkAppPolicyProperty(req.authApp.policyPropertiesList, req.body.token.policyProperties);
			if (!policyCheck) {
				this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_property`));
			}
		}

		return Promise.resolve(true);
	}

	async _exec(req, res, validate) {
		const user = await Model.User.add(req.body);

		return {
			id: user.id,
			auth: user.auth,
			tokens: user.tokens,
		};
	}
}
routes.push(AddUser);

/**
 * @class UpdateUser
 */
class UpdateUser extends Route {
	constructor(nrp) {
		super('user/:id', 'UPDATE USER', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const {validation, body} = Model.User.validateUpdate(req.body);
			req.body = body;
			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `USER: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `USER: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			Model.User.exists(req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return Model.User.updateByPath(req.body, req.params.id);
	}
}
routes.push(UpdateUser);

/**
 * @class SetUserPolicyProperties
 */
class SetUserPolicyProperties extends Route {
	constructor(nrp) {
		super('user/:id/policy-property', 'SET USER POLICY PROPERTY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const userId = Model.User.createId(req.params.id);
		const app = req.authApp;
		if (!app) {
			this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = await Model.User.exists(userId);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const userToken = await Model.Token.findOne({
			_userId: userId,
		});
		if (!userToken) {
			this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_not_found`));
		}

		const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
		if (!policyCheck.passed) {
			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
		}

		return Promise.resolve(userToken);
	}

	async _exec(req, res, validate) {
		await Model.Token.setPolicyPropertiesById(validate.id, req.body);

		this._nrp.emit('worker:socket:evaluateUserRooms', {
			userId: req.params.id,
			appId: req.authApp.id,
		});

		// TODO: Do we really need to wait for the socket to respond?
		// await new Promise((resolve) => {
		// 	const id = uuidv4();

		// 	this._nrp.emit('worker:socket:evaluateUserRooms', {
		// 		id,
		// 		userId: req.params.id,
		// 		appId: req.authApp.id,
		// 	});

		// 	let unsubscribe = null;
		// 	unsubscribe = this._nrp.on('updatedUserSocketRooms', (res) => {
		// 		if (res.id !== id) return;
		// 		unsubscribe();
		// 		resolve();
		// 	});
		// });

		return true;
	}
}
routes.push(SetUserPolicyProperties);

/**
 * @class UpdateUserPolicyProperties
 */
class UpdateUserPolicyProperties extends Route {
	constructor(nrp) {
		super('user/:id/update-policy-property', 'UPDATE USER POLICY PROPERTY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = Model.User.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const userToken = await Model.Token.findOne({
			_userId: Model.User.createId(req.params.id),
		});
		if (!userToken) {
			this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_token_not_found`));
		}

		return Promise.resolve(userToken);
	}

	async _exec(req, res, validate) {
		await Model.Token.updatePolicyPropertiesById(validate, req.body);

		this._nrp.emit('worker:socket:evaluateUserRooms', {
			userId: req.params.id,
			appId: req.authApp.id,
		});

		// TODO: Do we really need to wait for the socket to respond?
		// await new Promise((resolve) => {
		// 	const id = uuidv4();

		// 	this._nrp.emit('worker:socket:evaluateUserRooms', {
		// 		id,
		// 		userId: req.params.id,
		// 		appId: req.authApp.id,
		// 	});

		// 	let unsubscribe = null;
		// 	unsubscribe = this._nrp.on('updatedUserSocketRooms', (res) => {
		// 		if (res.id !== id) return;
		// 		unsubscribe();
		// 		resolve();
		// 	});
		// });

		return true;
	}
}
routes.push(UpdateUserPolicyProperties);

/**
 * @class RemoveUserPolicyProperties
 */
class RemoveUserPolicyProperties extends Route {
	constructor(nrp) {
		super('user/:id/remove-policy-property', 'REMOVE USER POLICY PROPERTY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		if (!req.body || !req.body.policyProperties) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = Model.User.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const userToken = await Model.Token.findOne({
			_userId: Model.User.createId(req.params.id),
		});


		if (!userToken) {
			this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_not_found`));
		}

		return Promise.resolve(userToken);
	}

	async _exec(req, res, validate) {
		const reqPolicyProps = req.body.policyProperties;
		const policyProps = validate.policyProperties;
		Object.keys(reqPolicyProps).forEach((key) => {
			if (policyProps[key] && policyProps[key] === reqPolicyProps[key]) {
				delete policyProps[key];
			}
		});
		await Model.Token.updatePolicyPropertiesById(validate.id, policyProps);

		this._nrp.emit('worker:socket:evaluateUserRooms', {
			userId: req.params.id,
			appId: req.authApp.id,
		});

		return true;
	}
}
routes.push(RemoveUserPolicyProperties);

/**
 * @class ClearUserPolicyProperties
 */
class ClearUserPolicyProperties extends Route {
	constructor(nrp) {
		super('user/:id/clear-policy-property', 'CLEAR USER POLICY PROPERTY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = Model.User.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const userToken = await Model.Token.findOne({
			_userId: Model.User.createId(req.params.id),
		});
		if (!userToken) {
			this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_not_found`));
		}

		return Promise.resolve(userToken);
	}

	async _exec(req, res, validate) {
		await Model.Token.clearPolicyPropertiesById(validate.id);

		this._nrp.emit('worker:socket:evaluateUserRooms', {
			userId: req.params.id,
			appId: req.authApp.id,
		});

		return true;
	}
}
routes.push(ClearUserPolicyProperties);

/**
 * @class DeleteAllUsers
 */
class DeleteAllUsers extends Route {
	constructor(nrp) {
		super('user', 'DELETE ALL USERS', nrp);
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.DELETE;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.User.rmAll().then(() => true);
	}
}
routes.push(DeleteAllUsers);

/**
 * @class DeleteUser
 */
class DeleteUser extends Route {
	constructor(nrp) {
		super('user/:id', 'DELETE USER', nrp);
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;
		this._user = false;
	}

	async _validate(req, res, token) {
		if (!req.params.id) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const user = await Model.User.findById(req.params.id);
		if (!user) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const userToken = await Model.Token.findOne({_userId: user.id});
		if (token.value === userToken?.value) {
			this.log(`ERROR: A user could not delete itself`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_can_not_delete_itself`));
		}

		return {
			user,
			token: userToken,
		};
	}

	async _exec(req, res, validate) {
		await Model.User.rm(validate.user.id);

		if (validate.token) {
			await Model.Token.rm(validate.token.id);
		}

		return true;
	}
}
routes.push(DeleteUser);

/**
 * @class clearUserLocalData
 */
class clearUserLocalData extends Route {
	constructor(nrp) {
		super('user/:id/clear-local-data', 'CLEAR USER LOCAL DATA', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this._user = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			Model.User.findById(req.params.id)
				.then((user) => {
					if (user) {
						return resolve(user);
					}

					this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				});
		});
	}

	_exec(req, res, user) {
		this._nrp.emit('clearUserLocalData', {
			appAPIPath: req.authApp ? req.authApp.apiPath : '',
			userId: user.id,
			collections: (req.body.collections)? req.body.collections : false,
		});
	}
}
routes.push(clearUserLocalData);

/**
 * @class SearchUserList
 */
class SearchUserList extends Route {
	constructor(nrp) {
		super('user', 'SEARCH USER LIST', nrp);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		const result = {
			query: {
				$and: [],
			},
			skip: (req.body && req.body.skip) ? parseInt(req.body.skip) : 0,
			limit: (req.body && req.body.limit) ? parseInt(req.body.limit) : 0,
			sort: (req.body && req.body.sort) ? req.body.sort : {},
			project: (req.body && req.body.project)? req.body.project : false,
		};

		if (isNaN(result.skip)) throw new Helpers.Errors.RequestError(400, `invalid_value_skip`);
		if (isNaN(result.limit)) throw new Helpers.Errors.RequestError(400, `invalid_value_limit`);

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = Model.User.parseQuery(result.query, {}, Model.User.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.User.find(validate.query, {},
			validate.limit, validate.skip, validate.sort, validate.project);
	}
}
routes.push(SearchUserList);

/**
 * @class UserCount
 */
class UserCount extends Route {
	constructor(nrp) {
		super(`user/count`, `COUNT USERS`, nrp);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT USERS`;
		this.activityBroadcast = false;

		this.model = Model.User;
	}

	_validate(req, res, token) {
		const result = {
			query: {},
		};

		let query = {};

		if (!query.$and) {
			query.$and = [];
		}

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			query.$and.push(req.body.query);
		} else if (req.body && !req.body.query) {
			query.$and.push(req.body);
		}

		query = this.model.parseQuery(query, {}, this.model.flatSchemaData);
		result.query = query;
		return result;
	}

	_exec(req, res, validateResult) {
		return Model.User.count(validateResult.query);
	}
}
routes.push(UserCount);

/**
 * @type {*[]}
 */
module.exports = routes;
