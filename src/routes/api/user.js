'use strict'; // eslint-disable-line max-lines

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file user.js
 * @description USER API specification
 * @module API
 * @author Chris Bates-Keegan
 *
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
						// TODO: findUserAuthTokens no longer returns a promises!
						const output = {
							id: _user._id,
							auth: _user.auth,
							tokens: [],
						};

						const rxTokens = Model.Token.findUserAuthTokens(_user._id, req.authApp._id);

						rxTokens.on('data', (token) => {
							output.tokens.push({
								value: token.value,
								role: token.role,
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
						};

						const rxTokens = Model.Token.findUserAuthTokens(_user._id, req.authApp._id);

						rxTokens.on('data', (token) => {
							output.tokens.push({
								value: token.value,
								role: token.role,
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
				!req.body.domains ||
				!req.body.role) {
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
			_app: Datastore.getInstance().createId(req.authApp._id),
			_user: Datastore.getInstance().createId(user._id),
		});
		const token = await Helpers.streamFirst(rxsToken);

		nrp.emit('app-routes:bust-cache', {});

		return {
			value: token.value,
			role: token.role,
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
		let appRoles = null;
		if (req.authApp && req.authApp.__roles && req.authApp.__roles.roles) {
			// This needs to be cached on startup
			appRoles = Helpers.flattenRoles(req.authApp.__roles);
		}

		return new Promise((resolve, reject) => {
			Logging.log(req.body.user, Logging.Constants.LogLevel.DEBUG);
			const app = req.body.user.app ? req.body.user.app : req.params.app;

			if (!app ||
					!req.body.user.id ||
					!req.body.user.token ||
					!req.body.user.profileImgUrl) {
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
				req.body.auth.app = req.authApp.id;

				let role = false;
				if (req.body.auth.role) {
					const matchedRole = appRoles.find((r) => r.name === req.body.auth.role);
					if (matchedRole) {
						role = matchedRole.name;
					}
				}
				if (!role) {
					role = req.authApp.__roles.default;
				}

				req.body.auth.role = role;
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
				return user;
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
 * @type {*[]}
 */
module.exports = routes;
