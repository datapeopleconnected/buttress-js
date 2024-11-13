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

import Route from '../route';
import Model from '../../model';

import * as ACM from '../../access-control/models-access';

const routes: (typeof Route)[] = [];

/**
 * @class GetTokenList
 */
class GetTokenList extends Route {
	constructor(services) {
		super('token', 'GET TOKEN LIST', services, Model.getModel('Token'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.LIST;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	async _exec(req, res, validate) {
		if (req.token && req.token.type === Model.getModel('Token').Constants.Type.SYSTEM) {
			return this.model.findAll();
		}

		return this.model.find({
			_appId: Model.getModel('App').createId(req.authApp.id),
		});
	}
}
routes.push(GetTokenList);

/**
 * @class DeleteAllTokens
 */
class DeleteAllTokens extends Route {
	constructor(services) {
		super('token/:type?', 'DELETE ALL TOKENS', services, Model.getModel('Token'));
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return Promise.resolve();
	}

	_exec(req, res, validate) {
		if (req.token && req.token.type === Model.getModel('Token').Constants.Type.SYSTEM) {
			return this.model.rmAll({
				type: req.params.type,
			}).then(() => true);
		}

		return this.model.rmAll({
			type: req.params.type,
			_appId: Model.getModel('App').createId(req.authApp.id),
		}).then(() => true);
	}
}
routes.push(DeleteAllTokens);

/**
 * @class SearchUserToken
 */
class SearchUserToken extends Route {
	constructor(services) {
		super('token', 'SEARCH USER TOKEN', services, Model.getModel('Token'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.redactResults = false;
	}

	async _validate(req, res, token) {
		const result: {
			query: {
				$and: any[],
			},
		} = {
			query: {
				$and: [],
			},
		};

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = this.model.parseQuery(result.query, {}, this.model.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return ACM.find(this.model, validate, req.ac);
	}
}
routes.push(SearchUserToken);

/**
 * @type {*[]}
 */
export default routes;
