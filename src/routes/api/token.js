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
// const Helpers = require('../../helpers');

const routes = [];

/**
 * @class GetTokenList
 */
class GetTokenList extends Route {
	constructor() {
		super('token', 'GET TOKEN LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.SYSTEM;
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

		return tokens.filter((t) => t.type !== Model.Token.Constants.Type.SYSTEM);
	}
}
routes.push(GetTokenList);

/**
 * @class DeleteAllTokens
 */
class DeleteAllTokens extends Route {
	constructor() {
		super('token/:type?', 'DELETE ALL TOKENS');
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.SUPER;
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
 * @class SearchUserToken
 */
class SearchUserToken extends Route {
	constructor() {
		super('token', 'SEARCH USER TOKEN');
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.SUPER;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		const result = {
			query: {
				$and: [],
			},
		};

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = Model.Token.parseQuery(result.query, {}, Model.Token.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.Token.find(validate.query);
	}
}
routes.push(SearchUserToken);

/**
 * @type {*[]}
 */
module.exports = routes;
