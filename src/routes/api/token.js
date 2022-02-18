'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file token.js
 * @description TOKEN API specification
 * @module API
 * @author Chris Bates-Keegan
 *
 */

const Route = require('../route');
const Model = require('../../model');
const ObjectId = require('mongodb').ObjectId;
// var Logging = require('../../logging');
const Helpers = require('../../helpers');

const routes = [];

/**
 * @class GetTokenList
 */
class GetTokenList extends Route {
	constructor() {
		super('token', 'GET TOKEN LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.LIST;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.Token.getAll()
			.then((tokens) => tokens.map((t) => t.details));
	}
}
routes.push(GetTokenList);

/**
 * @class UpdateTokenRoles
 */
class UpdateTokenRoles extends Route {
	constructor() {
		super('token/roles', 'UPDATE TOKEN ROLES');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.body) {
				this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}
			if (!req.body.token || !ObjectId.isValid(req.body.token)) {
				this.log('ERROR: token is missing', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_token`));
			}
			if (!req.body.role) {
				this.log('ERROR: role is a required field', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_role`));
			}

			// TODO: Fetch the app roles and vaildate that its a valid app role
			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.Token.updateRole(new ObjectId(req.body.token), req.body.role)
			.then((res) => true);
	}
}
routes.push(UpdateTokenRoles);

/**
 * @class DeleteAllTokens
 */
class DeleteAllTokens extends Route {
	constructor() {
		super('token/:type?', 'DELETE ALL TOKENS');
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return Promise.resolve();
	}

	_exec(req, res, validate) {
		return Model.Token.rmAll({
			type: req.params.type,
		}).then(() => true);
	}
}
routes.push(DeleteAllTokens);

/**
 * @type {*[]}
 */
module.exports = routes;
