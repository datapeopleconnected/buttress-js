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
const Logging = require('../../logging');
const Helpers = require('../../helpers');
const Config = require('node-env-obj')();
const NRP = require('node-redis-pubsub');
const nrp = new NRP(Config.redis);

const Datastore = require('../../datastore');

const routes = [];

/**
 * @class GetUserList
 */
class GetUserList extends Route {
	constructor() {
		super('user', 'GET USER LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.User.findAll(req.authApp._id, req.token.authLevel);
	}
}
routes.push(GetUserList);

/**
 * @class GetUser
 */
class GetUser extends Route {
	constructor() {
		super('user/:id', 'GET USER');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;

		this._user = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			Model.User.findById(req.params.id)
				.then((_user) => {
					if (_user) {
						const output = {
							id: _user._id,
							auth: _user.auth,
							tokens: [],
							policyProperties: _user._appMetadata.find((md) => md.appId.toString() === req.authApp._id.toString())?.policyProperties,
						};

						// TODO: This should really only be a single token now
						const rxTokens = Model.Token.findUserAuthTokens(_user._id, req.authApp._id);
						rxTokens.on('data', (token) => {
							output.tokens.push({
								value: token.value,
							});
						});
						rxTokens.once('end', () => resolve(output));
					} else {
						this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
						resolve({statusCode: 400});
					}
				});
		});
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
	constructor() {
		super('user/:app(twitter|facebook|google|app-*)/:id', 'FIND USER');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			Model.User.getByAppId(req.params.app, req.params.id)
				.then((_user) => {
					if (_user) {
						const output = {
							id: _user._id,
							auth: _user.auth,
							tokens: [],
							policyProperties: _user._appMetadata?.find((md) => md.appId.toString() === req.authApp._id.toString())?.policyProperties,
						};

						const rxTokens = Model.Token.findUserAuthTokens(_user._id, req.authApp._id);
						rxTokens.on('data', (token) => {
							output.tokens.push({
								value: token.value,
							});
						});
						rxTokens.once('end', () => resolve(output));
					} else {
						resolve(false);
					}
				});
		});
	}

	_exec(req, res, validate) {
		return Promise.resolve(validate);
	}
}
routes.push(FindUser);

/**
 * @class CreateUserAuthToken
 */
class CreateUserAuthToken extends Route {
	constructor() {
		super('user/:id/token', 'CREATE USER AUTH TOKEN');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.body ||
				!req.body.authLevel ||
				!req.body.permissions ||
				!req.body.domains) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			req.body.type = Model.Token.Constants.Type.USER;

			if (!req.params.id) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			Model.User.findById(req.params.id)
				.then((user) => {
					if (user) {
						return resolve(user);
					}

					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				});
		});
	}

	async _exec(req, res, user) {
		const rxsToken = await Model.Token.add(req.body, {
			_app: Datastore.getInstance('core').ID.new(req.authApp._id),
			_user: Datastore.getInstance('core').ID.new(user._id),
		});
		const token = await Helpers.streamFirst(rxsToken);

		// We'll make sure to add the user to the app
		if (!user._apps.includes(req.authApp._id.toString())) {
			await Model.User.updateApps(user, req.authApp._id);
		}

		nrp.emit('app-routes:bust-cache', {});

		return {
			value: token.value,
		};
	}
}
routes.push(CreateUserAuthToken);

/**
 * @class AddUser
 */
class AddUser extends Route {
	constructor() {
		super('user/:app?', 'ADD USER');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			Logging.log(req.body.user, Logging.Constants.LogLevel.DEBUG);
			const app = req.body.user.app ? req.body.user.app : req.params.app;

			if (!app ||
					!req.body.user.id ||
					!req.body.user.token ||
					req.body.user.policyProperties === undefined) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			if (req.body.auth) {
				this.log(req.body.auth);
				this.log('User Auth Token Reqested');
				if (!req.body.auth.authLevel ||
						!req.body.auth.permissions ||
						!req.body.auth.domains) {
					this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `missing_field`));
				}
				req.body.auth.type = Model.Token.Constants.Type.USER;
				req.body.auth.app = req.authApp._id;
			} else {
				this.log(`[${this.name}] Auth properties are required when creating a user`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_auth`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.User.add(req.body.user, req.body.auth)
			.then((user) => {
				// TODO: Strip back return data, should match find user
				let policyProperties = null;
				if (user._appMetadata) {
					const _appMetadata = user._appMetadata.find((md) => md.appId.toString() === req.authApp._id.toString());
					policyProperties = (_appMetadata) ? _appMetadata.policyProperties : null;
				}

				return {
					id: user._id,
					auth: user.auth,
					tokens: [],
					policyProperties,
				};
			});
	}
}
routes.push(AddUser);

/**
 * @class UpdateUser
 */
class UpdateUser extends Route {
	constructor() {
		super('user/:id', 'UPDATE USER');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const validation = Model.User.validateUpdate(req.body);
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
	constructor() {
		super('user/:id/policyProperty', 'SET USER POLICY PROPERTY');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.body) {
				this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			Model.User.exists(req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});

			// TODO: Fetch the app roles and vaildate that its a valid app role
			resolve(true);
		});
	}

	async _exec(req, res, validate) {
		await Model.User.setPolicyPropertiesById(req.params.id, req.authApp._id, req.body);

		nrp.emit('worker:socket:evaluateUserRooms', {
			userId: req.params.id,
			appId: req.authApp._id,
		});

		// TODO: Do we really need to wait for the socket to respond?
		// await new Promise((resolve) => {
		// 	const id = uuidv4();

		// 	nrp.emit('worker:socket:evaluateUserRooms', {
		// 		id,
		// 		userId: req.params.id,
		// 		appId: req.authApp._id,
		// 	});

		// 	let unsubscribe = null;
		// 	unsubscribe = nrp.on('updatedUserSocketRooms', (res) => {
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
	constructor() {
		super('user/:id/updatePolicyProperty', 'UPDATE USER POLICY PROPERTY');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.body) {
				this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			Model.User.findById(req.params.id)
				.then((user) => {
					if (!user) {
						this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					const appMetadataExists = user._appMetadata.find((md) => md.appId.toString() === req.authApp._id.toString());
					if (!appMetadataExists) {
						this.log('ERROR: Invalid User app metadata', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_app_metadata`));
					}

					resolve({
						user,
					});
				});
		});
	}

	async _exec(req, res, validate) {
		await Model.User.updatePolicyPropertiesById(req.params.id, req.authApp._id, req.body, validate.user);

		nrp.emit('worker:socket:evaluateUserRooms', {
			userId: req.params.id,
			appId: req.authApp._id,
		});

		// TODO: Do we really need to wait for the socket to respond?
		// await new Promise((resolve) => {
		// 	const id = uuidv4();

		// 	nrp.emit('worker:socket:evaluateUserRooms', {
		// 		id,
		// 		userId: req.params.id,
		// 		appId: req.authApp._id,
		// 	});

		// 	let unsubscribe = null;
		// 	unsubscribe = nrp.on('updatedUserSocketRooms', (res) => {
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
 * @class ClearUserPolicyProperties
 */
class ClearUserPolicyProperties extends Route {
	constructor() {
		super('user/:id/clearPolicyProperty', 'REMOVE USER POLICY PROPERTY');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.body) {
				this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			Model.User.findById(req.params.id)
				.then((user) => {
					if (!user) {
						this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}

					resolve({
						user,
					});
				});
		});
	}

	async _exec(req, res, validate) {
		await Model.User.clearPolicyPropertiesById(req.params.id, req.authApp._id, validate.user);

		nrp.emit('worker:socket:evaluateUserRooms', {
			userId: req.params.id,
			appId: req.authApp._id,
		});

		return true;
	}
}
routes.push(ClearUserPolicyProperties);

/**
 * @class DeleteAllUsers
 */
class DeleteAllUsers extends Route {
	constructor() {
		super('user', 'DELETE ALL USERS');
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.SUPER;
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
	constructor() {
		super('user/:id', 'DELETE USER');
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.DELETE;
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
		return Model.User.rm(user)
			.then(() => true);
	}
}
routes.push(DeleteUser);

/**
 * @class clearUserLocalData
 */
class clearUserLocalData extends Route {
	constructor() {
		super('user/:id/clearLocalData', 'CLEAR USER LOCAL DATA');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.USER;
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
		nrp.emit('clearUserLocalData', {
			appAPIPath: req.authApp ? req.authApp.apiPath : '',
			userId: user._id,
			collections: (req.body.collections)? req.body.collections : false,
		});
	}
}
routes.push(clearUserLocalData);

/**
 * @type {*[]}
 */
module.exports = routes;
