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
const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const Config = require('node-env-obj')();
const Sugar = require('sugar');
const SchemaModel = require('../schemaModel');
const Helpers = require('../../helpers');
const Model = require('../');
const Logging = require('../../logging');

const lambdaConsole = {
	'console.log': 'lambda.log',
	'console.info': 'lambda.log',
	'console.debug': 'lambda.logDebug',
	'console.warn': 'lambda.logWarn',
	'console.error': 'lambda.logError',
	'console.dir': '',
};
class LambdaSchemaModel extends SchemaModel {
	constructor(nrp) {
		const schema = LambdaSchemaModel.Schema;
		super(schema, null, nrp);

		this.name = 'LAMBDA';
	}

	static get Schema() {
		return {
			name: 'lambda',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				name: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
				type: {
					__type: 'string',
					__default: 'PRIVATE',
					__enum: [
						'PRIVATE',
						'PUBLIC',
					],
					__required: true,
					__allowUpdate: true,
				},
				executable: {
					__type: 'boolean',
					__default: true,
					__required: false,
					__allowUpdate: true,
				},
				deployments: {
					__type: 'array',
					__allowUpdate: true,
					__schema: {
						hash: {
							__type: 'string',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
						deployedAt: {
							__type: 'date',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
					},
				},
				git: {
					url: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					hash: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					branch: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					entryFile: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					entryPoint: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
				},
				trigger: {
					__type: 'array',
					__allowUpdate: true,
					__schema: {
						type: {
							__type: 'string',
							__default: 'CRON',
							__enum: [
								'CRON',
								'PATH_MUTATION',
								'API_ENDPOINT',
							],
							__required: true,
							__allowUpdate: true,
						},
						cron: {
							executionTime: {
								__type: 'string',
								__default: null,
								__required: false,
								__allowUpdate: true,
							},
							periodicExecution: {
								__type: 'string',
								__default: null,
								__required: false,
								__allowUpdate: true,
							},
							status: {
								__type: 'string',
								__default: 'PENDING',
								__enum: [
									'PENDING',
									'RUNNING',
									'ERROR',
								],
								__required: true,
								__allowUpdate: true,
							},
						},
						apiEndpoint: {
							method: {
								__type: 'string',
								__default: 'GET',
								__enum: [
									'GET',
									'POST',
								],
								__required: false,
								__allowUpdate: true,
							},
							url: {
								__type: 'string',
								__default: null,
								__required: false,
								__allowUpdate: true,
							},
							type: {
								__type: 'string',
								__default: 'ASYNC',
								__enum: [
									'ASYNC',
									'SYNC',
								],
								__required: true,
								__allowUpdate: true,
							},
							redirect: {
								__type: 'boolean',
								__default: false,
								__required: false,
								__allowUpdate: true,
							},
						},
						pathMutation: {
							paths: {
								__type: 'array',
								__itemtype: 'string',
								__required: true,
								__allowUpdate: true,
							},
						},
					},
				},
				metadata: {
					__type: 'array',
					__allowUpdate: true,
					__schema: {
						key: {
							__type: 'string',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
						value: {
							__type: 'string',
							__default: null,
							__required: true,
							__allowUpdate: true,
						},
					},
				},
				_appId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
			},
		};
	}


	/**
	 * @param {Object} body - body passed through from a POST request
	 * @param {Object} auth - OPTIONAL authentication details for a lambda token
	 * @param {Object} app - Lambda app
	 * @return {Promise} - fulfilled with lambda Object when the database request is completed
	 */
	async add(body, auth, app) {
		await this.gitCloneLambda(body, auth, app);

		let deployments = [];
		if (body.git.deployments) {
			deployments = body.git.deployments;
		}

		deployments.push({
			hash: (body.git.hash) ? body.git.hash : null,
			deployedAt: Sugar.Date.create('now'),
		});

		const lambdaBody = {
			name: (body.name) ? body.name : null,
			type: (body.type) ? body.type : null,
			deployments: deployments,

			git: {
				url: (body.git.url) ? body.git.url : null,
				hash: (body.git.hash) ? body.git.hash : null,
				branch: (body.git.branch) ? body.git.branch : null,
				entryFile: (body.git.entryFile) ? body.git.entryFile : null,
				entryPoint: (body.git.entryPoint) ? body.git.entryPoint : null,
			},

			trigger: (body.trigger) ? body.trigger : [],
			metadata: (body.metadata) ? body.metadata : [],
		};

		const rxsLambda = await super.add(lambdaBody, {
			_appId: app._id,
		});
		const lambda = await Helpers.streamFirst(rxsLambda);

		const deployment = {
			lambdaId: lambda._id,
			hash: lambda.git.hash,
			branch: lambda.git.branch,
			deployedAt: Sugar.Date.create('now'),
		};

		await Model.Deployment.add(deployment);

		auth.type = Model.Token.Constants.Type.LAMBDA;
		await Model.Token.add(auth, {
			_appId: Model.authApp._id,
			_lambdaId: lambda._id,
		});

		await exec(`cd ${Config.paths.lambda.code}; mv lambda-${lambda.name} lambda-${lambda._id}`);

		return lambda;
	}


	/**
	 * Cloning lambda project
	 * @param {Object} lambda
	 * @param {Object} auth
	 * @param {Object} app
	 * @return {Promise}
	 */
	async gitCloneLambda(lambda, auth, app) {
		const name = lambda?.name;
		const url = lambda?.git?.url;
		const branch = lambda?.git?.branch;
		const gitHash = lambda?.git?.hash;
		const entryFile = lambda?.git?.entryFile;

		try {
			const policyCheck = await Helpers.checkAppPolicyProperty(app.policyPropertiesList, auth.policyProperties);
			if (!policyCheck.passed) {
				Logging.logError(`[${this.name}] ${policyCheck.errMessage}`);
				throw new Helpers.Errors.RequestError(400, `invalid_field`);
			}

			const apiTrigger = lambda.trigger.find((t) => t.type === 'API_ENDPOINT');
			let lambdaExists = null;
			if (apiTrigger && apiTrigger.apiEndpoint.url) {
				lambdaExists = await Model.Lambda.findOne({
					'trigger.apiEndpoint.url': {
						$eq: apiTrigger.apiEndpoint.url,
					},
					'_appId': {
						$eq: app._id,
					},
				});
			}

			if (lambdaExists) {
				Logging.logError(`[${this.name}] Lambda with the same API url already exists`);
				throw new Helpers.Errors.RequestError(400, `duplicate_item`);
			}

			const result = await exec(`cd ${Config.paths.lambda.code}; git clone --filter=blob:limit=1m ${url} lambda-${name};
				cd lambda-${name}; git branch ${branch} --contains ${gitHash}`);
			if (!result.stdout) {
				if (fs.existsSync(`${Config.paths.lambda.code}/lambda-${name}`)) {
					await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${name}`);
				}
				Logging.logError(`[${this.name}] Lambda hash:${gitHash} does not exist on ${branch} branch`);
				throw new Helpers.Errors.RequestError(400, `missing_field`);
			}

			await exec(`cd ${Config.paths.lambda.code}/lambda-${name}; git checkout ${gitHash}`);

			// TODO it should only clone the lambda file from the repo
			const entryDir = path.dirname(entryFile);
			const lambdaDir = `${Config.paths.lambda.code}/lambda-${name}/./${entryDir}`; // Ugly `/./` because I am lazy
			const files = fs.readdirSync(lambdaDir);
			for await (const file of files) {
				if (path.extname(file) !== '.js') continue;

				const content = fs.readFileSync(`${lambdaDir}/${file}`, 'utf8');
				for await (const log of Object.keys(lambdaConsole)) {
					if (content.includes(log)) {
						await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${name}`);
						throw new Helpers.Errors.RequestError(400, `unsupported use of console, use ${lambdaConsole[log]} instead`);
					}
				}
			}
		} catch (err) {
			if (fs.existsSync(`${Config.paths.lambda.code}/lambda-${name}`)) {
				await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${name}`);
			}

			Logging.logError(`[${this.name}] ${err.message}`);
			throw err;
		}
	}

	/**
	 * @param {String} lambdaId - lambda id which needs to be updated
	 * @param {Object} data - lambda new data deplyoment
	 * @return {Promise} - resolves when save operation is completed
	 */
	async setDeployment(lambdaId, data) {
		const lambdaLastDeployment = {
			hash: data['git.hash'],
			deployedAt: Sugar.Date.create('now'),
		};
		await super.updateById(this.createId(lambdaId), {
			$set: data,
		});

		await super.updateById(this.createId(lambdaId), {
			$push: {
				'deployments': lambdaLastDeployment,
			},
		});

		return lambdaLastDeployment;
	}

	/**
	 * @param {ObjectId} appId - id of the App that owns the user
	 * @param {int} token - request token
	 * @return {Promise} - resolves to an array of Apps
	 */
	findAll(appId, token) {
		if (token && token.type === Model.Token.Constants.Type.SYSTEM) {
			return super.find({});
		}

		return super.find({_appId: appId});
	}
}

/**
 * Exports
 */
module.exports = LambdaSchemaModel;
