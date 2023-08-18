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
const ObjectId = require('mongodb').ObjectId;

// const AccessControl = require('../../access-control');
const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');

const routes = [];

const Datastore = require('../../datastore');

/**
 * @class GetPolicy
 */
class GetPolicy extends Route {
	constructor(nrp, redisClient) {
		super('policy/:id', 'GET POLICY', nrp, redisClient);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const id = req.params.id;
		if (!id) {
			this.log(`[${this.name}] Missing required policy id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_policy_id`));
		}
		if (!ObjectId.isValid(id)) {
			this.log(`[${this.name}] Invalid policy id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_id`));
		}

		const policy = await Model.Policy.findById(id);
		if (!policy) {
			this.log(`[${this.name}] Cannot find a policy with id id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `policy_does_not_exist`));
		}

		return policy;
	}

	_exec(req, res, policy) {
		return policy;
	}
}
routes.push(GetPolicy);

/**
 * @class GetPolicyList
 */
class GetPolicyList extends Route {
	constructor(nrp) {
		super('policy', 'GET POLICY LIST', nrp);
		this.verb = Route.Constants.Verbs.GET;
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

		return Model.Policy.findAll(req.authApp.id, req.token);
	}
}
routes.push(GetPolicyList);

/**
 * @class SearchPolicyList
 */
class SearchPolicyList extends Route {
	constructor(nrp) {
		super('policy', 'SEARCH POLICY LIST', nrp);
		this.verb = Route.Constants.Verbs.SEARCH;
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
	constructor(nrp) {
		super('policy', 'ADD POLICY', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		const app = req.authApp;
		try {
			if (!app ||
				!req.body.selection ||
				!req.body.name ||
				!req.body.config ||
				req.body.config.length < 1) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			const policyExist = await Model.Policy.findOne({
				name: {
					$eq: req.body.name,
				},
				_appId: Model.App.createId(app.id),
			});
			if (policyExist) {
				this.log(`[${this.name}] Policy with name ${req.body.name} already exists`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `policy_with_name_already_exists`));
			}

			const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body.selection);
			if (!policyCheck.passed) {
				this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_selection`));
			}

			return Promise.resolve(true);
		} catch (err) {
			return Promise.reject(err);
		}
	}

	_exec(req, res, validate) {
		return Model.Policy.add(req.body, req.authApp.id)
			.then((policy) => {
				this._nrp.emit('app-policy:bust-cache', {
					appId: req.authApp.id,
				});
				return policy;
			});
	}
}
routes.push(AddPolicy);

/**
 * @class UpdatePolicy
 */
class UpdatePolicy extends Route {
	constructor(nrp) {
		super('policy/:id', 'UPDATE POLICY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const {validation, body} = Model.Policy.validateUpdate(req.body);
			req.body = body;
			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `POLICY: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `POLICY: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			Model.Policy.exists(req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return Model.Policy.updateByPath(req.body, req.params.id, null, 'Policy');
	}
}
routes.push(UpdatePolicy);

/**
 * @class BulkUpdatePolicy
 */
class BulkUpdatePolicy extends Route {
	constructor(nrp) {
		super('policy/bulk/update', 'UPDATE POLICY', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		for await (const item of req.body) {
			const {validation, body} = Model.Policy.validateUpdate(item.body);
			item.body = body;
			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `POLICY: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `POLICY: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			const exists = Model.Policy.exists(item.id);
			if (!exists) {
				this.log('ERROR: Invalid Policy ID', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
			}
		}

		return req.body;
	}

	async _exec(req, res, validate) {
		for await (const item of validate) {
			await Model.Policy.updateByPath(item.body, item.id, null, 'Policy');
		}
		return true;
	}
}
routes.push(BulkUpdatePolicy);

/**
 * @class SyncPolicies
 */
class SyncPolicies extends Route {
	constructor(nrp) {
		super('policy/sync', 'SYNC POLICIES', nrp);
		this.verb = Route.Constants.Verbs.POST;
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
			_appId: req.authApp.id,
		});

		for await (const policy of req.body) {
			await Model.Policy.add(policy, req.authApp.id);
		}

		this._nrp.emit('app-policy:bust-cache', {
			appId: req.authApp.id,
		});

		return true;
	}
}

/**
 * @class PolicyCount
 */
class PolicyCount extends Route {
	constructor(nrp) {
		super(`policy/count`, `COUNT POLICIES`, nrp);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT POLICIES`;
		this.activityBroadcast = false;

		this.model = Model.Policy;
	}

	_validate(req, res, token) {
		const result = {
			query: {},
		};

		let query = {};

		if (!query.$and) {
			query.$and = [];
		}

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			query.$and.push(req.body.query);
		} else if (req.body && !req.body.query) {
			query.$and.push(req.body);
		}

		query = this.model.parseQuery(query, {}, this.model.flatSchemaData);
		result.query = query;
		return result;
	}

	_exec(req, res, validateResult) {
		return Model.Policy.count(validateResult.query);
	}
}
routes.push(PolicyCount);

routes.push(SyncPolicies);


/**
 * @class DeleteTransientPolicy
 */
class DeleteTransientPolicy extends Route {
	constructor(nrp) {
		super('policy/delete-transient-policy', 'DELETE POLICY BY NAME', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	async _validate(req, res, token) {
		if (!req.body || !req.body.name) {
			this.log(`[${this.name}] Missing required policy transient name field`, Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `missing_field`);
		}

		return await Helpers.streamFirst(await Model.Policy.find({name: req.body.name}));
	}

	async _exec(req, res, validate) {
		if (!validate) return true;

		await Model.Policy.rm(validate);

		this._nrp.emit('app-policy:bust-cache', {
			appId: req.authApp.id,
		});

		// Trigger socket process to re-evaluate rooms
		this._nrp.emit('worker:socket:evaluateUserRooms', {
			appId: req.authApp.id,
		});

		return true;
	}
}
routes.push(DeleteTransientPolicy);

/**
 * @class DeletePolicy
 */
class DeletePolicy extends Route {
	constructor(nrp) {
		super('policy/:id', 'DELETE POLICY', nrp);
		this.verb = Route.Constants.Verbs.DEL;
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

	_exec(req) {
		return Model.Policy.rm(this._policy)
			.then(() => {
				this._nrp.emit('app-policy:bust-cache', {
					appId: req.authApp.id,
				});

				return true;
			});
	}
}
routes.push(DeletePolicy);

/**
 * @class DeleteAppPolicies
 */
class DeleteAppPolicies extends Route {
	constructor(nrp) {
		super('policy', 'DELETE ALL APP POLICIES', nrp);
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req) {
		const rxsPolicies = await Model.Policy.findAll(req.authApp.id, req.token);
		const policies = [];
		for await (const policy of rxsPolicies) {
			policies.push(policy);
		}

		return policies.map((p) => p.id);
	}

	_exec(req, res, validate) {
		return new Promise((resolve, reject) => {
			Model.Policy.rmBulk(validate).then(() => true).then(resolve, reject);
		});
	}
}
routes.push(DeleteAppPolicies);

/**
 * @type {*[]}
 */
module.exports = routes;
