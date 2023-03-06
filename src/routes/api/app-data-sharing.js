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
const ObjectId = require('mongodb').ObjectId;

const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');
// const Logging = require('../../logging');

const routes = [];

/**
 * @class GetAppDataSharing
 */
class GetAppDataSharing extends Route {
	constructor() {
		super('appDataSharing/:id', 'GET APP DATA SHARING');
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const id = req.params.id;
		if (!id) {
			this.log(`[${this.name}] Missing required app data sharing id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_app_data_sharing_id`));
		}
		if (!ObjectId.isValid(id)) {
			this.log(`[${this.name}] Invalid app data sharing id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_app_data_sharing_id`));
		}

		const appDataSharing = await Model.AppDataSharing.findById(id);
		if (!appDataSharing) {
			this.log(`[${this.name}] Cannot find a app data sharing with id ${id}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `app_data_sharing_does_not_exist`));
		}

		return appDataSharing;
	}

	_exec(req, res, AppDataSharing) {
		return AppDataSharing;
	}
}
routes.push(GetAppDataSharing);

/**
* @class AddDataSharing
*/
class AddDataSharing extends Route {
	constructor() {
		super('appDataSharing', 'ADD APP DATA SHARING');
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.ADD;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;
	}

	async _validate(req, res, token) {
		if (!req.authApp) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
		}

		const validation = this.model.validate(req.body);
		if (!validation.isValid) {
			if (validation.missing.length > 0) {
				this.log(`${this.schema.name}: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
				return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
			}
			if (validation.invalid.length > 0) {
				this.log(`${this.schema.name}: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
				return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
			}

			this.log(`${this.schema.name}: Unhandled Error`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Unhandled error.`));
		}

		// If we're not super then set the appId to be the current appId
		if (!req.body._appId || token.authLevel < 3) {
			req.body._appId = token._app;
		}

		const result = await this.model.isDuplicate(req.body);
		if (result === true) {
			this.log(`${this.schema.name}: Duplicate entity`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(400, `duplicate`));
		}

		return true;
	}

	async _exec(req, res, validate) {
		const result = await this.model.add(req.body);
		let dataSharing = (result.dataSharing) ? result.dataSharing : result;
		this.log(`Added App Data Sharing ${dataSharing._id}`);

		// TODO: Token shouldn't be released, an exchange should be done between buttress
		// instances so that this isn't exposed.
		if (result.token) {
			dataSharing = Object.assign(dataSharing, {
				remoteAppToken: result.token.value,
			});
		}
		if (!dataSharing.remoteApp.token) return dataSharing;

		// If the data sharing was setup with a token we'll try to call the remote app
		// with the token to notify it off it's token.
		const api = Buttress.new();
		await api.init({
			buttressUrl: dataSharing.remoteApp.endpoint,
			apiPath: dataSharing.remoteApp.apiPath,
			appToken: dataSharing.remoteApp.token,
			allowUnauthorized: true, // Move along, nothing to see here...
		});

		const remoteToken = dataSharing.remoteAppToken;
		const isRemoteActivated = await api.AppDataSharing.activateAppDataSharing(remoteToken, [{
			path: 'remoteApp.token',
			value: remoteToken,
		}, {
			path: 'active',
			value: true,
		}]);
		if (!isRemoteActivated) return dataSharing;

		// If we got the thumbs up from the other instance we can go ahead and activate
		// the data sharing for this app.
		await this.model.activate(dataSharing._id);
		dataSharing.active = true;

		return dataSharing;
	}
}
routes.push(AddDataSharing);


// I do not think we should have bulk data sharing addition
// /**
//  * @class AddManyDataSharingAgreement
//  */
// class AddManyDataSharingAgreement extends Route {
// 	constructor() {
// 		super('appDataSharing/bulk/add', 'ADD MANY APP DATA SHARING AGREEMENT');
// 		this.verb = Route.Constants.Verbs.POST;
// 		this.auth = Route.Constants.Auth.ADMIN;
// 		this.permissions = Route.Constants.Permissions.ADD;

// 		// Fetch model
// 		this.schema = new Schema(Model.AppDataSharing.schemaData);
// 		this.model = Model.AppDataSharing;
// 	}

// 	async _validate(req, res, token) {
// 		if (!req.authApp) {
// 			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
// 			return Promise.reject(new Helpers.Errors.RequestError(400, `no_authenticated_app`));
// 		}

// 		if (!Array.isArray(req.body)) {
// 			this.log(`[${this.name}] Invalid request body`, Route.LogLevel.ERR);
// 			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_body`));
// 		}

// 		for await (const dsa of req.body) {
// 			const validation = this.model.validate(dsa);
// 			if (!validation.isValid) {
// 				if (validation.missing.length > 0) {
// 					this.log(`${this.schema.name}: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
// 					return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
// 				}
// 				if (validation.invalid.length > 0) {
// 					this.log(`${this.schema.name}: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
// 					return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
// 				}

// 				this.log(`${this.schema.name}: Unhandled Error`, Route.LogLevel.ERR, req.id);
// 				return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Unhandled error.`));
// 			}

// 			const appDataSharingExist = await Model.AppDataSharing.findOne({name: dsa.name});
// 			if (appDataSharingExist) {
// 				this.log(`ERROR: Data sharing agreemt with this name ${dsa.name } already exists`, Route.LogLevel.ERR);
// 				return Promise.reject(new Helpers.Errors.RequestError(400, `${dsa.name}_already_exist`));
// 			}
// 		}

// 		return Promise.resolve(true);
// 	}

// 	async _exec(req, res, validate) {
// 		for await (const appDataSharing of req.body) {
// 			const result = await this.model.add(appDataSharing);
// 			let dataSharing = (result.dataSharing) ? result.dataSharing : result;
// 			this.log(`Added App Data Sharing ${dataSharing._id}`);

// 			// TODO: Token shouldn't be released, an exchange should be done between buttress
// 			// instances so that this isn't exposed.
// 			if (result.token) {
// 				dataSharing = Object.assign(dataSharing, {
// 					remoteAppToken: result.token.value,
// 				});
// 			}
// 			if (!dataSharing.remoteApp.token) continue;

// 			// If the data sharing was setup with a token we'll try to call the remote app
// 			// with the token to notify it off it's token.
// 			const api = Buttress.new();
// 			await api.init({
// 				buttressUrl: dataSharing.remoteApp.endpoint,
// 				apiPath: dataSharing.remoteApp.apiPath,
// 				appToken: dataSharing.remoteApp.token,
// 				allowUnauthorized: true, // Move along, nothing to see here...
// 			});

// 			const isRemoteActivated = await api.AppDataSharing.activateAppDataSharing({
// 				token: dataSharing.remoteAppToken,
// 			});
// 			if (!isRemoteActivated) continue;

// 			// If we got the thumbs up from the other instance we can go ahead and activate
// 			// the data sharing for this app.
// 			await this.model.activate(dataSharing._id);
// 			dataSharing.active = true;

// 			return dataSharing;
// 		}

// 		return true;
// 	}
// }
// routes.push(AddManyDataSharingAgreement);

/**
 * @class UpdateAppDataSharing
 */
class UpdateAppDataSharing extends Route {
	constructor() {
		super('appDataSharing/:dataSharingId', 'UPDATE APP DATA SHARING AGREEMENT');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const exists = await Model.AppDataSharing.exists(req.params.dataSharingId);
		if (!exists) {
			this.log('ERROR: Invalid App Data Sharing ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const validation = Model.AppDataSharing.validateUpdate(req.body);
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

		return true;
	}

	async _exec(req, res, validate) {
		return Model.AppDataSharing.updateByPath(req.body, req.params.dataSharingId, 'AppDataSharing');
	}
}
routes.push(UpdateAppDataSharing);

/**
 * @class UpdateAppDataSharingPolicy
 */
class UpdateAppDataSharingPolicy extends Route {
	constructor() {
		super('appDataSharing/:dataSharingId/policy', 'UPDATE APP DATA SHARING AGREEMENT POLICY');
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
		super('appDataSharing/:dataSharingId/token', 'UPDATE APP DATA SHARING AGREEMENT TOKEN');
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
		const remoteActivation = await validate.api.AppDataSharing.activateAppDataSharing(token, [{
			path: 'remoteApp.token',
			value: token.value,
		}, {
			path: 'active',
			value: true,
		}]);

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
		super('appDataSharing/activate/:remoteToken', 'UPDATE Activate App Data Sharing');
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

			if (!req.params.remoteToken) {
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
		return this.model.activate(dataSharing._id, req.params.remoteToken)
			.then(() => true);
	}
}
routes.push(ActivateAppDataSharing);

/**
 * @class DeactivateAppDataSharing
 */
class DeactivateAppDataSharing extends Route {
	constructor() {
		super('appDataSharing/deactivate/:dataSharingId', 'UPDATE Deactivate App Data Sharing');
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.WRITE;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;
	}

	async _validate(req, res, token) {
		const dataSharingId = req.params.dataSharingId;
		if (!req.authApp) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(500, `no_authenticated_app`));
		}

		if (!req.params.dataSharingId) {
			this.log('ERROR: missing data sharing id', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_data_id`));
		}

		const exists = await this.model.findById(dataSharingId);

		if (!exists) {
			this.log(`ERROR: Unable to find dataSharing with token ${token._id}`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(500, `no_datasharing`));
		}

		return exists;
	}

	_exec(req, res, dataSharing) {
		return this.model.deactivate(dataSharing._id)
			.then(() => true);
	}
}
routes.push(DeactivateAppDataSharing);

/**
 * @class SearchAppDataSharingAgreement
 */
class SearchAppDataSharingAgreement extends Route {
	constructor() {
		super('appDataSharing', 'SEARCH APP DATA SHARING AGREEMENT LIST');
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.USER;
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

		result.query = Model.AppDataSharing.parseQuery(result.query, {}, Model.AppDataSharing.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.AppDataSharing.find(validate.query, {},
			validate.limit, validate.skip, validate.sort, validate.project);
	}
}
routes.push(SearchAppDataSharingAgreement);

/**
 * @class AppDataSharingAgreementCount
 */
class AppDataSharingAgreementCount extends Route {
	constructor() {
		super(`appDataSharing/count`, `COUNT APP DATA SHARING AGREEMENT`);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT APP DATA SHARING AGREEMENT`;
		this.activityBroadcast = false;
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

		query = Model.AppDataSharing.parseQuery(query, {}, Model.AppDataSharing.flatSchemaData);
		result.query = query;
		return result;
	}

	_exec(req, res, validateResult) {
		return Model.AppDataSharing.count(validateResult.query);
	}
}
routes.push(AppDataSharingAgreementCount);

/**
 * @class DeleteAppDataSharingAgreement
 */
class DeleteAppDataSharingAgreement extends Route {
	constructor() {
		super(`appDataSharing/:id`, `DELETE APP DATA SHARING AGREEMENT`);
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.SUPER;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE APP DATA SHARING AGREEMENT`;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		if (!req.params.id) {
			this.log(`[${this.name}] Missing required App Data Sharing ID`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_id`));
		}

		const appDataSharing = await Model.AppDataSharing.findById(req.params.id);
		if (!appDataSharing) {
			this.log('ERROR: Invalid App Data Sharing ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const appDataSharingToken = await Model.Token.findById(appDataSharing._tokenId);
		if (!appDataSharingToken) {
			this.log('ERROR: Could not fetch Data Sharing token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `could_not_fetch_data_sharing_token`));
		}

		return {
			appDataSharing,
			token: appDataSharingToken,
		};
	}

	async _exec(req, res, validate) {
		await Model.AppDataSharing.rm(validate.appDataSharing);
		await Model.Token.rm(validate.token);
		return true;
	}
}
routes.push(DeleteAppDataSharingAgreement);

/**
 * @type {*[]}
 */
module.exports = routes;
