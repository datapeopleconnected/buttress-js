/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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
import Route from '../route.js';
import Model from '../../model/index.js';
import Logging from '../../helpers/logging.js';
import * as Helpers from '../../helpers/index.js';
import Datastore from '../../datastore/index.js';
import TokenSchemaModel from '../../model/core/token.js';
import UserSchemaModel from '../../model/core/user.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import AppSchemaModel from '../../model/core/app.js';

const routes: (typeof Route)[] = [];

function getTokenQueryfromParams(req, userId) {
	let tokenId = null;
	try {
		tokenId = Model.getCoreModel(TokenSchemaModel).createId(req.params.tokenId);
	} catch (err) {
		Logging.logSilly(err);
	}

	// If tokenId is not set, we will treat it as the token value.
	const tokenValue = (tokenId === null) ? req.params.tokenId : null;

	if (!tokenId && !tokenValue) {
		return null;
	}

	const tokenQuery: {
		_id?: string;
		_userId: string;
		value?: string;
	} = {
		_userId: userId,
	};
	if (tokenId) tokenQuery._id = tokenId;
	if (tokenValue) tokenQuery.value = tokenValue;

	return tokenQuery;
}

/**
 * @class GetUserList
 */
class GetUserList extends Route {
	constructor(services) {
		super('user', 'GET USER LIST', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		if (req.token && req.token.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
			return Model.getCoreModel(UserSchemaModel).findAll();
		}

		return Model.getCoreModel(UserSchemaModel).find({ _appId: Model.getCoreModel(UserSchemaModel).createId(req.authApp.id) });
	}
}
routes.push(GetUserList);

/**
 * @class GetUser
 */
class GetUser extends Route {
	constructor(services) {
		super('user/:id', 'GET USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.READ;
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

		let user: any = null;
		let userTokens: any[] = [];
		let userId: string;

		try {
			userId = Model.getCoreModel(UserSchemaModel).createId(req.params.id);
		} catch (err) {
			throw new Helpers.Errors.RequestError(400, `inavlid_id`);
		}


		const isSystemToken = req.token && req.token.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM;
		user = await Model.getCoreModel(UserSchemaModel).findOne({
			'$or': [{
				'id': {
					$eq: userId,
				},
			}],
			...(req.authApp.id && !isSystemToken) ? { _appId: Model.getCoreModel(AppSchemaModel).createId(req.authApp.id) } : {},
		});

		if (!user) {
			this.log(`[${this.name}] Could not fetch user data using ${userId}`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(404, `user_not_found`);
		}

		if (userTokens.length < 1 && user) {
			userTokens = await Helpers.streamAll(await Model.getCoreModel(TokenSchemaModel).findUserAuthTokens(user.id, req.authApp.id));
		}
		if (userTokens.length < 1) {
			this.log(`[${this.name}] User does not have a token yet ${userId}`, Route.LogLevel.ERR);
		}

		const output = {
			id: user.id,
			auth: user.auth,
			tokens: (userTokens.length > 0) ? userTokens.map((t) => {
				return {
					id: t.id,
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
	constructor(services) {
		super('user/:app(twitter|facebook|google|linkedin|microsoft|app-*)/:id', 'FIND USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const _user = await Model.getCoreModel(UserSchemaModel).getByAuthAppId(req.params.app, req.params.id, req.authApp.id);
		if (!_user) {
			this.log(`[${this.name}] Could not fetch user`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(404, `user_not_found`));
		}

		const output: {
			id: string;
			auth: any;
			tokens: any[];
		} = {
			id: _user.id,
			auth: _user.auth,
			tokens: [],
		};

		const userTokens = await Helpers.streamAll(await Model.getCoreModel(TokenSchemaModel).findUserAuthTokens(_user.id, req.authApp.id));
		output.tokens = (userTokens.length > 0) ? userTokens.map((t) => {
			return {
				value: t.value,
				policyProperties: t.policyProperties,
			};
		}) : [];

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
	constructor(services) {
		super('user/get-by-token', 'GET USER BY TOKEN', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req) {
		const { token } = req.body;
		if (!token) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `missing_field`);
		}

		const userToken = await Model.getCoreModel(TokenSchemaModel).findOne({
			value: {
				$eq: token,
			},
		});
		if (!userToken) {
			this.log('ERROR: Invalid User Token', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `invalid_token`);
		}

		const user = await Model.getCoreModel(UserSchemaModel).findById(userToken._userId);
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
	constructor(services) {
		super('user/:id/token', 'CREATE USER AUTH TOKEN', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.redactResults = false;
	}

	async _validate(req, res, token) {
		if (!req.body ||
			!req.body.policyProperties ||
			!req.body.domains) {
			this.log(`[${this.name}] Missing required field (policyProperties or domains)`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		req.body.type = Model.getCoreModel(TokenSchemaModel).Constants.Type.USER;

		if (!req.params.id) {
			this.log(`[${this.name}] Missing required field (id)`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const user = await Model.getCoreModel(UserSchemaModel).findById(req.params.id);
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
		const rxsToken = await Model.getCoreModel(TokenSchemaModel).add(req.body, {
			_appId: Datastore.getInstance('core').ID.new(req.authApp.id),
			_userId: Datastore.getInstance('core').ID.new(user.id),
		});
		const token: any = await Helpers.streamFirst(rxsToken);

		// We'll make sure to add the user to the app
		// if+ (user._appId !== req.authApp.id.toString()) {
		// 	await Model.getCoreModel(UserSchemaModel).updateApps(user, req.authApp.id);
		// }

		this._nrp?.emit('app-routes:bust-cache', '{}');

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

// 			req.body.auth.type = Model.getCoreModel(TokenSchemaModel).Constants.Type.USER;
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
// 		const user = await Model.getCoreModel(UserSchemaModel).add(req.body.user, req.body.auth);
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
	constructor(services) {
		super('user', 'ADD USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.LAMBDA;
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

		const existingUsers: any[] = [];
		for await (const auth of req.body.auth) {
			const user = await Model.getCoreModel(UserSchemaModel).findOne({
				'auth.app': auth.app,
				$or: [
					{ 'auth.appId': auth.appId },
					{ 'auth.email': auth.email },
				],
				'_appId': Model.getCoreModel(AppSchemaModel).createId(req.authApp.id),
			});
			if (user) {
				existingUsers.push(user);
			}
		}

		if (existingUsers.length > 0) {
			this.log(`[${this.name}] A user already exists with matching auth (appId or email)`, Route.LogLevel.ERR);
			Logging.logObject(existingUsers, Logging.LogLevel.DEBUG);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_already_exists_with_that_name`));
		}

		if (req.body.token && req.body.token.policyProperties) {
			const policyCheck = await Helpers.checkAppPolicyProperty(req.authApp.policyPropertiesList, req.body.token.policyProperties);
			if (!policyCheck.passed) {
				this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_property`));
			}
		}

		return Promise.resolve(true);
	}

	async _exec(req, res, validate) {
		const user = await Model.getCoreModel(UserSchemaModel).add(req.body, {
			_appId: Model.getCoreModel(AppSchemaModel).createId(req.authApp.id),
		});

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
	constructor(services) {
		super('user/:id', 'UPDATE USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const { validation, body } = Model.getCoreModel(UserSchemaModel).validateUpdate(req.body);
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

			Model.getCoreModel(UserSchemaModel).exists(req.params.id)
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
		return Model.getCoreModel(UserSchemaModel).updateByPath(req.body, req.params.id);
	}
}
routes.push(UpdateUser);

/**
 * @class SetUserPolicyProperties
 */
class SetUserPolicyProperties extends Route {
	constructor(services) {
		super('user/:id/policy-property/:tokenId', 'SET USER POLICY PROPERTY', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		const app = req.authApp;
		if (!app) {
			this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const userId = Model.getCoreModel(UserSchemaModel).createId(req.params.id);
		const exists = await Model.getCoreModel(UserSchemaModel).exists(userId);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const tokenQuery = getTokenQueryfromParams(req, userId);
		if (!tokenQuery) {
			this.log('ERROR: Invalid Token ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_token_param`));
		}

		const userToken = await Model.getCoreModel(TokenSchemaModel).findOne(tokenQuery);
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
		await Model.getCoreModel(TokenSchemaModel).setPolicyPropertiesById(validate.id.toString(), req.body);

		// this._nrp?.emit('worker:socket:evaluateUserRooms', JSON.stringify({
		// 	userId: req.params.id,
		// 	appId: req.authApp.id,
		// }));

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
	constructor(services) {
		super('user/:id/update-policy-property/:tokenId', 'UPDATE USER POLICY PROPERTY', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		const app = req.authApp;
		if (!app) {
			this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const userId = Model.getCoreModel(UserSchemaModel).createId(req.params.id);
		const exists = Model.getCoreModel(UserSchemaModel).exists(userId);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const tokenQuery = getTokenQueryfromParams(req, userId);
		if (!tokenQuery) {
			this.log('ERROR: Invalid Token ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_token_param`));
		}

		const userToken = await Model.getCoreModel(TokenSchemaModel).findOne(tokenQuery);
		if (!userToken) {
			this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_token_not_found`));
		}
		const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
		if (!policyCheck.passed) {
			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
		}

		return Promise.resolve(userToken);
	}

	async _exec(req, res, validate) {
		await Model.getCoreModel(TokenSchemaModel).updatePolicyProperties(validate, req.body);

		// this._nrp?.emit('worker:socket:evaluateUserRooms', JSON.stringify({
		// 	userId: req.params.id,
		// 	appId: req.authApp.id,
		// }));

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
	constructor(services) {
		super('user/:id/remove-policy-property/:tokenId', 'REMOVE USER POLICY PROPERTY', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const userId = Model.getCoreModel(UserSchemaModel).createId(req.params.id);
		const exists = Model.getCoreModel(UserSchemaModel).exists(userId);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const tokenQuery = getTokenQueryfromParams(req, userId);
		if (!tokenQuery) {
			this.log('ERROR: Invalid Token ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_token_param`));
		}

		const userToken = await Model.getCoreModel(TokenSchemaModel).findOne(tokenQuery);
		if (!userToken) {
			this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_not_found`));
		}

		return Promise.resolve(userToken);
	}

	async _exec(req, res, validate) {
		const reqPolicyProps = req.body;
		const policyProps = validate.policyProperties;
		Object.keys(reqPolicyProps).forEach((key) => {
			if (policyProps[key] && policyProps[key] === reqPolicyProps[key]) {
				delete policyProps[key];
			}
		});
		await Model.getCoreModel(TokenSchemaModel).updatePolicyProperties(validate, policyProps);

		this._nrp?.emit('worker:socket:evaluateUserRooms', JSON.stringify({
			userId: req.params.id,
			appId: req.authApp.id,
		}));

		return true;
	}
}
routes.push(RemoveUserPolicyProperties);

/**
 * @class ClearUserPolicyProperties
 */
class ClearUserPolicyProperties extends Route {
	constructor(services) {
		super('user/:id/clear-policy-property/:tokenId', 'CLEAR USER POLICY PROPERTY', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const userId = Model.getCoreModel(UserSchemaModel).createId(req.params.id);
		const exists = Model.getCoreModel(UserSchemaModel).exists(userId);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const tokenQuery = getTokenQueryfromParams(req, userId);
		if (!tokenQuery) {
			this.log('ERROR: Invalid Token ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_token_param`));
		}

		const userToken = await Model.getCoreModel(TokenSchemaModel).findOne(tokenQuery);
		if (!userToken) {
			this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `user_not_found`));
		}

		return Promise.resolve(userToken);
	}

	async _exec(req, res, validate) {
		await Model.getCoreModel(TokenSchemaModel).clearPolicyPropertiesById(validate.id);

		this._nrp?.emit('worker:socket:evaluateUserRooms', JSON.stringify({
			userId: req.params.id,
			appId: req.authApp.id,
		}));

		return true;
	}
}
routes.push(ClearUserPolicyProperties);

/**
 * @class DeleteAllUsers
 */
class DeleteAllUsers extends Route {
	constructor(services) {
		super('user', 'DELETE ALL USERS', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.DELETE;
	}

	async _validate(req, res, token) {
		return;
	}

	async _exec(req, res, validate) {
		await Model.getCoreModel(UserSchemaModel).rmAll({ _appId: req.authApp.id });
		return true;
	}
}
routes.push(DeleteAllUsers);

/**
 * @class DeleteUser
 */
class DeleteUser extends Route {
	constructor(services) {
		super('user/:id', 'DELETE USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.DELETE;
	}

	async _validate(req, res, token) {
		if (!req.params.id) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const user = await Model.getCoreModel(UserSchemaModel).findById(req.params.id);
		if (!user) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const userToken = await Model.getCoreModel(TokenSchemaModel).findOne({ _userId: user.id });
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
		await Model.getCoreModel(UserSchemaModel).rm(validate.user.id);

		if (validate.token) {
			await Model.getCoreModel(TokenSchemaModel).rm(validate.token.id);
		}

		return true;
	}
}
routes.push(DeleteUser);

/**
 * @class clearUserLocalData
 */
class clearUserLocalData extends Route {
	constructor(services) {
		super('user/:id/clear-local-data', 'CLEAR USER LOCAL DATA', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			Model.getCoreModel(UserSchemaModel).findById(req.params.id)
				.then((user) => {
					if (user) {
						return resolve(user);
					}

					this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				});
		});
	}

	async _exec(req, res, user) {
		this._nrp?.emit('clearUserLocalData', JSON.stringify({
			appAPIPath: req.authApp ? req.authApp.apiPath : '',
			userId: user.id,
			collections: (req.body.collections) ? req.body.collections : false,
		}));

		return true;
	}
}
routes.push(clearUserLocalData);

/**
 * @class SearchUserList
 */
class SearchUserList extends Route {
	constructor(services) {
		super('user', 'SEARCH USER LIST', services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	async _validate(req, res, token) {
		const result: {
			query: any;
			skip: number;
			limit: number;
			sort: any;
			project: any
		} = {
			query: {
				$and: [],
			},
			skip: (req.body && req.body.skip) ? parseInt(req.body.skip) : 0,
			limit: (req.body && req.body.limit) ? parseInt(req.body.limit) : 0,
			sort: (req.body && req.body.sort) ? req.body.sort : {},
			project: (req.body && req.body.project) ? req.body.project : false,
		};

		if (isNaN(result.skip)) throw new Helpers.Errors.RequestError(400, `invalid_value_skip`);
		if (isNaN(result.limit)) throw new Helpers.Errors.RequestError(400, `invalid_value_limit`);

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = Model.getCoreModel(UserSchemaModel).parseQuery(result.query, {}, Model.getCoreModel(UserSchemaModel).flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.getCoreModel(UserSchemaModel).find(validate.query, {},
			validate.limit, validate.skip, validate.sort, validate.project);
	}
}
routes.push(SearchUserList);

/**
 * @class UserCount
 */
class UserCount extends Route {
	constructor(services) {
		super(`user/count`, `COUNT USERS`, services, Model.getCoreModel(UserSchemaModel).schemaData);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.LAMBDA;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT USERS`;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		const result = {
			query: {},
		};

		let query: any = {};

		if (!query.$and) {
			query.$and = [];
		}

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			query.$and.push(req.body.query);
		} else if (req.body && !req.body.query) {
			query.$and.push(req.body);
		}

		query = Model.getCoreModel(UserSchemaModel).parseQuery(query, {}, Model.getCoreModel(UserSchemaModel).flatSchemaData);
		result.query = query;
		return result;
	}

	async _exec(req, res, validateResult) {
		return Model.getCoreModel(UserSchemaModel).count(validateResult.query)
	}
}
routes.push(UserCount);

/**
 * @type {*[]}
 */
export default routes;
