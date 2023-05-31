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
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		if (req.token.type !== Route.Constants.Type.SYSTEM) {
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

	async _exec(req, res, validate) {
		const appsDB = await Helpers.streamAll(await Model.App.find(validate.query));

		const tokenIds = appsDB.map((app) => Model.Token.createId(app._tokenId));
		const appTokens = await Helpers.streamAll(await Model.Token.find({
			_id: {
				$in: tokenIds,
			},
		}));

		return appsDB.reduce((arr, app) => {
			const appToken = appTokens.find((t) => t._id.toString() === app._tokenId.toString());
			app.tokenValue = appToken.value;
			arr.push(app);
			return arr;
		}, []);
	}
}
routes.push(SearchAppList);

/**
 * @class GetApp
 */
class GetApp extends Route {
	constructor() {
		// Should change to app apiPath instead of ID
		super('app/:id([0-9|a-f|A-F]{24})', 'GET APP');
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;

		this._app = false;
	}

	async _validate(req, res, token) {
		if (!req.params.id) {
			this.log('ERROR: Missing required field', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_fields`));
		}

		const app = await Model.App.findById(req.params.id);
		if (!app) {
			this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		return app;
	}

	_exec(req, res, validate) {
		const appToken = Model.Token.findById(Model.Token.createId(validate._tokenId));
		validate.tokenValue = appToken.value;

		return validate;
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

			const appType = req.body.type;
			if (!req.body.policyPropertiesList && appType !== Model.Token.Constants.Type.SYSTEM) {
				req.body.policyPropertiesList = {};
			}

			if (!req.body.permissions || req.body.permissions.length === 0) {
				const permissions = [
					{route: '*', permission: '*'},
				];
				req.body.permissions = JSON.stringify(permissions);
			}

			try {
				req.body.permissions = JSON.parse(req.body.permissions);
			} catch (e) {
				this.log('ERROR: Badly formed JSON in permissions', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_json`));
			}

			const postedPropsList = req.body.policyPropertiesList;
			if (postedPropsList) {
				const policyPropertiesList = Object.keys(postedPropsList).filter((key) => key !== 'query');
				const validPolicyPropertiesList = policyPropertiesList.every((key) => Array.isArray(postedPropsList[key]));
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
			schema = (req.query.rawSchema && req.authApp.__rawSchema) ?
				Schema.decode(req.authApp.__rawSchema) : await Schema.buildCollections(Schema.decode(req.authApp.__schema));
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
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req, res, token) {
		if (!req.authApp) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
		}
		if (!req.body) {
			this.log('ERROR: Missing body', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `no_body`));
		}
		if (!Array.isArray(req.body)) {
			this.log('ERROR: Expected body to be an array', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_body_type`));
		}

		// Sort templates
		req.body = req.body.sort((a, b) => (a.type.indexOf('collection') === 0) ? 1 : (b.type.indexOf('collection') === 0) ? -1 : 0);

		try {
			// merging req schema to get the extends schemas
			req.body = Schema.merge(req.body, Model.App.localSchema);

			// building the schema to check for any timeseries
			const res = await Schema.buildCollections(req.body);
			const rawSchema = JSON.stringify(res);

			// merging the built timeseries to get the extends schemas
			req.body = Schema.merge(res, Model.App.localSchema);

			return rawSchema;
		} catch (err) {
			Logging.logError(err);
			throw new Helpers.Errors.RequestError(400, `invalid_body_type`);
		}
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
 * @class GetAppPolicyPropertyList
 */
class GetAppPolicyPropertyList extends Route {
	constructor() {
		super('app/policyPropertyList/:apiPath?', 'GET APP POLICY PROPERTY LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req, res, token) {
		let app = req.authApp;
		if (!app) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
		}

		const apiPath = req.params.apiPath;
		const isSuper = token.type === Model.Token.Constants.Type.SYSTEM;
		if (apiPath && apiPath !== app.apiPath && !isSuper) {
			this.log('ERROR: Cannot fetch policy properties list for another app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `cannot_fetch_list_for_another_app`));
		}

		if (apiPath) {
			app = await Model.App.findOne({
				apiPath: {
					$eq: apiPath,
				},
			});
		}

		return app;
	}

	async _exec(req, res, app) {
		return app.policyPropertiesList;
	}
}
routes.push(GetAppPolicyPropertyList);

/**
 * @class SetAppPolicyPropertyList
 */
class SetAppPolicyPropertyList extends Route {
	constructor() {
		super('app/policyPropertyList/:update/:appId?', 'SET APP POLICY PROPERTY LIST');
		this.verb = Route.Constants.Verbs.PUT;
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

			if (!req.params.appId && (!req.body.query || Object.keys(req.body.query).length < 1)) {
				this.log('ERROR: Missing appId or a query to update a targetted app', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `missing_app_query`));
			}

			const policyPropertiesList = Object.keys(req.body).filter((key) => key !== 'query');
			const validPolicyPropertiesList = policyPropertiesList.every((key) => Array.isArray(req.body[key]));
			if (!validPolicyPropertiesList) {
				this.log('ERROR: Invalid policy property list', Route.LogLevel.ERR);
				return reject(new Helpers.Errors.RequestError(400, `invalid_field`));
			}

			if (req.params.update === 'true') {
				const currentAppListKeys = Object.keys(req.authApp.policyPropertiesList);
				Object.keys(req.body).forEach((key) => {
					if (currentAppListKeys.includes(key)) {
						req.body[key] = req.body[key].concat(req.authApp.policyPropertiesList[key]).filter((v, idx, arr) => arr.indexOf(v) === idx);
					}
				});
				const postedPropsList = Object.keys(req.body).reduce((obj, key) => {
					if (key === 'query') return obj;

					obj[key] = req.body[key];
					return obj;
				}, {});
				req.body = {...req.authApp.policyPropertiesList, ...postedPropsList};
			}

			resolve(req.body);
		});
	}

	async _exec(req, res, validate) {
		const appId = req.params.appId;
		const update = Object.assign({}, validate);
		if (update.query) delete update.query;

		let query = {};
		if (appId) {
			query = {
				_id: {
					$eq: appId,
				},
			};
		}
		if (validate.query && Object.keys(validate.query).length > 0) {
			query = validate.query;
		}

		await Model.App.setPolicyPropertiesList(query, update);
		return update;
	}
}
routes.push(SetAppPolicyPropertyList);

/**
 * @class AppCount
 */
class AppCount extends Route {
	constructor() {
		super(`app/count`, `COUNT APPS`);
		this.verb = Route.Constants.Verbs.SEARCH;
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
		super(`app/:id/oauth`, `UPDATE APPS OAUTH`);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

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


// TODO remove all the other endpoints and use this generic endpoint
/**
 * @class AppUpdate
 */
class AppUpdate extends Route {
	constructor() {
		super(`app/:id`, `UPDATE AN APP`);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;

		this.model = Model.App;
	}

	async _validate(req, res, token) {
		const {validation, body} = Model.App.validateUpdate(req.body);
		req.body = body;
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

		const exists = await Model.App.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}
		return true;
	}

	_exec(req, res, validate) {
		return Model.App.updateByPath(req.body, req.params.id, 'App');
	}
}
routes.push(AppUpdate);

/**
 * @type {*[]}
 */
module.exports = routes;
