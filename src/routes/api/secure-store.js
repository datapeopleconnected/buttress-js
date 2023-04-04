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

const ObjectId = require('mongodb').ObjectId;

const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
// const Logging = require('../../logging');

const routes = [];

/**
 * @class AddSecureStore
 */
class AddSecureStore extends Route {
	constructor() {
		super('secureStore', 'ADD SECURE STORE');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		const app = req.authApp;

		if (!app || !req.body.name) {
			this.log(`[${this.name}] Missing required secure store field`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const secureStoreExist = await Model.SecureStore.findOne({
			name: req.body.name,
			_appId: Model.App.createId(req.authApp._id),
		});
		if (secureStoreExist) {
			this.log('ERROR: Secure Store with this name already exists', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `already_exist`));
		}

		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.SecureStore.add(req, req.body);
	}
}
routes.push(AddSecureStore);

/**
 * @class AddManySecureStore
 */
class AddManySecureStore extends Route {
	constructor() {
		super('secureStore/bulk/add', 'ADD SECURE STORE');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		const app = req.authApp;

		if (!app) {
			this.log(`[${this.name}] Missing required secure store field`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		if (!Array.isArray(req.body)) {
			this.log(`[${this.name}] Invalid request body`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_body`));
		}

		const missingField = req.body.find((ss) => !ss.name);
		if (missingField) {
			this.log(`[${this.name}] Missing required secure store field`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		for await (const secureStore of req.body) {
			const secureStoreExist = await Model.SecureStore.findOne({name: secureStore.name});
			if (secureStoreExist) {
				this.log(`ERROR: Secure Store with this name ${secureStore.name} already exists`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `already_exist`));
			}
		}

		return Promise.resolve(true);
	}

	async _exec(req, res, validate) {
		for await (const secureStore of req.body) {
			await Model.SecureStore.add(req, secureStore);
		}

		return true;
	}
}
routes.push(AddManySecureStore);

/**
 * @class GetSecureStore
 */
class GetSecureStore extends Route {
	constructor() {
		super('secureStore/:id', 'GET SECURE STORE');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const id = req.params.id;
		if (!id) {
			this.log(`[${this.name}] Missing required secure store id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_secure_store_id`));
		}
		if (!ObjectId.isValid(id)) {
			this.log(`[${this.name}] Invalid secure store id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_secure_store_id`));
		}

		const secureStore = await Model.SecureStore.findById(id);
		if (!secureStore) {
			this.log(`[${this.name}] Cannot find a secure store with id ${id}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `secure_store_does_not_exist`));
		}

		return secureStore;
	}

	_exec(req, res, validate) {
		return validate;
	}
}
routes.push(GetSecureStore);

/**
 * @class FindSecureStore
 */
class FindSecureStore extends Route {
	constructor() {
		super('secureStore/name/:name', 'FIND SECURE STORE BY NAME');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const name = req.params.name;
		if (!name) {
			this.log(`[${this.name}] Missing request parameter`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const secureStore = await Model.SecureStore.findOne({
			name: {
				$eq: name,
			},
		});

		if (!secureStore) return Promise.reject(new Helpers.Errors.RequestError(404, `Not Found`));

		return Promise.resolve(secureStore);
	}

	_exec(req, res, validate) {
		return validate;
	}
}
routes.push(FindSecureStore);

/**
 * @class UpdateSecureStore
 */
class UpdateSecureStore extends Route {
	constructor() {
		super('secureStore/:id', 'UPDATE SECURE STORE');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const validation = Model.SecureStore.validateUpdate(req.body);
		if (!validation.isValid) {
			if (validation.isPathValid === false) {
				this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `ERROR: Update path is invalid: ${validation.invalidPath}`));
			}
			if (validation.isValueValid === false) {
				this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `ERROR: Update value is invalid: ${validation.invalidValue}`));
			}
		}

		const exists = await Model.SecureStore.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid Secure Store ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}
		return true;
	}

	_exec(req, res, validate) {
		return Model.SecureStore.updateByPath(req.body, req.params.id, 'SecureStore');
	}
}
routes.push(UpdateSecureStore);

/**
 * @class BulkUpdateSecureStore
 */
class BulkUpdateSecureStore extends Route {
	constructor() {
		super('secureStore/bulk/update', 'BULK UPDATE SECURE STORE');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req, res, token) {
		for await (const item of req.body) {
			const validation = Model.SecureStore.validateUpdate(item.body);
			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `ERROR: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `ERROR: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			const exists = await Model.SecureStore.exists(item.id);
			if (!exists) {
				this.log('ERROR: Invalid Secure Store ID', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
			}
		}

		return req.body;
	}

	async _exec(req, res, validate) {
		for await (const item of validate) {
			await Model.SecureStore.updateByPath(item.body, item.id, 'SecureStore');
		}
		return true;
	}
}
routes.push(BulkUpdateSecureStore);

/**
 * @class SearchSecureStoreList
 */
class SearchSecureStoreList extends Route {
	constructor() {
		super('secureStore', 'SEARCH SECURE STORE LIST');
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

		result.query = Model.SecureStore.parseQuery(result.query, {}, Model.SecureStore.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.SecureStore.find(validate.query, {},
			validate.limit, validate.skip, validate.sort, validate.project);
	}
}
routes.push(SearchSecureStoreList);

/**
 * @class DeleteSecureStore
 */
class DeleteSecureStore extends Route {
	constructor() {
		super('secureStore/:id', 'DELETE SECURE STORE');
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req) {
		if (!req.params.id) {
			this.log('ERROR: Missing required secure store ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_secure_store_id`));
		}

		const secureStore = await Model.SecureStore.findById(req.params.id);
		if (!secureStore) {
			this.log('ERROR: Invalid Secure Store ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_secure_store_id`));
		}

		return secureStore;
	}

	async _exec(req, res, secureStore) {
		await Model.SecureStore.rm(secureStore);
		return true;
	}
}
routes.push(DeleteSecureStore);

/**
 * @class SecureStoreCount
 */
class SecureStoreCount extends Route {
	constructor() {
		super(`secureStore/count`, `COUNT SECURE STORES`);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT SECURE STORES`;
		this.activityBroadcast = false;

		this.model = Model.SecureStore;
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
		return Model.SecureStore.count(validateResult.query);
	}
}
routes.push(SecureStoreCount);

/**
 * @type {*[]}
 */
module.exports = routes;
