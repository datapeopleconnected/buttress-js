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
 * @class GetAttributeList
 */
class GetAttributeList extends Route {
	constructor() {
		super('attributes', 'GET ATTRIBUTE LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		const ids = req.body.ids;
		if (ids && ids.length > 0) {
			ids.forEach((id) => {
				try {
					Datastore.getInstance().ID.new(id);
				} catch (err) {
					this.log(`ATTRIBUTE: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
					return Promise.reject(new Helpers.RequestError(400, 'invalid_id'));
				}
			});
		}

		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		const ids = req.body.ids;
		if (ids && ids.length > 0) {
			return Model.Attributes.findByIds(ids);
		}

		return Model.Attributes.findAll(req.authApp._id, req.token.authLevel);
	}
}
routes.push(GetAttributeList);

/**
 * @class AddAttribute
 */
class AddAttribute extends Route {
	constructor() {
		super('attribute', 'ADD ATTRIBUTE');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const app = req.authApp;

			if (!app ||
				!req.body.attribute.name) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return reject(new Helpers.RequestError(400, `missing_field`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.Attributes.add({attribute: req.body.attribute, appId: req.authApp._id})
			.then((attribute) => {
				return attribute;
			});
	}
}
routes.push(AddAttribute);


/**
 * @class DeleteApp
 */
class DeleteApp extends Route {
	constructor() {
		super('attribute/:id', 'DELETE ATTRIBUTE');
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.WRITE;
		this._attribute = false;
	}

	_validate(req) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log('ERROR: Missing required field', Route.LogLevel.ERR);
				return reject(new Helpers.RequestError(400, `missing_field`));
			}
			Model.Attributes.findById(req.params.id).then((attribute) => {
				if (!attribute) {
					this.log('ERROR: Invalid Attribute ID', Route.LogLevel.ERR);
					return reject(new Helpers.RequestError(400, `invalid_id`));
				}
				this._attribute = attribute;
				resolve(true);
			});
		});
	}

	_exec() {
		return new Promise((resolve, reject) => {
			Model.Attributes.rm(this._attribute).then(() => true).then(resolve, reject);
		});
	}
}
routes.push(DeleteApp);

/**
 * @type {*[]}
 */
module.exports = routes;
