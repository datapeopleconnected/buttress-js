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

const Buttress = require('@buttress/api');
const Sugar = require('sugar');

const Route = require('../route');
const Model = require('../../model');
const Logging = require('../../logging');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

const routes = [];

/**
 * @class GetAppList
 */
class GetAppList extends Route {
	constructor() {
		super('app', 'GET APP LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		return Model.App.findAll();
	}
}
routes.push(GetAppList);

/**
 * @class GetApp
 */
class GetApp extends Route {
	constructor() {
		super('app/:id([0-9|a-f|A-F]{24})', 'GET APP');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.READ;

		this._app = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log('ERROR: Missing required field', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_fields`));
			}
			Model.App.findById(req.params.id).populate('_token').then((app) => {
				if (!app) {
					this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}
				// this.log(app._token, Route.LogLevel.DEBUG);
				this._app = app;
				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return new Promise((resolve, reject) => {
			resolve(this._app.details);
		});
	}
}
routes.push(GetApp);

/**
 * @class AddApp
 */
class AddApp extends Route {
	constructor() {
		super('app', 'APP ADD');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.ADD;

		// Fetch model
		this.schema = new Schema(Model.App.schemaData);
		this.model = Model.App;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const validation = this.model.validate(req.body);
			if (!validation.isValid) {
				if (validation.missing.length > 0) {
					this.log(`${this.schema.name}: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
				}
				if (validation.invalid.length > 0) {
					this.log(`${this.schema.name}: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
				}

				this.log(`${this.schema.name}: Unhandled Error`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Unhandled error.`));
			}

			if (!req.body.permissions || req.body.permissions.length === 0) {
				switch (Number(req.body.authLevel)) {
				default:
					req.body.permissions = JSON.stringify([]);
					break;
				case Model.Token.Constants.AuthLevel.SUPER: {
					const permissions = [
						{route: '*', permission: '*'},
					];
					req.body.permissions = JSON.stringify(permissions);
				} break;
				case Model.Token.Constants.AuthLevel.ADMIN: {
					const permissions = [
						{route: '*', permission: '*'},
					];

					req.body.permissions = JSON.stringify(permissions);
				} break;
				}
			}

			try {
				req.body.permissions = JSON.parse(req.body.permissions);
			} catch (e) {
				this.log('ERROR: Badly formed JSON in permissions', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_json`));
			}

			this.model.isDuplicate(req.body)
				.then((res) => {
					if (res === true) {
						this.log(`${this.schema.name}: Duplicate entity`, Route.LogLevel.ERR, req.id);
						return reject(new Helpers.Errors.RequestError(400, `duplicate`));
					}
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return new Promise((resolve, reject) => {
			Model.App.add(req.body)
				.then((res) => Object.assign(res.app, {token: res.token.value}))
				.then(Logging.Promise.logProp('Added App', 'name', Route.LogLevel.INFO))
				.then(resolve, reject);
		});
	}
}
routes.push(AddApp);

/**
 * @class DeleteApp
 */
class DeleteApp extends Route {
	constructor() {
		super('app/:id', 'DELETE APP');
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.WRITE;
		this._app = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log('ERROR: Missing required field', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}
			Model.App.findById(req.params.id).then((app) => {
				if (!app) {
					this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}
				this._app = app;
				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return new Promise((resolve, reject) => {
			Model.App.rm(this._app).then(() => true).then(resolve, reject);
		});
	}
}
routes.push(DeleteApp);

/**
 * @class GetAppPermissionList
 */
class GetAppPermissionList extends Route {
	constructor() {
		super('app/:id/permission', 'GET APP PERMISSION LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.LIST;

		this._app = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.params.id) {
				this.log('ERROR: Missing required field', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}
			Model.App.findById(req.params.id).then((app) => {
				if (!app) {
					this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}
				this._app = app;
				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return new Promise((resolve, reject) => {
			resolve(this._app.permissions.map((p) => {
				return {
					route: p.route,
					permission: p.permission,
				};
			}));
		});
	}
}
routes.push(GetAppPermissionList);

/**
 * @class AddAppPermission
 */
class AddAppPermission extends Route {
	constructor() {
		super('app/:id/permission', 'ADD APP PERMISSION');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.ADD;

		this._app = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			Model.App.findById(req.params.id).then((app) => {
				if (!app) {
					this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
				}

				if (!req.body.route || !req.body.permission) {
					this.log('ERROR: Missing required field', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `missing_field`));
				}

				this._app = app;
				resolve(true);
			});
		});
	}

	_exec(req, res, validate) {
		return this._app.addOrUpdatePermission(req.body.route, req.body.permission)
			.then((a) => a.details);
	}
}
routes.push(AddAppPermission);

/**
 * @class GetAppSchema
 */
class GetAppSchema extends Route {
	constructor() {
		super('app/schema', 'GET APP SCHEMA');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.READ;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.authApp) {
				this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
			}
			if (!req.authApp.__schema) {
				this.log('ERROR: No app schema defined', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `no_authenticated_schema`));
			}

			// Filter the returned schema based token role
			let schema = Schema.buildCollections(Schema.decode(req.authApp.__schema));

			const denyAll = (req.roles.app && req.roles.app.endpointDisposition === 'denyAll');
			schema = schema.filter((s) => {
				if (!s.roles || !req.roles.app) return !denyAll;
				const role = s.roles.find((r) => r.name === req.roles.app.name);
				if (role && role.endpointDisposition && role.endpointDisposition.GET === 'allow') return true;

				return !denyAll;
			});

			resolve(schema);
		});
	}

	_exec(req, res, schema) {
		return schema;
	}
}
routes.push(GetAppSchema);

/**
 * @class GetCoreSchema
 */
class GetCoreSchema extends Route {
	constructor() {
		super('app/schema/:schema?', 'GET CORE SCHEMA');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;

		this.redactResults = false;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			let schema = req.params.schema;
			if (!schema) {
				this.log('ERROR: Missing required field', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			schema = schema.split('+').reduce((arr, item) => {
				arr.push(Model[Sugar.String.capitalize(item)].schemaData);
				return arr;
			}, []);

			const denyAll = (req.roles.app && req.roles.app.endpointDisposition === 'denyAll');
			schema = schema.filter((s) => {
				if (!s.roles || !req.roles.app) return !denyAll;
				const role = s.roles.find((r) => r.name === req.roles.app.name);
				if (role && role.endpointDisposition && role.endpointDisposition.GET === 'allow') return true;

				return !denyAll;
			});

			resolve(schema);
		});
	}

	_exec(req, res, schema) {
		return schema;
	}
}
routes.push(GetCoreSchema);

/**
 * @class UpdateAppSchema
 */
class UpdateAppSchema extends Route {
	constructor() {
		super('app/schema', 'UPDATE APP SCHEMA');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.authApp) {
				this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
			}

			if (!req.body) {
				this.log('ERROR: Missing body', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `no_body`));
			}

			if (!Array.isArray(req.body)) {
				this.log('ERROR: Expected body to be an array', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_body_type`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.App.updateSchema(req.authApp._id, req.body)
			.then(() => true);
	}
}
routes.push(UpdateAppSchema);

/**
 * @class UpdateAppRoles
 */
class UpdateAppRoles extends Route {
	constructor() {
		super('app/roles', 'UPDATE APP ROLES');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.authApp) {
				this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.App.updateRoles(req.authApp._id, req.body).then((res) => true);
	}
}
routes.push(UpdateAppRoles);

/**
* @class AddDataSharing
*/
class AddDataSharing extends Route {
	constructor() {
		super('app/dataSharing', 'ADD Data Sharing');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const validation = this.model.validate(req.body);
			if (!validation.isValid) {
				if (validation.missing.length > 0) {
					this.log(`${this.schema.name}: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
				}
				if (validation.invalid.length > 0) {
					this.log(`${this.schema.name}: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
				}

				this.log(`${this.schema.name}: Unhandled Error`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Unhandled error.`));
			}

			// If we're not super then set the appId to be the current appId
			if (!req.body._appId || token.authLevel < 3) {
				req.body._appId = token._app;
			}

			this.model.isDuplicate(req.body)
				.then((res) => {
					if (res === true) {
						this.log(`${this.schema.name}: Duplicate entity`, Route.LogLevel.ERR, req.id);
						return reject(new Helpers.Errors.RequestError(400, `duplicate`));
					}
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return new Promise((resolve, reject) => {
			let _dataSharing = null;
			this.model.add(req.body)
				.then((res) => {
					const dataSharing = (res.dataSharing) ? res.dataSharing : res;
					this.log(`Added App Data Sharing ${dataSharing._id}`);

					// TODO: Token shouldn't be released, an exchange should be done between buttress
					// instances so that this isn't exposed.
					if (res.token) {
						return Object.assign(dataSharing, {
							remoteAppToken: res.token.value,
						});
					}

					return dataSharing;
				})
				.then((dataSharing) => {
					_dataSharing = dataSharing;

					if (dataSharing.remoteApp.token === null) return dataSharing;

					// If the data sharing was setup with a token we'll try to call the remote app
					// with the token to notify it off it's token.
					const api = Buttress.new();
					return api.init({
						buttressUrl: dataSharing.remoteApp.endpoint,
						apiPath: dataSharing.remoteApp.apiPath,
						appToken: dataSharing.remoteApp.token,
						allowUnauthorized: true, // Move along, nothing to see here...
					})
						.then(() => api.App.activateAppDataSharing({
							token: dataSharing.remoteAppToken,
						}))
						.then((res) => {
							if (!res) return;

							// If we got the thumbs up from the other instance we can go ahead and activate
							// the data sharing for this app.
							return this.model.activate(dataSharing._id);
						})
						.then(() => _dataSharing.active = true)
						.catch(reject);
				})
				.then(() => _dataSharing)
				.then(resolve, reject);
		});
	}
}
routes.push(AddDataSharing);

/**
 * @class UpdateAppDataSharingPolicy
 */
class UpdateAppDataSharingPolicy extends Route {
	constructor() {
		super('app/dataSharing/:dataSharingId/policy', 'UPDATE App Data Sharing Policy');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.authApp) {
				this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
			}

			if (!req.params.dataSharingId) {
				this.log('ERROR: No Data Sharing Id', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_data_sharing_id`));
			}

			// Lookup
			this.model.exists(req.params.dataSharingId, {
				'_appId': req.authApp._id,
			})
				.then((res) => {
					if (res !== true) {
						this.log(`${this.schema.name}: unknown data sharing`, Route.LogLevel.ERR, req.id);
						return reject(new Helpers.Errors.RequestError(400, `unknown_data_sharing`));
					}

					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return this.model.updatePolicy(req.authApp._id, req.params.dataSharingId, req.body)
			.then(() => true);
	}
}
routes.push(UpdateAppDataSharingPolicy);

/**
 * @class activ
 */
class ActivateAppDataSharing extends Route {
	constructor() {
		super('app/dataSharing/activate', 'UPDATE Activate App Data Sharing');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.WRITE;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			if (!req.authApp) {
				this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(500, `no_authenticated_app`));
			}

			if (token.type !== Model.Token.Constants.Type.DATA_SHARING) {
				this.log('ERROR: invalid token type', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(401, `invalid_token_type`));
			}

			if (!req.body.token) {
				this.log('ERROR: missing data sharing token', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_data_token`));
			}

			this.model.findOne({
				_tokenId: token._id,
			})
				.then((dataSharing) => {
					if (!dataSharing) {
						this.log(`ERROR: Unable to find dataSharing with token ${token._id}`, Route.LogLevel.ERR, req.id);
						return reject(new Helpers.Errors.RequestError(500, `no_datasharing`));
					}

					resolve(dataSharing);
				});
		});
	}

	_exec(req, res, dataSharing) {
		return this.model.activate(dataSharing._id, req.body.token)
			.then(() => true);
	}
}
routes.push(ActivateAppDataSharing);

/**
 * @type {*[]}
 */
module.exports = routes;
