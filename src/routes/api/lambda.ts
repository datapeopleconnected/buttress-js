/* eslint-disable max-lines */
'use strict'; // eslint-disable-line max-lines

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

import util from 'util';
import Sugar from 'sugar';
import {ObjectId} from 'bson';

import {exec as cpExec} from 'child_process';
const exec = util.promisify(cpExec);

import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;

import Route from '../route';
import Model from '../../model';
import * as Helpers from '../../helpers';

import Datastore from '../../datastore';

const routes: (typeof Route)[] = [];

/**
 * @class GetLambda
 */
class GetLambda extends Route {
	constructor(services) {
		super('lambda/:id', 'GET LAMBDA', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.READ;
	}

	async _validate(req, res, token) {
		const id = req.params.id;
		if (!id) {
			this.log(`[${this.name}] Missing required lambda id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
		}
		if (!ObjectId.isValid(id)) {
			this.log(`[${this.name}] Invalid lambda id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
		}

		const lambda = await this.model.findById(id);
		if (!lambda) {
			this.log(`[${this.name}] Cannot find a lambda with id id`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `lambda_does_not_exist`));
		}

		return lambda;
	}

	_exec(req, res, lambda) {
		return lambda;
	}
}
routes.push(GetLambda);

/**
 * @class GetLambdaList
 */
class GetLambdaList extends Route {
	constructor(services) {
		super('lambda', 'GET LAMBDA LIST', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.GET;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		const ids = req.body.ids;
		if (ids && ids.length > 0) {
			ids.forEach((id) => {
				try {
					Datastore.getInstance('core').ID.new(id);
				} catch (err) {
					this.log(`POLICY: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
					throw new Helpers.Errors.RequestError(400, 'invalid_id');
				}
			});
		}

		return Promise.resolve(true);
	}

	async _exec(req, res, validate) {
		const ids = req.body.ids;
		if (ids && ids.length > 0) {
			return this.model.findByIds(ids);
		}

		return (req.token && req.token.type === Model.getModel('Token').Constants.Type.SYSTEM) ?
			await this.model.findAll() : await this.model.find({_appId: this.model.ID.new(req.authApp.id)});
	}
}
routes.push(GetLambdaList);

/**
 * @class SearchLambdaList
 */
class SearchLambdaList extends Route {
	constructor(services) {
		super('lambda', 'SEARCH LAMBDA LIST', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	async _validate(req, res, token) {
		const result: {
			query: any
		} = {
			query: {
				$and: [],
			},
		};

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = this.model.parseQuery(result.query, {}, this.model.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return this.model.find(validate.query);
	}
}
routes.push(SearchLambdaList);

/**
 * @class AddLambda
 */
class AddLambda extends Route {
	constructor(services) {
		super('lambda', 'ADD LAMBDA', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		try {
			const name = req.body?.lambda?.name;
			const url = req.body?.lambda?.git?.url;
			const branch = req.body?.lambda?.git?.branch;
			const gitHash = req.body?.lambda?.git?.hash;

			if (!req.authApp ||
					!req.body.lambda.trigger ||
					!req.body.lambda.git ||
					!req.body.lambda.git.entryFile ||
					!req.body.lambda.git.entryPoint ||
					!name ||
					!url ||
					!gitHash ||
					!branch) {
				this.log(`[${this.name}] Missing required lambda field`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			if (req.body.lambda && req.body.lambda.policyProperties) {
				req.body.auth.policyProperties = req.body.lambda.policyProperties;
			}

			if (!req.body.auth) {
				this.log(`[${this.name}] Auth properties are required when creating a lambda`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `missing_auth`));
			}

			if (!req.body.auth.permissions || !req.body.auth.domains || !req.body.auth.policyProperties) {
				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
			}

			return Promise.resolve(true);
		} catch (err) {
			return Promise.reject(err);
		}
	}

	async _exec(req, res, validate) {
		let appId = req.authApp.id;
		if (!appId) {
			// const token = await this._getToken(req);
			const token = req.token;
			if (token && token._appId) {
				appId = token._appId;
			}
			if (token && token._lambdaId) {
				const lambda = await this.model.findById(token._lambdaId);
				appId = lambda._appId;
			}
			if (token && token._userId) {
				const user = await Model.getModel('User').findById(token._userId);
				appId = user._appId;
			}
		}

		const app = await Model.getModel('App').findById(appId);
		const lambda = await this.model.add(req.body.lambda, {auth: req.body.auth, app});
		this._nrp?.emit('app-lambda:path-mutation-bust-cache', JSON.stringify(lambda));

		return lambda;
	}
}
routes.push(AddLambda);

/**
 * @class UpdateLambda
 */
class UpdateLambda extends Route {
	constructor(services) {
		super('lambda/:id', 'UPDATE LAMBDA', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getModel('Activity').Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const {validation, body} = this.model.validateUpdate(req.body);
			req.body = body;

			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `LAMBDA: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return reject(new Helpers.Errors.RequestError(400, `LAMBDA: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			this.model.exists(req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid LAMBDA ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});
		});
	}

	async _exec(req, res, validate) {
		const updated = await this.model.updateByPath(req.body, req.params.id, null, 'Lambda');

		const lambda = await this.model.findById(req.params.id);
		if (req.body.some((update) => update.path.replace(/\./g, '_').toUpperCase() === 'GIT_HASH')) {
			await this.model.pullLambdaCode(lambda);
		}
		return updated;
	}
}
routes.push(UpdateLambda);

/**
 * @class BulkUpdateLambda
 */
class BulkUpdateLambda extends Route {
	constructor(services) {
		super('lambda/bulk/update', 'BULK UPDATE LAMBDA', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getModel('Activity').Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		for await (const item of req.body) {
			const {validation, body} = this.model.validateUpdate(item.body);
			item.body = body;
			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `LAMBDA: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
					return Promise.reject(new Helpers.Errors.RequestError(400, `LAMBDA: Update value is invalid: ${validation.invalidValue}`));
				}
			}

			const exists = this.model.exists(item.id);
			if (!exists) {
				this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
			}
		}

		return req.body;
	}

	async _exec(req, res, validate) {
		for await (const item of validate) {
			await this.model.updateByPath(item.body, item.id, null, 'Lambda');
			const lambda = await this.model.findById(item.id);
			if (item.body.some((update) => update.path.replace(/\./g, '_').toUpperCase() === 'GIT_HASH')) {
				await this.model.pullLambdaCode(lambda);
			}
		}
		return true;
	}
}
routes.push(BulkUpdateLambda);

/**
 * @class EditLambdaDeployment
 */
class ScheduleLambdaExecution extends Route {
	constructor(services) {
		super('lambda/:id/schedule', 'SCHEDULE LAMBDA EXECUTION', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.POST;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_post_body`));
		}

		// This should be auto scoped to the app id.
		const lambda = await this.model.findOne({
			id: this.model.createId(req.params.id),
			...(req.authApp.id) ? {_appId: Model.getModel('App').createId(req.authApp.id)} : {},
		});
		if (!lambda) {
			this.log('ERROR: Lambda not found', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(404, `not_found`));
		}

		// Find deployment
		const deploymentQuery: {
			lambdaId: string
			id?: string
		} = {
			lambdaId: lambda.id,
		};
		if (req.body.deploymentId) {
			deploymentQuery.id = Model.getModel('Deployment').createId(req.body.deploymentId);
		}

		const deployment = await Model.getModel('Deployment').findOne(deploymentQuery);

		const executeAfter = Sugar.Date.create(req.body.executeAfter);
		if (!Sugar.Date.isValid(executeAfter)) {
			this.log('ERROR: Invalid executeAfter date expression', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_execute_after_date`));
		}

		return {
			appId: lambda._appId,
			execution: {
				triggerType: 'CRON',
				lambdaId: lambda.id,
				deploymentId: deployment.id,
				executeAfter: executeAfter.toString(),
				metadata: req.body.metadata,
			},
		};
	}

	async _exec(req, res, validate) {
		return await Model.getModel('LambdaExecution').add(validate.execution, validate.appId);
	}
}
routes.push(ScheduleLambdaExecution);

/**
 * @class EditLambdaDeployment
 */
class EditLambdaDeployment extends Route {
	constructor(services) {
		super('lambda/:id/deployment', 'EDIT LAMBDA DEPLOYMENT', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.ADD;
	}

	async _validate(req, res, token) {
		try {
			const branch = (req.body?.branch) ? req.body.branch : null;
			const hash = (req.body?.hash) ? req.body.hash : null;
			if (!req.body) {
				this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `no_data_posted`));
			}
			if (!branch) {
				this.log(`[${this.name}] Missing required deployment branch`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_deployment_branch`));
			}
			if (!hash) {
				this.log(`[${this.name}] Missing required deployment hash`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_deployment_hash`));
			}

			const lambda = await this.model.findById(req.params.id);
			if (!lambda) {
				this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
			}

			const entryFilePath = (req.body.entryFile) ? req.body.entryFile : lambda.git.entryFile;
			const entryPoint = (req.body.entryPoint) ? req.body.entryPoint : lambda.git.entryPoint;
			const lambdaDeployInfo = {
				branch,
				hash,
				entryFilePath,
				entryPoint,
			};
			await this.model.pullLambdaCode(lambda, lambdaDeployInfo);

			return Promise.resolve({
				hash: req.body.hash,
				branch: req.body.body,
				lambda,
			});
		} catch (err: any) {
			this.log(`[${this.name}] ${err.message}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, err.message));
		}
	}

	_exec(req, res, validate) {
		return this.model.setDeployment(validate.lambda.id, {
			'git.branch': validate.branch,
			'git.hash': validate.hash,
		});
	}
}
routes.push(EditLambdaDeployment);

/**
 * @class SetLambdaPolicyProperties
 */
class SetLambdaPolicyProperties extends Route {
	constructor(services) {
		super('lambda/:id/policy-property', 'SET LAMBDA POLICY PROPERTY', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getModel('Activity').Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const app = req.authApp;
		if (!app) {
			this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = await this.model.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
		if (!policyCheck.passed) {
			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
		}

		const lambdaToken = await Model.getModel('Token').findOne({
			_lambdaId: this.model.createId(req.params.id),
		});
		if (!lambdaToken) {
			this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `can_not_find_lambda_token`));
		}

		return Promise.resolve(lambdaToken);
	}

	async _exec(req, res, validate) {
		await Model.getModel('Token').setPolicyPropertiesById(validate.id, req.body);
		return true;
	}
}
routes.push(SetLambdaPolicyProperties);

/**
 * @class UpdateLambdaPolicyProperties
 */
class UpdateLambdaPolicyProperties extends Route {
	constructor(services) {
		super('lambda/:id/update-policy-property', 'UPDATE LAMBDA POLICY PROPERTY', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getModel('Activity').Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		const app = req.authApp;
		if (!app) {
			this.log('ERROR: No app associated with the request', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = await this.model.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
		if (!policyCheck.passed) {
			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
		}

		const lambdaToken = await Model.getModel('Token').findOne({
			_lambdaId: this.model.createId(req.params.id),
		});
		if (!lambdaToken) {
			this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `can_not_find_lambda_token`));
		}

		return Promise.resolve({
			token: lambdaToken,
		});
	}

	async _exec(req, res, validate) {
		await Model.getModel('Token').updatePolicyPropertiesById(validate.token, req.body);
		return true;
	}
}
routes.push(UpdateLambdaPolicyProperties);

/**
 * @class ClearLambdaPolicyProperties
 */
class ClearLambdaPolicyProperties extends Route {
	constructor(services) {
		super('lambda/:id/clear-policy-property', 'REMOVE LAMBDA POLICY PROPERTY', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.PUT;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.getModel('Activity').Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = await this.model.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const lambdaToken = await Model.getModel('Token').findOne({
			_lambdaId: this.model.createId(req.params.id),
		});
		if (!lambdaToken) {
			this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `can_not_find_lambda_token`));
		}

		return Promise.resolve({
			token: lambdaToken,
		});
	}

	async _exec(req, res, validate) {
		await Model.getModel('Token').clearPolicyPropertiesById(validate.token);
		return true;
	}
}
routes.push(ClearLambdaPolicyProperties);

/**
 * @class DeleteLambda
 */
class DeleteLambda extends Route {
	constructor(services) {
		super('lambda/:id', 'DELETE LAMBDA', services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.DEL;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req) {
		if (!req.params.id) {
			this.log('ERROR: Missing required lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
		}

		const lambda = await this.model.findById(req.params.id);
		if (!lambda) {
			this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
		}

		const lambdaToken = await Model.getModel('Token').findOne({_lambdaId: lambda.id});
		if (!lambdaToken) {
			this.log(`ERROR: Could not fetch lambda's token`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `could_fetch_lambda_token`));
		}

		return {
			lambda,
			token: lambdaToken,
		};
	}

	async _exec(req, res, validate) {
		// TODO make sure that the git repo is not used by any other lambdas before deleteing it
		await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${validate.lambda.id}`);
		await this.model.rm(validate.lambda.id);
		await Model.getModel('Token').rm(validate.token.id);
		return true;
	}
}
routes.push(DeleteLambda);

/**
 * @class LambdaCount
 */
class LambdaCount extends Route {
	constructor(services) {
		super(`lambda/count`, `COUNT LAMBDAS`, services, Model.getModel('Lambda'));
		this.verb = Route.Constants.Verbs.SEARCH;
		this.authType = Route.Constants.Type.APP;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT LAMBDAS`;
		this.activityBroadcast = false;
	}

	async _validate(req, res, token) {
		const result = {
			query: {},
		};

		let query: any = {};

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
routes.push(LambdaCount);

/**
 * @type {*[]}
 */
export default routes;
