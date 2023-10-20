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

const routes = [];

/**
 * @class GetTrackingList
 */
class GetTrackingList extends Route {
	constructor(nrp) {
		super('tracking', 'GET TRACKING LIST', nrp, Model.Tracking);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return this.model.getAll();
	}
}
routes.push(GetTrackingList);

/**
 * @class AddTracking
 */
class AddTracking extends Route {
	constructor(nrp) {
		super('tracking', 'ADD TRACKING', nrp, Model.Tracking);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.ADD;

		this.activity = false;
		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const validation = this.model.validate(req.body);
			if (!validation.isValid) {
				if (validation.missing.length > 0) {
					this.log(`ERROR: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `TRACKING: Missing field: ${validation.missing[0]}`));
				}
				if (validation.invalid.length > 0) {
					this.log(`ERROR: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `TRACKING: Invalid value: ${validation.invalid[0]}`));
				}

				this.log(`ERROR: TRACKING: Unhandled Error`, Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `unknown_error`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return this.model.add(req.body);
	}
}
routes.push(AddTracking);

class UpdateTracking extends Route {
	constructor(nrp) {
		super('tracking/:id', 'UPDATE TRACKING', nrp, Model.Tracking);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activity = false;
		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate() {
		return new Promise((resolve, reject) => {
			const {validation, body} = this.model.validateUpdate(this.req.body);
			this.req.body = body;
			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `TRACKING: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `TRACKING: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			this.model.exists(this.req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid Tracking ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});
		});
	}

	_exec() {
		return this.model.updateByPath(this.req.body, this.req.params.id);
	}
}
routes.push(UpdateTracking);

/**
 * @class DeleteTracking
 */
class DeleteTracking extends Route {
	constructor(nrp) {
		super('tracking/:id', 'DELETE TRACKING', nrp, Model.Tracking);
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;
		this._tracking = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			this.model.findById(req.params.id)
				.then((tracking) => {
					if (!tracking) {
						this.log('ERROR: Invalid Tracking ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					this._tracking = tracking;
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return this._tracking.rm().then(() => true);
	}
}
routes.push(DeleteTracking);

/**
 * @class DeleteAllTrackings
 */
class DeleteAllTrackings extends Route {
	constructor(nrp) {
		super('tracking', 'DELETE ALL TRACKINGS', nrp, Model.Tracking);
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return this.model.rmAll().then(() => true);
	}
}
routes.push(DeleteAllTrackings);

/**
 * @type {*[]}
 */
module.exports = routes;
