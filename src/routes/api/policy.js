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
				!req.body.policy.selection ||
				!req.body.policy.attributes ||
				(req.body.policy.attributes && req.body.policy.attributes.length < 1)) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.RequestError(400, `missing_field`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.Policy.add({policy: req.body.policy, appId: req.authApp._id})
			.then((policy) => {
				return policy;
			});
	}
}
routes.push(AddPolicy);


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
					this.log('ERROR: Invalid Attribute ID', Route.LogLevel.ERR);
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
