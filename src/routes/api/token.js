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

const Route = require('../route');
const Model = require('../../model');
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

	async _exec(req, res, validate) {
		const rxsToken = Model.Token.findAll();
		const tokens = [];
		for await (const token of rxsToken) {
			tokens.push(token);
		}

		return tokens.filter((t) => t.authLevel < 3);
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

		// Fetch model
		this.model = Model['token'];

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.body) {
				this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}
			if (!req.body.token) {
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
		return Model.Token.updateRole(this.model.createId(req.body.token), req.body.role)
			.then((res) => true);
	}
}
routes.push(UpdateTokenRoles);

/**
 * @class UpdateTokenAttributes
 */
class UpdateTokenAttributes extends Route {
	constructor() {
		super('token/attributes', 'UPDATE TOKEN ATTRIBUTES');
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
			if (!req.body.tokenId) {
				this.log('ERROR: token is missing', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_token`));
			}
			if (!req.body.attributes) {
				this.log('ERROR: attributes is a required field', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_attributes`));
			}

			// TODO: Fetch the app attributes and vaildate that its a valid app attribute
			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.Token.updateAttributes(req.body.tokenId, req.body.attributes)
			.then(() => true);
	}
}
routes.push(UpdateTokenAttributes);

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
