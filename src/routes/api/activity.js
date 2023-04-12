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
const Helpers = require('../../helpers');
// const Logging = require('../../logging');

const routes = [];

/**
 * @class GetActivityList
 */
class GetActivityList extends Route {
	constructor() {
		super('activity', 'GET ACTIVITY LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.Activity.findAll(req.authApp._id, req.token);
	}
}
routes.push(GetActivityList);

/**
 * @class GetActivity
 */
class GetActivity extends Route {
	constructor() {
		super('activity/:id', 'GET ACTIVITY');
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;

		this._activity = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log('ERROR: Missing required field', Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `missing_required_fields`));
			}
			Model.Activity.findById(req.params.id).then((activity) => {
				if (!activity) {
					this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}
				this._activity = activity;
				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return Promise.resolve(this._activity.details);
	}
}
routes.push(GetActivity);

/**
 * @class DeleteAllActivity
 */
class DeleteAllActivity extends Route {
	constructor() {
		super('activity', 'DELETE ALL ACTIVITY');
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.DELETE;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.Activity.rmAll().then(() => true);
	}
}
routes.push(DeleteAllActivity);

/**
 * @class AddActivityMetadata
 */
class AddActivityMetadata extends Route {
	constructor() {
		super('activity/:id/metadata/:key', 'ADD ACTIVITY METADATA');
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.ADD;

		this._activity = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			Model.Activity.findById(req.params.id).then((activity) => {
				if (!activity) {
					this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}

				try {
					JSON.parse(req.body.value);
				} catch (e) {
					this.log(`ERROR: ${e.message}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, 'invalid_json'));
				}

				this._activity = activity;
				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return this._activity.addOrUpdateMetadata(req.params.key, req.body.value);
	}
}
routes.push(AddActivityMetadata);

/**
 * @class UpdateActivityMetadata
 */
class UpdateActivityMetadata extends Route {
	constructor() {
		super('activity/:id/metadata/:key', 'UPDATE ACTIVITY METADATA');
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.ADD;

		this._activity = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			Model.Activity.findById(req.params.id).then((activity) => {
				if (!activity) {
					this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}
				if (activity.findMetadata(req.params.key) === false) {
					this.log('ERROR: Metadata does not exist', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(404, `metadata_not_found`));
				}
				try {
					JSON.parse(req.body.value);
				} catch (e) {
					this.log(`ERROR: ${e.message}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(500, 'invalid_json'));
				}

				this._activity = activity;
				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return this._activity.addOrUpdateMetadata(req.params.key, req.body.value);
	}
}
routes.push(UpdateActivityMetadata);

/**
 * @class GetActivityMetadata
 */
class GetActivityMetadata extends Route {
	constructor() {
		super('activity/:id/metadata/:key', 'GET ACTIVITY METADATA');
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.GET;

		this._metadata = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			Model.Activity.findById(req.params.id).then((activity) => {
				if (!activity) {
					this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}

				this._metadata = activity.findMetadata(req.params.key);
				if (this._metadata === false) {
					this.log('WARN: Activity Metadata Not Found', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(404, `metadata_not_found`));
				}

				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return this._metadata.value;
	}
}
routes.push(GetActivityMetadata);

/**
 * @class DeleteActivityMetadata
 */
class DeleteActivityMetadata extends Route {
	constructor() {
		super('activity/:id/metadata/:key', 'DELETE ACTIVITY METADATA');
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;
		this._activity = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			Model.Activity
				.findById(req.params.id).select('id')
				.then((activity) => {
					if (!activity) {
						this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					this._activity = activity;
					resolve(true);
				}, (err) => reject(new Helpers.Errors.RequestError(400, err.message)));
		});
	}

	_exec(req, res, validate) {
		return this._activity.rmMetadata(req.params.key);
	}
}
routes.push(DeleteActivityMetadata);

/**
 * @type {*[]}
 */
module.exports = routes;
