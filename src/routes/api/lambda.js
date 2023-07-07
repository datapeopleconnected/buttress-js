/* eslint-disable max-lines */
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
const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const Config = require('node-env-obj')();
const ObjectId = require('mongodb').ObjectId;
const Sugar = require('sugar');

// const AccessControl = require('../../access-control');
const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');

const routes = [];

const Datastore = require('../../datastore');

const lambdaConsole = {
	'console.log': 'lambda.log',
	'console.info': 'lambda.log',
	'console.debug': 'lambda.logDebug',
	'console.warn': 'lambda.logWarn',
	'console.error': 'lambda.logError',
	'console.dir': '',
};

/**
 * @class GetLambda
 */
class GetLambda extends Route {
	constructor(nrp, redisClient) {
		super('lambda/:id', 'GET LAMBDA', nrp, redisClient);
		this.verb = Route.Constants.Verbs.GET;
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

		const lambda = await Model.Lambda.findById(id);
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
	constructor(nrp) {
		super('lambda', 'GET LAMBDA LIST', nrp);
		this.verb = Route.Constants.Verbs.GET;
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
					return Promise.reject(new Helpers.RequestError(400, 'invalid_id'));
				}
			});
		}

		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		const ids = req.body.ids;
		if (ids && ids.length > 0) {
			return Model.Lambda.findByIds(ids);
		}

		return Model.Lambda.findAll(req.authApp.id, req.token);
	}
}
routes.push(GetLambdaList);

/**
 * @class SearchLambdaList
 */
class SearchLambdaList extends Route {
	constructor(nrp) {
		super('lambda', 'SEARCH LAMBDA LIST', nrp);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		const result = {
			query: {
				$and: [],
			},
		};

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			result.query.$and.push(req.body.query);
		}

		result.query = Model.Lambda.parseQuery(result.query, {}, Model.Lambda.flatSchemaData);
		return result;
	}

	_exec(req, res, validate) {
		return Model.Lambda.find(validate.query);
	}
}
routes.push(SearchLambdaList);

/**
 * @class AddLambda
 */
class AddLambda extends Route {
	constructor(nrp) {
		super('lambda', 'ADD LAMBDA', nrp);
		this.verb = Route.Constants.Verbs.POST;
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
			const token = await this._getToken(req);
			if (token && token._appId) {
				appId = token._appId;
			}
			if (token && token._lambdaId) {
				const lambda = await Model.Lambda.findById(token._lambdaId);
				appId = lambda._appId;
			}
			if (token && token._userId) {
				const user = await Model.User.findById(token._userId);
				appId = user._appId;
			}
		}

		const app = await Model.App.findById(appId);
		const lambda = await Model.Lambda.add(req.body.lambda, req.body.auth, app);
		this._nrp.emit('app-lambda:path-mutation-bust-cache', lambda);

		return lambda;
	}
}
routes.push(AddLambda);

/**
 * @class UpdateLambda
 */
class UpdateLambda extends Route {
	constructor(nrp) {
		super('lambda/:id', 'UPDATE LAMBDA', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const {validation, body} = Model.Lambda.validateUpdate(req.body);
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

			Model.Lambda.exists(req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid LAMBDA ID', Route.LogLevel.ERR);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return Model.Lambda.updateByPath(req.body, req.params.id, 'Lambda');
	}
}
routes.push(UpdateLambda);

/**
 * @class BulkUpdateLambda
 */
class BulkUpdateLambda extends Route {
	constructor(nrp) {
		super('lambda/bulk/update', 'BULK UPDATE LAMBDA', nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		for await (const item of req.body) {
			const {validation, body} = Model.Lambda.validateUpdate(item.body);
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

			const exists = Model.Lambda.exists(item.id);
			if (!exists) {
				this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
			}
		}

		return req.body;
	}

	async _exec(req, res, validate) {
		for await (const item of validate) {
			await Model.Lambda.updateByPath(item.body, item.id, 'Lambda');
		}
		return true;
	}
}
routes.push(BulkUpdateLambda);

/**
 * @class EditLambdaDeployment
 */
class EditLambdaDeployment extends Route {
	constructor(nrp) {
		super('lambda/:id/deployment', 'EDIT LAMBDA DEPLOYMENT', nrp);
		this.verb = Route.Constants.Verbs.PUT;
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

			const lambda = await Model.Lambda.findById(req.params.id);
			if (!lambda) {
				this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
			}
			const entryFilePath = (req.body.entryFile) ? req.body.entryFile : lambda.git.entryFile;
			const entryPoint = (req.body.entryPoint) ? req.body.entryPoint : lambda.git.entryPoint;

			await exec(`cd ${Config.paths.lambda.code}/lambda-${req.params.id}; git fetch`);
			const checkoutRes = await exec(`cd ${Config.paths.lambda.code}/lambda-${req.params.id}; git checkout ${branch}`);
			if (!checkoutRes.stdout) {
				this.log(`[${this.name}] Lambda ${branch} does not exist`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `branch_${branch}_does_not_exist_for_lambda`));
			}

			await exec(`cd ${Config.paths.lambda.code}/lambda-${req.params.id}; git pull`);
			const results = await exec(`cd ${Config.paths.lambda.code}/lambda-${req.params.id}; git branch ${branch} --contains ${hash}`);
			if (!results.stdout) {
				this.log(`[${this.name}] Lambda hash:${hash} does not exist on ${branch} branch`, Route.LogLevel.ERR);
				return Promise.reject(new Helpers.Errors.RequestError(400, `lambda_${hash}_does_not_exist_on_branch_${branch}`));
			}

			await exec(`cd ${Config.paths.lambda.code}/lambda-${req.params.id}; git checkout ${hash}`);


			const entryDir = path.dirname(entryFilePath);
			const lambdaDir = `${Config.paths.lambda.code}/lambda-${req.params.id}/./${entryDir}`; // Ugly `/./` because I am lazy
			const files = fs.readdirSync(lambdaDir);
			const entryFile = entryFilePath.split('/').pop();
			if (entryFilePath && !files.includes(entryFile)) {
				this.log(`[${this.name}] No such file ${entryFile} - ${lambda.name} ${hash} ${branch}`, Route.LogLevel.ERR);
				throw new Helpers.Errors.RequestError(404, `entry_file_not_found`);
			}

			for await (const file of files) {
				if (path.extname(file) !== '.js') continue;

				const content = fs.readFileSync(`${lambdaDir}/${file}`, 'utf8');
				for await (const log of Object.keys(lambdaConsole)) {
					if (entryFile === file && entryPoint && !content.includes(entryPoint)) {
						this.log(`[${this.name}] No such function ${entryPoint} - ${lambda.name}`, Route.LogLevel.ERR);
						throw new Helpers.Errors.RequestError(404, `entry_point_not_found`);
					}

					if (content.includes(log)) {
						await exec(`cd ${Config.paths.lambda.code}/lambda-${req.params.id}; git checkout ${lambda.git.hash}`);
						throw new Helpers.Errors.RequestError(400, `unsupported use of console, use ${lambdaConsole[log]} instead`);
					}
				}
			}

			return Promise.resolve(true);
		} catch (err) {
			this.log(`[${this.name}] ${err.message}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, err.message));
		}
	}

	async _exec(req, res, validate) {
		const deployment = await Model.Deployment.findOne({
			lambdaId: Model.Lambda.createId(req.params.id),
			hash: req.body.hash,
		});

		const lambdaLastDeployment = await Model.Lambda.setDeployment(req.params.id, {
			'git.branch': req.body.branch,
			'git.hash': req.body.hash,
		});

		if (!deployment) {
			await Model.Deployment.add({
				lambdaId: req.params.id,
				hash: req.body.hash,
				branch: req.body.branch,
			});
		} else {
			await Model.Deployment.update({
				id: Model.Deployment.createId(deployment.id),
			}, {$set: {deployedAt: Sugar.Date.create('now')}});
		}

		return lambdaLastDeployment;
	}
}
routes.push(EditLambdaDeployment);

/**
 * @class SetLambdaPolicyProperties
 */
class SetLambdaPolicyProperties extends Route {
	constructor(nrp) {
		super('lambda/:id/policyProperty', 'SET LAMBDA POLICY PROPERTY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
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

		const exists = await Model.Lambda.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
		if (!policyCheck.passed) {
			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
		}

		const lambdaToken = await Model.Token.findOne({
			_lambdaId: Model.Lambda.createId(req.params.id),
		});
		if (!lambdaToken) {
			this.log('ERROR: Can not find a token for lambda', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `can_not_find_lambda_token`));
		}

		return Promise.resolve(lambdaToken);
	}

	async _exec(req, res, validate) {
		await Model.Token.setPolicyPropertiesById(validate.id, req.body);
		return true;
	}
}
routes.push(SetLambdaPolicyProperties);

/**
 * @class UpdateLambdaPolicyProperties
 */
class UpdateLambdaPolicyProperties extends Route {
	constructor(nrp) {
		super('lambda/:id/updatePolicyProperty', 'UPDATE LAMBDA POLICY PROPERTY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
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

		const exists = await Model.Lambda.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, req.body);
		if (!policyCheck.passed) {
			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_field`));
		}

		const lambdaToken = await Model.Token.findOne({
			_lambdaId: Model.Lambda.createId(req.params.id),
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
		await Model.Token.updatePolicyPropertiesById(validate.token, req.body);
		return true;
	}
}
routes.push(UpdateLambdaPolicyProperties);

/**
 * @class ClearLambdaPolicyProperties
 */
class ClearLambdaPolicyProperties extends Route {
	constructor(nrp) {
		super('lambda/:id/clearPolicyProperty', 'REMOVE LAMBDA POLICY PROPERTY', nrp);
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityBroadcast = true;
	}

	async _validate(req, res, token) {
		if (!req.body) {
			this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_field`));
		}

		const exists = await Model.Lambda.exists(req.params.id);
		if (!exists) {
			this.log('ERROR: Invalid lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_id`));
		}

		const lambdaToken = await Model.Token.findOne({
			_lambdaId: Model.Lambda.createId(req.params.id),
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
		await Model.Token.clearPolicyPropertiesById(validate.token);
		return true;
	}
}
routes.push(ClearLambdaPolicyProperties);

/**
 * @class DeleteLambda
 */
class DeleteLambda extends Route {
	constructor(nrp) {
		super('lambda/:id', 'DELETE LAMBDA', nrp);
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.WRITE;
	}

	async _validate(req) {
		if (!req.params.id) {
			this.log('ERROR: Missing required lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `missing_required_lambda_id`));
		}

		const lambda = await Model.Lambda.findById(req.params.id);
		if (!lambda) {
			this.log('ERROR: Invalid Lambda ID', Route.LogLevel.ERR);
			return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_lambda_id`));
		}

		const lambdaToken = await Model.Token.findOne({_lambdaId: lambda.id});
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
		await Model.Lambda.rm(validate.lambda);
		await Model.Token.rm(validate.token);
		return true;
	}
}
routes.push(DeleteLambda);

/**
 * @class LambdaCount
 */
class LambdaCount extends Route {
	constructor(nrp) {
		super(`lambda/count`, `COUNT LAMBDAS`, nrp);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.SEARCH;

		this.activityDescription = `COUNT LAMBDAS`;
		this.activityBroadcast = false;

		this.model = Model.Lambda;
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
		return Model.Lambda.count(validateResult.query);
	}
}
routes.push(LambdaCount);

/**
 * @type {*[]}
 */
module.exports = routes;
