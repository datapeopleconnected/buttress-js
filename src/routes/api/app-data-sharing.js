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
const Schema = require('../../schema');
// const Logging = require('../../logging');

const Datastore = require('../../datastore');
const DatastoreFactory = require('../../datastore/adapter-factory');

/**
 * The data sharing agreement registration process should be as follows:
 * 1. A data sharing agreement is created on App1.
 * 2. App one gives the admin of App2 the registration token.
 * 3. App2 creates a data sharing agreement with remoteApp.token field populated.
 * 4. App2 will send a request to App1 to activate using the registration token to make the request and a new token in the post data.
 * 5. App1 will replace `remoteApp.token` with the new token, activate the data sharing agreement on it's side and return the new token.
 * 6. App2 will replace it's remoteApp.token with the new token & activate the agreement on it's side.
 */
/**
 * @param {object} dataSharing
 * @param {string} dataSharingTokenId
 * @return {object} dataSharing
 */
const activateDataSharing = async (dataSharing, dataSharingTokenId) => {
	// Create new token
	const newToken = Model.Token.createTokenString();

	let connectionString = Helpers.DataSharing.createDataSharingConnectionString(dataSharing.remoteApp);

	// Create datastore, this will be used to activate the data sharing agreement.
	const buttressAdapter = DatastoreFactory.create(connectionString);
	await buttressAdapter.connect();

	// Send a request to the remote app to activate the data sharing agreement.
	const activationResult = await buttressAdapter.activateDataSharing(dataSharing.remoteApp.token, newToken);
	if (!activationResult || !activationResult.status) return dataSharing;

	// Flag our data sharing agreement as active & update the remote app token with the new one.
	await Model.AppDataSharing.activate(dataSharing.id, activationResult.token);
	dataSharing.remoteApp.token = activationResult.token;

	// Update our data sharing agreement token with the new value.
	await Model.Token.update({'id': dataSharingTokenId}, {$set: {'value': newToken}});

	// Rebuild the connection string with the new token
	connectionString = Helpers.DataSharing.createDataSharingConnectionString(dataSharing.remoteApp);

	// Destroy the current adapter and re-open it again with the new token
	await buttressAdapter.close();

	// Establish a connection using the datastore manager so it's ready for any future requests.
	// TOOD: Handle errors with the new token here.
	const datastore = Datastore.createInstance({connectionString});
	await datastore.connect();

	dataSharing.active = true;
	return dataSharing;
};

/**
 * Activation of a data sharing agreements should be as follows:
 * 1. App2 will send a request to App1 to activate using the registration token to make the request and a new token in the post data.
 * 2. App1 will replace `remoteApp.token` with the new token, activate the data sharing agreement on it's side and return the new token.
 * 3. App2 will replace it's remoteApp.token with the new token & activate the agreement on it's side.
 */

/**
 * De-Activation of a data sharing agreements should be as follows:
 * 1. App1 will set it's data sharing agreement property `active` to false, shutdown connections and clean up schema/routes.
 * 2. App1 will send a request to App2 to deactivate the data sharing agreement. (Optional)
 * 3. App2 will set it's data sharing agreement property `active` to false, shutdown connections and clean up schema/routes (Optional)
 */

const routes = [];

/**
 * @class GetAppDataSharing
 */
class GetAppDataSharing extends Route {
	constructor(nrp, redisClient) {
		super('app-data-sharing/:id', 'GET APP DATA SHARING', nrp, redisClient);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const id = req.params.id;
		if (!id) {
			this.log(`[${this.name}] Missing required app data sharing id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_app_data_sharing_id`));
		}
		if (!Datastore.getInstance('core').ID.isValid(id)) {
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
	constructor(nrp) {
		super('app-data-sharing', 'ADD APP DATA SHARING', nrp);
		this.verb = Route.Constants.Verbs.POST;
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
		if (!req.body._appId || token.type !== Model.Token.Constants.Type.DATA_SHARING) {
			req.body._appId = token._appId;
		}

		if (!req.body.policy) {
			this.log(`[${this.name}] Policy is required when creating a data sharing agreement`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_policy`));
		}

		const result = await this.model.isDuplicate(req.body);
		if (result === true) {
			this.log(`${this.schema.name}: Duplicate entity`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(400, `duplicate`));
		}

		// TODO: Should check the policy config instead.
		// const policyCheck = await Helpers.checkAppPolicyProperty(req.authApp.policyPropertiesList, req.body.dataSharing.local);
		// if (!policyCheck.passed) {
		// 	this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
		// 	return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_policy_property`));
		// }

		return true;
	}

	async _exec(req, res, validate) {
		const result = await this.model.add(req.body);
		let dataSharing = (result.dataSharing) ? result.dataSharing : result;
		this.log(`Added App Data Sharing ${dataSharing.id}`);

		dataSharing = Object.assign(dataSharing, {
			registrationToken: result.token.value,
		});

		// skip if we don't have a registration token
		if (!dataSharing.remoteApp.token) return dataSharing;

		return await activateDataSharing(dataSharing, result.token.id);
	}
}
routes.push(AddDataSharing);

/**
 * @class UpdateAppDataSharing
 */
class UpdateAppDataSharing extends Route {
	constructor(nrp) {
		super('app-data-sharing/:dataSharingId', 'UPDATE APP DATA SHARING AGREEMENT', nrp);
		this.verb = Route.Constants.Verbs.PUT;
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

		const {validation, body} = Model.AppDataSharing.validateUpdate(req.body);
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

		return true;
	}

	async _exec(req, res, validate) {
		// TODO: Handle a change to req.body.dataSharing.local and reflect the change onto the token
		return Model.AppDataSharing.updateByPath(req.body, req.params.dataSharingId, null, 'AppDataSharing');
	}
}
routes.push(UpdateAppDataSharing);

/**
 * @class BulkUpdateAppDataSharing
 */
class BulkUpdateAppDataSharing extends Route {
	constructor(nrp) {
		super('app-data-sharing/bulk/update', 'BULK UPDATE APP DATA SHARING AGREEMENT', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		for await (const item of req.body) {
			const exists = await Model.AppDataSharing.exists(item.id);
			if (!exists) {
				this.log('ERROR: Invalid App Data Sharing ID', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
			}

			const {validation, body} = Model.AppDataSharing.validateUpdate(item.body);
			item.body = body;
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
		}

		return true;
	}

	async _exec(req, res, validate) {
		for await (const item of req.body) {
			// TODO: Handle a change to req.body.dataSharing.local and reflect the change onto the token
			await Model.AppDataSharing.updateByPath(item.body, item.id, null, 'AppDataSharing');
		}

		return true;
	}
}
routes.push(BulkUpdateAppDataSharing);

/**
 * @class UpdateAppDataSharingPolicy
 */
class UpdateAppDataSharingPolicy extends Route {
	constructor(nrp) {
		super('app-data-sharing/:dataSharingId/policy', 'UPDATE APP DATA SHARING AGREEMENT POLICY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
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
			this.model.exists(req.params.dataSharingId, null, {
				'_appId': req.authApp.id,
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
		// TODO: Handle a change to req.body.dataSharing.local and reflect the change onto the token
		return this.model.updatePolicy(req.authApp.id, req.params.dataSharingId, req.body)
			.then(() => true);
	}
}
routes.push(UpdateAppDataSharingPolicy);

/**
 * @class ActivateAppDataSharing
 * @description This endpoint will be called by remote buttress apps to activate
 *   data sharing agreement. This endpoint will be made Buttres <-> Buttress and
 *   not by a end user.
 */
class ActivateAppDataSharing extends Route {
	constructor(nrp) {
		super('app-data-sharing/activate', 'POST Activate App Data Sharing', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.WRITE;

		// Fetch model
		this.schema = new Schema(Model.AppDataSharing.schemaData);
		this.model = Model.AppDataSharing;
	}

	async _validate(req, res, token) {
		if (!req.authApp) {
			this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(500, `no_authenticated_app`));
		}

		if (token.type !== Model.Token.Constants.Type.DATA_SHARING) {
			this.log(`ERROR: invalid token type, type was ${token.type}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(401, `invalid_token_type`));
		}

		if (!req.body.newToken) {
			this.log('ERROR: missing remote data sharing token', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_data_token`));
		}

		return this.model.findById(token._appDataSharingId)
			.then((dataSharing) => {
				if (!dataSharing) {
					this.log(`ERROR: Unable to find dataSharing with token ${token.id}`, Route.LogLevel.ERR, req.id);
					throw new Helpers.Errors.RequestError(500, `no_datasharing`);
				}

				return dataSharing;
			});
	}

	async _exec(req, res, dataSharing) {
		if (dataSharing.active) return true;

		const newLocalToken = Model.Token.createTokenString();

		const {newToken} = req.body;
		await this.model.activate(dataSharing.id, newToken);

		await Model.Token.update({
			'id': req.token.id,
		}, {$set: {'value': newLocalToken}});

		return {
			status: true,
			token: newLocalToken,
		};
	}
}
routes.push(ActivateAppDataSharing);

/**
 * @class ReactivateAppDataSharing
 * @description This endpoint will be called by buttress app admins to reactivate
 *  a data sharing agreement which has been deactivated. It will follow the same
 *  flow as the activate endpoint and cycle tokens.
 */
class ReactivateAppDataSharing extends Route {
	constructor(nrp) {
		super('app-data-sharing/reactivate/:dataSharingId', 'UPDATE Reactivate App Data Sharing', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;
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
			this.log(`ERROR: Unable to find dataSharing with token ${token.id}`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(500, `no_datasharing`));
		}

		return exists;
	}

	_exec(req, res, dataSharing) {
		return this.model.deactivate(dataSharing.id)
			.then(() => true);
	}
}
routes.push(ReactivateAppDataSharing);

/**
 * @class DeactivateAppDataSharing
 */
class DeactivateAppDataSharing extends Route {
	constructor(nrp) {
		super('app-data-sharing/deactivate/:dataSharingId', 'UPDATE Deactivate App Data Sharing', nrp);
		this.verb = Route.Constants.Verbs.PUT;
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
			this.log(`ERROR: Unable to find dataSharing with token ${token.id}`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(500, `no_datasharing`));
		}

		return exists;
	}

	_exec(req, res, dataSharing) {
		return this.model.deactivate(dataSharing.id)
			.then(() => true);
	}
}
routes.push(DeactivateAppDataSharing);

class StatusAppDataSharing extends Route {
	constructor(nrp) {
		super('app-data-sharing/:dataSharingId/status', 'GET App Data Sharing Status', nrp);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;

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
			this.log(`ERROR: Unable to find dataSharing with token ${token.id}`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(500, `no_datasharing`));
		}

		return exists;
	}

	async _exec(req, res, token) {
		return {
			connected: false,
		};
	}
}
routes.push(StatusAppDataSharing);

/**
 * @class GetAllAppDataSharing
 */
class GetAllAppDataSharing extends Route {
	constructor(nrp) {
		super('app-data-sharing', 'APP DATA SHARING AGREEMENT LIST', nrp);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate() {
		return true;
	}

	_exec() {
		return Model.AppDataSharing.findAll();
	}
}
routes.push(GetAllAppDataSharing);

/**
 * @class SearchAppDataSharingAgreement
 */
class SearchAppDataSharingAgreement extends Route {
	constructor(nrp) {
		super('app-data-sharing', 'SEARCH APP DATA SHARING AGREEMENT LIST', nrp);
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
	constructor(nrp) {
		super('app-data-sharing/count', 'COUNT APP DATA SHARING AGREEMENT', nrp);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.SEARCH;

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
	constructor(nrp) {
		super('app-data-sharing/:id', 'DELETE APP DATA SHARING AGREEMENT', nrp);
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;

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
