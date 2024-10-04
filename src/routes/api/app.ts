/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
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

import Route from '../route';
import Model from '../../model';
import Sugar from '../../helpers/sugar';
import Logging from '../../helpers/logging';
import * as Helpers from '../../helpers';
import Schema from '../../schema';

const routes: (typeof Route)[] = [];

/**
 * @class GetAppList
 */
class GetAppList extends Route {
	constructor(services) {
		super('app', 'GET APP LIST', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		if (req.token.type !== Route.Constants.Type.SYSTEM) {
			return this.model.find({id: req.authApp.id});
		}

		return this.model.findAll();
	}
}
routes.push(GetAppList);

/**
 * @class SearchAppList
 */
class SearchAppList extends Route {
	constructor(services) {
		super('app', 'GET APP LIST', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.SEARCH;
	}

	async _validate(req, res, token) {
		const result: {
			query: any
		} = {
			query: {
				$and: [],
			},
		};
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = this.model.parseQuery(result.query, {}, this.model.flatSchemaData);
		return result;
	}

	async _exec(req, res, validate) {
		const appsDB = await Helpers.streamAll(await this.model.find(validate.query));

		const tokenIds = appsDB.map((app) => Model.getModel('Token').createId(app._tokenId));
		const appTokens = await Helpers.streamAll(await Model.getModel('Token').find({
			id: {
				$in: tokenIds,
			},
		}));

		return appsDB.reduce((arr, app) => {
			const appToken = appTokens.find((t) => t.id.toString() === app._tokenId.toString());
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
	constructor(services) {
		// Should change to app apiPath instead of ID
		super('app/:id([0-9|a-f|A-F]{24})', 'GET APP', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		if (!req.params.id) {
			this.log('ERROR: Missing required field', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_fields`));
		}

		const app = await this.model.findById(req.params.id);
		if (!app) {
			this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		return app;
	}

	_exec(req, res, validate) {
		const appToken = Model.getModel('Token').findById(Model.getModel('Token').createId(validate._tokenId));
		validate.tokenValue = appToken.value;

		return validate;
	}
}
routes.push(GetApp);

/**
 * @class AddApp
 */
class AddApp extends Route {
	constructor(services) {
		super('app', 'APP ADD', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.ADD;
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

			req.body.policyPropertiesList = req.body.policyPropertiesList || {};
			if (req.body.policyPropertiesList) {
				const policyPropertiesList = Object.keys(req.body.policyPropertiesList).filter((key) => key !== 'query');
				const validPolicyPropertiesList = policyPropertiesList.every((key) => Array.isArray(req.body.policyPropertiesList[key]));
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
			this.model.add(req.body)
				.then((res) => {
					this._nrp?.emit('app:configure-lambda-endpoints', res.app.apiPath);

					return Object.assign(res.app, {token: res.token.value});
				})
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
	constructor(services) {
		super('app/:id', 'DELETE APP', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req, res, token) {
		if (!req.params.id) {
			this.log('ERROR: Missing required field', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `missing_field`);
		}

		const app = await this.model.findById(req.params.id);
		if (!app) {
			this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
			throw new Helpers.Errors.RequestError(400, `invalid_id`);
		}

		return app;
	}

	async _exec(req, res, app) {
		await this.model.rm(app)
		return true;
	}
}
routes.push(DeleteApp);

/**
 * @class DeleteAppPolicies
 */
class DeleteAllApps extends Route {
	constructor(services) {
		super('app', 'DELETE ALL APPS', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req) {
		return true;
	}

	async _exec(req, res, validate) {
		// Get a list of system tokens
		const systemTokens = await Helpers.streamAll(await Model.getModel('Token').find({
			type: Model.getModel('Token').Constants.Type.SYSTEM,
		}, {}, 0, 0, {}, {_appId: 1}));

		const systemApps = systemTokens.map((t) => t._appId.toString());
		const appApps = await this.model.find({ id: { $nin: systemApps } }, {}, 0, 0, {}, {id: 1, _tokenId: 1});

		for await (const app of appApps) {
			if (systemApps.includes(app.id.toString())) continue;

			Logging.logDebug(`Deleting app: ${app.id}`);
			await this.model.rm(app);
		}

		return true;
	}
}
routes.push(DeleteAllApps);

/**
 * @class GetAppSchema
 */
class GetAppSchema extends Route {
	constructor(services) {
		super('app/schema', 'GET APP SCHEMA', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.USER;
		this.permissions = Route.Constants.Permissions.READ;

		this.redactResults = false;
		this.addSourceId = false;
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
				if (coreModel && coreModel.getModel('App').ShortId === null) {
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
		const mergedSchema = (req.query.rawSchema) ? collections : await this.model.mergeRemoteSchema(req, collections);

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
	constructor(services) {
		super('app/schema', 'UPDATE APP SCHEMA', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.redactResults = false;
		this.addSourceId = false;
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
			this.log(`ERROR: Expected body to be an array but got ${typeof req.body}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_body_type`));
		}

		const rawSchema = req.body;

		// Check the validatiry of the rawSchema
		try {
			for (let i = 0; i < rawSchema.length; i++) {
				const schema = rawSchema[i];
				if (!schema.name) {
					this.log(`ERROR: Missing name for schema at index ${i}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `schema_missing_name`));
				}
				if (!schema.type) {
					this.log(`ERROR: Missing type for schema at index ${i}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `schema_missing_type`));
				}

				if (schema.name.length < 1 || schema.name.length > 20) {
					this.log(`ERROR: Schema name needs to be between 1 and 20 alphanumeric characters (${schema.name})`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `schema_invalid_name`));
				}
				if (!/^[a-zA-Z0-9]+$/.test(schema.name)) {
					this.log(`ERROR: Schema name can only contain alphanumeric characters (${schema.name})`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `schema_invalid_name`));
				}

				if (!Schema.validTypes.includes(schema.type)) {
					this.log(`ERROR: Invalid schema type (${schema.type})`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `schema_invalid_type`));
				}
			}
		} catch (err) {
			Logging.logError(err);
			throw err;
		}

		// Sort templates
		let compiledSchema = rawSchema.sort((a, b) => (a.type.indexOf('collection') === 0) ? 1 : (b.type.indexOf('collection') === 0) ? -1 : 0);

		try {
			compiledSchema = await this.model.mergeRemoteSchema(req, compiledSchema);

			// Merge any schema extends
			compiledSchema = Schema.merge(compiledSchema, this.model.localSchema);

			// building the schema to check for any timeseries
			compiledSchema = await Schema.buildCollections(compiledSchema);

			// merging the built timeseries to get the extends schemas
			compiledSchema = Schema.merge(compiledSchema, this.model.localSchema);

			return {
				rawSchema: JSON.stringify(rawSchema),
				compiledSchema,
			};
		} catch (err) {
			Logging.logError(err);
			throw new Helpers.Errors.RequestError(400, `invalid_body_type`);
		}
	}

	async _exec(req, res, {rawSchema, compiledSchema}) {
		await this.model.updateSchema(req.authApp.id, compiledSchema, rawSchema);

		const a = compiledSchema.filter((s) => s.type === 'collection').map((s) => {
			delete s.extends;
			return s;
		});

		return a;
	}
}
routes.push(UpdateAppSchema);

/**
 * @class GetAppPolicyPropertyList
 */
class GetAppPolicyPropertyList extends Route {
	constructor(services) {
		super('app/policy-property-list/:apiPath?', 'GET APP POLICY PROPERTY LIST', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req, res, token) {
		let app = req.authApp;
		if (!app) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
		}

		const apiPath = req.params.apiPath;
		const isSuper = token.type === Model.getModel('Token').Constants.Type.SYSTEM;
		if (apiPath && apiPath !== app.apiPath && !isSuper) {
			this.log('ERROR: Cannot fetch policy properties list for another app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `cannot_fetch_list_for_another_app`));
		}

		if (apiPath) {
			app = await this.model.findOne({
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
	constructor(services) {
		super('app/policy-property-list/:update/:appId?', 'SET APP POLICY PROPERTY LIST', services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
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
		const appId = req.authApp.id;
		const update = Object.assign({}, validate);
		if (update.query) delete update.query;

		let query = {};
		if (appId) {
			query = {
				id: {
					$eq: appId,
				},
			};
		}
		if (validate.query && Object.keys(validate.query).length > 0) {
			query = validate.query;
		}

		await this.model.setPolicyPropertiesList(query, update);
		return update;
	}
}
routes.push(SetAppPolicyPropertyList);

/**
 * @class AppCount
 */
class AppCount extends Route {
	constructor(services) {
		super(`app/count`, `COUNT APPS`, services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT APPS`;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		const result = {
			query: {},
		};

		let query: {
			$and?: any
		} = {};

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
		return this.model.count(validateResult.query);
	}
}
routes.push(AppCount);

/**
 * @class AppUpdateOAuth
 */
class AppUpdateOAuth extends Route {
	constructor(services) {
		super(`app/:id/oauth`, `UPDATE APPS OAUTH`, services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.SYSTEM;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityDescription = `UPDATE APPS OAUTH`;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const app = await this.model.findById(req.params.id);
		if (!app) {
			this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}
		return Promise.resolve(true);
	}

	async _exec(req, res, validate) {
		const oAuth = (Array.isArray(req.body.value)) ? req.body.value : [req.body.value];
		await this.model.updateOAuth(req.params.id, oAuth);
		return true;
	}
}
routes.push(AppUpdateOAuth);


// TODO remove all the other endpoints and use this generic endpoint
/**
 * @class AppUpdate
 */
class AppUpdate extends Route {
	constructor(services) {
		super(`app/:id`, `UPDATE AN APP`, services, Model.getModel('App'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getModel('Activity').Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const {validation, body} = this.model.validateUpdate(req.body);
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

		const exists = await this.model.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid App ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}
		return true;
	}

	_exec(req, res, validate) {
		return this.model.updateByPath(req.body, req.params.id, null, 'App');
	}
}
routes.push(AppUpdate);

/**
 * @type {*[]}
 */
export default routes;
