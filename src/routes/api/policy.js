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
const Config = require('node-env-obj')();
const NRP = require('node-redis-pubsub');
const nrp = new NRP(Config.redis);

const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');

const routes = [];

const Datastore = require('../../datastore');

/**
 * @class GetPolicyList
 */
class GetPolicyList extends Route {
	constructor() {
		super('policy', 'GET POLICY LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		const ids = req.body.ids;
		if (ids && ids.length > 0) {
			ids.forEach((id) => {
				try {
					Datastore.getInstance('core').ID.new(id);
				} catch (err) {
					this.log(`POLICY: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
					return Promise.reject(new Helpers.RequestError(400, 'invalid_id'));
				}
			});
		}

		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		const ids = req.body.ids;
		if (ids && ids.length > 0) {
			return Model.Policy.findByIds(ids);
		}

		return Model.Policy.findAll(req.authApp._id, req.token.authLevel);
	}
}
routes.push(GetPolicyList);

/**
 * @class SearchPolicyList
 */
class SearchPolicyList extends Route {
	constructor() {
		super('policy', 'SEARCH POLICY LIST');
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.ADMIN;
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

		result.query = Model.Policy.parseQuery(result.query, {}, Model.Policy.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.Policy.find(validate.query, {},
			validate.limit, validate.skip, validate.sort, validate.project);
	}
}
routes.push(SearchPolicyList);

/**
 * @class AddPolicy
 */
class AddPolicy extends Route {
	constructor() {
		super('policy', 'ADD POLICY');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const app = req.authApp;

			if (!app ||
				!req.body.selection ||
				!req.body.name) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.Policy.add({policy: req.body, appId: req.authApp._id})
			.then((policy) => {
				nrp.emit('app-policy:bust-cache', {
					appId: req.authApp._id,
				});
				return policy;
			});
	}
}
routes.push(AddPolicy);

/**
 * @class SyncPolicies
 */
class SyncPolicies extends Route {
	constructor() {
		super('policy/sync', 'SYNC POLICIES');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		const app = req.authApp;

		if (!app || !req.body) {
			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `missing_field`);
		}

		if (!Array.isArray(req.body)) {
			this.log(`[${this.name}] invalid field`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `invalid_field`);
		}

		for (const policy of req.body) {
			if (!policy.selection ||
				!policy.name) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				throw new Helpers.Errors.RequestError(400, `missing_field`);
			}
		}

		return true;
	}

	async _exec(req, res, validate) {
		await Model.Policy.rmAll({
			_appId: req.authApp._id,
		});

		for await (const policy of req.body) {
			await Model.Policy.add({policy: policy, appId: req.authApp._id});
		}

		return true;
	}
}
routes.push(SyncPolicies);

/**
 * @class DeletePolicy
 */
class DeletePolicy extends Route {
	constructor() {
		super('policy/:id', 'DELETE POLICY');
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.WRITE;
		this._policy = false;
	}

	_validate(req) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log('ERROR: Missing required field', Route.LogLevel.ERR);
				return reject(new Helpers.RequestError(400, `missing_field`));
			}
			Model.Policy.findById(req.params.id).then((policy) => {
				if (!policy) {
					this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
					return reject(new Helpers.RequestError(400, `invalid_id`));
				}
				this._policy = policy;
				resolve(true);
			});
		});
	}

	_exec() {
		return new Promise((resolve, reject) => {
			Model.Policy.rm(this._policy).then(() => true).then(resolve, reject);
		});
	}
}
routes.push(DeletePolicy);

/**
 * @type {*[]}
 */
module.exports = routes;
