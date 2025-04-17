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
import * as Helpers from '../../helpers/index.js';

import * as ACM from '../../access-control/models-access.js';
import { Token } from '../../model/core/token.js';

import { QueryParams } from '../../types/bjs-query.js';

const routes: (typeof Route)[] = [];

/**
 * @class GetTokenList
 */
class GetTokenList extends Route {
	constructor(services) {
		super('token', 'LIST TOKEN', services, Model.getModel('Token'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.LIST;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		const queryParams: QueryParams<Token> = {
			query: {
				_appId: Model.getModel('App').createId(req.authApp.id)
			},
			project: {
				id: 1,
				type: 1,
				policyProperties: 1
			}
		};

		if (req.token && req.token.type === Model.getModel('Token').Constants.Type.SYSTEM) {
			queryParams.query = {};
			queryParams.project = {};
		}

		return Promise.resolve(queryParams);
	}

	async _exec(req, res, validate) {
		return ACM.find(this.model, validate, req.ac);
	}
}
routes.push(GetTokenList);

/**
 * @class GetTokenList
 */
class SearchTokenList extends Route {
	constructor(services) {
		super('token', 'SEARCH TOKEN', services, Model.getModel('Token'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.redactResults = false;
	}

	async _validate(req, res, token) {
		const queryParams: QueryParams<Token> = {
			query: {
				$and: [{_appId: Model.getModel('App').createId(req.authApp.id)}]
			},
			project: {
				id: 1,
				type: 1,
				policyProperties: 1
			}
		};

		if (req.token && req.token.type === Model.getModel('Token').Constants.Type.SYSTEM) {
			queryParams.query = {};
			queryParams.project = {};
		}

		if (!queryParams.query.$and) {
			queryParams.query.$and = [];
		}

		if (req.body.query) {
			queryParams.query.$and.push(req.body.query);
		}

		return queryParams;
	}

	_exec(req, res, validate) {
		return ACM.find(this.model, validate, req.ac);
	}
}
routes.push(SearchTokenList);

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

	async _exec(req, res, validate) {
		if (req.params.type === Model.getModel('Token').Constants.Type.SYSTEM) {
			this.log('ERROR: Cannot delete system tokens', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_param_type`));
		}

		if (req.token && req.token.type === Model.getModel('Token').Constants.Type.SYSTEM) {
			const query = (req.params.type) ? {
				type: req.params.type
			} : {
				type: {
					$ne: Model.getModel('Token').Constants.Type.SYSTEM
				}
			};
			await this.model.rmAll(query);
		} else {
			if (req.params.type === Model.getModel('Token').Constants.Type.APP){
				this.log('ERROR: Cannot delete app tokens as app', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_param_type`));
			}

			const query = (req.params.type) ? {
				type: req.params.type
			} : {
				type: {
					$ne: Model.getModel('Token').Constants.Type.APP
				}
			};

			await this.model.rmAll({
				...query,
				_appId: Model.getModel('App').createId(req.authApp.id),
			});
		}

		return true;
	}
}
routes.push(DeleteAllTokens);

/**
 * @class SearchUserToken
 */
class SearchUserToken extends Route {
	constructor(services) {
		super('token/:userId', 'SEARCH USER TOKEN', services, Model.getModel('Token'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.redactResults = false;
	}

	async _validate(req, res, token) {
		const queryParams: QueryParams<Token> = {
			query: {
				$and: [{_appId: Model.getModel('App').createId(req.authApp.id)}]
			},
			project: {
				id: 1,
				type: 1,
				policyProperties: 1
			}
		};

		if (req.token && req.token.type === Model.getModel('Token').Constants.Type.SYSTEM) {
			queryParams.query = {};
			queryParams.project = {};
		}

		const exists = Model.getModel('User').exists(req.params.userId);
		if (!exists) {
			this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_param_id`));
		}

		if (!queryParams.query.$and) {
			queryParams.query.$and = [];
		}
		
		queryParams.query.$and.push({
			_userId: req.params.userId,
		});

		if (req.body.query) {
			queryParams.query.$and.push(req.body.query);
		}

		return queryParams;
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
