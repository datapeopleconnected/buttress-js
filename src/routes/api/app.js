/* eslint-disable max-lines */
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
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		if (req.token.authLevel < Route.Constants.Auth.SUPER) {
			return Model.App.find({_id: req.authApp._id});
		}

		return Model.App.findAll();
	}
}
routes.push(GetAppList);

/**
 * @class SearchAppList
 */
class SearchAppList extends Route {
	constructor() {
		super('app', 'GET APP LIST');
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.SEARCH;
	}

	_validate(req, res, token) {
		const result = {
			query: {
				$and: [],
			},
		};
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = Model.App.parseQuery(result.query, {}, Model.App.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.App.find(validate.query);
	}
}
routes.push(SearchAppList);

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

			if (req.body.policyPropertiesList) {
				const validPolicyPropertiesList = Object.values(req.body.policyPropertiesList).every((i) => Array.isArray(i));
				if (!validPolicyPropertiesList) {
					this.log('ERROR: Invalid policy property list', Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `invalid_field`));
				}
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

	async _validate(req, res, token) {
		if (!req.authApp) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `no_authenticated_app`);
		}

		if (!req.authApp.__schema) {
			this.log('ERROR: No app schema defined', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `no_authenticated_schema`);
		}

		let schema;
		try {
			schema = (req.query.rawSchema) ? Schema.decode(req.authApp.__rawSchema) : Schema.buildCollections(Schema.decode(req.authApp.__schema));
		} catch (err) {
			if (err instanceof Helpers.Errors.SchemaInvalid) throw new Helpers.Errors.RequestError(400, `invalid_schema`);
			else throw err;
		}

		if (req.query.core) {
			const cores = req.query.core.split(',');

			cores.forEach((core) => {
				const coreModel = Model[Sugar.String.camelize(core)];
				if (coreModel && coreModel.appShortId === null) {
					schema.push(coreModel.schemaData);
				}
			});
		}

		if (req.query.only) {
			const only = req.query.only.split(',');
			schema = schema.filter((s) => only.includes(s.name));
		}

		return schema;
	}

	async _exec(req, res, collections) {
		const mergedSchema = (req.query.rawSchema) ? collections : await Model.App.mergeRemoteSchema(req, collections);

		// Quicky, remove extends as nobody needs it outside of buttress
		mergedSchema.forEach((s) => delete s.extends);

		// TODO: Policy should be used to dictate what schema the user can access.

		// Filter the returned schema based token role

		return mergedSchema;
	}
}
routes.push(GetAppSchema);

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

			// Sort templates
			req.body = req.body.sort((a, b) => (a.type === 'collection') ? 1 : (b.type === 'collection') ? -1 : 0);

			// Resolve the local schema
			const rawSchema = JSON.stringify(req.body);
			req.body = Schema.merge(req.body, Model.App.localSchema);

			try {
				Schema.buildCollections(req.body);
			} catch (err) {
				console.log(err);
				return reject(new Helpers.Errors.RequestError(400, `invalid_body_type`));
			}

			resolve(rawSchema);
		});
	}

	async _exec(req, res, rawSchema) {
		const updatedSchema = await Model.App.updateSchema(req.authApp._id, req.body, rawSchema);
		let schema = '';
		try {
			schema = Schema.decode(updatedSchema);
		} catch (err) {
			if (err instanceof Helpers.Errors.SchemaInvalid) throw new Helpers.Errors.RequestError(400, `invalid_schema`);
			else throw err;
		}

		// Quicky, remove extends as nobody needs it outside of buttress
		schema.forEach((s) => delete s.extends);

		return schema;
	}
}
routes.push(UpdateAppSchema);

/**
 * @class SetAppPolicyPropertyList
 */
class SetAppPolicyPropertyList extends Route {
	constructor() {
		super('app/policyPropertyList', 'SET APP POLICY PROPERTY LIST');
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

			if (typeof req.body !== 'object' || (typeof req.body === 'object' && Array.isArray(req.body))) {
				this.log('ERROR: Policy property list is invalid type', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_type`));
			}

			const validPolicyPropertiesList = Object.values(req.body).every((i) => Array.isArray(i));
			if (!validPolicyPropertiesList) {
				this.log('ERROR: Invalid policy property list', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_field`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.App.setPolicyPropertiesList(req.authApp._id, req.body)
			.then(() => true);
	}
}
routes.push(SetAppPolicyPropertyList);

/**
 * @class UpdateAppPolicyPropertyList
 */
class UpdateAppPolicyPropertyList extends Route {
	constructor() {
		super('app/updatePolicyPropertyList', 'UPDATE APP POLICY PROPERTY LIST');
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

			if (typeof req.body !== 'object' || ( typeof req.body === 'object' && Array.isArray(req.body))) {
				this.log('ERROR: Policy property list is invalid type', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_type`));
			}

			const validPolicyPropertiesList = Object.values(req.body).every((i) => Array.isArray(i));
			if (!validPolicyPropertiesList) {
				this.log('ERROR: Invalid policy property list', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_field`));
			}

			resolve(true);
		});
	}

	_exec(req, res, validate) {
		return Model.App.updatePolicyPropertiesList(req.authApp._id, req.body)
			.then(() => true);
	}
}
routes.push(UpdateAppPolicyPropertyList);

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
* @class GetDataSharing
*/
class GetDataSharing extends Route {
	constructor() {
		super('app/dataSharing', 'GET Data Sharing');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.LIST;

		this.activityBroadcast = false;
		this.slowLogging = false;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;

		Logging.logSilly(`Created route: ${this.name} for Data Sharing`);
	}

	_validate(req, res, token) {
		Logging.logTimer(`${this.name}:_validate:start`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);

		const result = {
			query: {},
			project: (req.body && req.body.project)? req.body.project : false,
		};

		let query = {};

		if (!query.$and) {
			query.$and = [];
		}

		// access control query
		if (req.body && req.body.query) {
			query.$and.push(req.body.query);
		}

		if (req.body && req.body.query && req.body.query.zeroResults) {
			return false;
		}

		Logging.logTimer(`${this.name}:_validate:end`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
		query = this.model.parseQuery(query, {}, this.model.flatSchemaData);
		result.query = query;

		if (token.authLevel < 3) {
			result.query['_appId'] = req.authApp._id;
		}

		return result;
	}

	_exec(req, res, validateResult) {
		if (validateResult.query === false) {
			return [];
		}

		Logging.logTimer(`${this.name}:_exec:start`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
		return this.model.find(validateResult.query, {}, 0, 0, {}, validateResult.project);
	}
}
routes.push(GetDataSharing);

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
 * @class UpdateAppDataSharingToken
 */
class UpdateAppDataSharingToken extends Route {
	constructor() {
		super('app/dataSharing/:dataSharingId/token', 'UPDATE App Data Sharing Token');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;
	}

	async _validate(req, res, token) {
		if (!req.authApp) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `no_authenticated_app`);
		}

		if (!req.body.token) {
			this.log('ERROR: missing data sharing activation token', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `missing_data_token`);
		}

		if (!req.params.dataSharingId) {
			this.log('ERROR: No Data Sharing Id', Route.LogLevel.ERR);
			return new Helpers.Errors.RequestError(400, `missing_data_sharing_id`);
		}

		// Lookup
		const entity = await Helpers.streamFirst(await this.model.find({
			_id: this.model.createId(req.params.dataSharingId),
			_appId: req.authApp._id,
		}));

		if (!entity) {
			this.log(`${this.schema.name}: unknown data sharing`, Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, `unknown_data_sharing`);
		}

		const api = Buttress.new();
		try {
			await api.init({
				buttressUrl: entity.remoteApp.endpoint,
				apiPath: entity.remoteApp.apiPath,
				appToken: req.body.token,
				allowUnauthorized: true, // Move along, nothing to see here...
			});
		} catch (err) {
			if (err instanceof Buttress.Errors.ResponseError) {
				throw new Helpers.Errors.RequestError(err.code, err.message);
			}
			throw err;
		}

		return {entity, api};
	}

	async _exec(req, res, validate) {
		await this.model.updateActivationToken(req.params.dataSharingId, req.body.token);

		const token = await Model.Token.findById(validate.entity._tokenId);

		// Our token
		const remoteActivation = await validate.api.App.activateAppDataSharing({
			token: token.value,
		});

		if (!remoteActivation) return false;

		await this.model.activate(validate.entity._id);

		delete validate.api;

		return true;
	}
}
routes.push(UpdateAppDataSharingToken);

/**
 * @class ActivateAppDataSharing
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
 * @class AppCount
 */
class AppCount extends Route {
	constructor() {
		super(`app/count`, `COUNT APPS`);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT APPS`;
		this.activityBroadcast = false;

		this.model = Model.App;
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
		return Model.App.count(validateResult.query);
	}
}
routes.push(AppCount);

/**
 * @class AppUpdateOAuth
 */
class AppUpdateOAuth extends Route {
	constructor() {
		super(`app/:id`, `UPDATE APPS OAUTH`);
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.PUT;

		this.activityDescription = `UPDATE APPS OAUTH`;
		this.activityBroadcast = false;

		this.model = Model.App;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const app = await Model.App.findById(req.params.id);
		if (!app) {
			this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}
		return Promise.resolve(true);
	}

	async _exec(req, res, validate) {
		const oAuth = (Array.isArray(req.body.value)) ? req.body.value : [req.body.value];
		await Model.App.updateOAuth(req.params.id, oAuth);
		return true;
	}
}
routes.push(AppUpdateOAuth);

/**
 * @type {*[]}
 */
module.exports = routes;
