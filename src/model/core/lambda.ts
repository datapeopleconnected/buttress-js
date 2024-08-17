'use strict';

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
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import {exec as cpExec} from 'node:child_process';

const exec = util.promisify(cpExec);

import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;

import Sugar from 'sugar';
import StandardModel from '../type/standard';
import * as Helpers from '../../helpers';
import Logging from '../../helpers/logging';

export default class LambdaSchemaModel extends StandardModel {

	name: string;

	constructor(services) {
		const schema = LambdaSchemaModel.Schema;
		super(schema, null, services);

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
								__required: false,
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
								__required: false,
								__allowUpdate: true,
							},
							useCallerToken: {
								__type: 'boolean',
								__default: false,
								__required: false,
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
								__required: false,
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
	async add(body, internals?: any) {
		const {auth, app} = internals;

		await this.gitCloneLambda(body, auth, app);

		let deployments: any[] = [];
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
			_appId: app.id,
		});
		const lambda: any = await Helpers.streamFirst(rxsLambda);

		const deployment = await this.__modelManager.Deployment.add({
			lambdaId: lambda.id,
			hash: lambda.git.hash,
			branch: lambda.git.branch,
			deployedAt: Sugar.Date.create('now'),
		}, app.id);

		// Check if lambda has a cron trigger, if it does then create a execution doc.
		const cronTrigger = lambda.trigger.filter((t) => t.type === 'CRON');
		for await (const trigger of cronTrigger) {
			if (trigger.cron.periodicExecution) {
				await this.__modelManager.LambdaExecution.add({
					triggerType: 'CRON',
					lambdaId: lambda.id,
					deploymentId: deployment.id,
					executeAfter: Sugar.Date.create(),
					nextCronExpression: trigger.cron.periodicExecution,
				}, lambda._appId);
			}
		}

		auth.type = this.__modelManager.Token.Constants.Type.LAMBDA;
		await this.__modelManager.Token.add(auth, {
			_appId: app.id,
			_lambdaId: lambda.id,
		});

		await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${lambda.git.hash}; mv lambda-${lambda.name} lambda-${lambda.git.hash}`);

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
				lambdaExists = await this.__modelManager.Lambda.findOne({
					'trigger.apiEndpoint.url': {
						$eq: apiTrigger.apiEndpoint.url,
					},
					'_appId': {
						$eq: app.id,
					},
				});
			}

			if (lambdaExists) {
				Logging.logError(`[${this.name}] Lambda with the same API url already exists`);
				throw new Helpers.Errors.RequestError(400, `duplicate_item`);
			}

			await this.gitFolderClone(gitHash, branch, name, url, entryFile);
		} catch (err) {
			if (fs.existsSync(`${Config.paths.lambda.code}/lambda-${name}`)) {
				await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${name}`);
			}

			if (err instanceof Error) {
				Logging.logError(`[${this.name}] ${err.message}`);
			}
			throw err;
		}
	}

	async gitFolderClone(gitHash, branch, name, url, entryFile) {
		// Check to see if the requested git hash exists or just make sure the branch exists if we're using HEAD.
		const exPramChkBranch = (gitHash !== 'HEAD') ? `git branch ${branch} --contains ${gitHash}` : `git ls-remote --heads origin ${branch}`;
		const result = await exec(`cd ${Config.paths.lambda.code}; git clone --filter=blob:limit=1m ${url} lambda-${name};
			cd lambda-${name}; ${exPramChkBranch}`);
		if (!result.stdout) {
			if (fs.existsSync(`${Config.paths.lambda.code}/lambda-${name}`)) {
				await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${name}`);
			}
			Logging.logError(`[${this.name}] Lambda hash:${gitHash} does not exist on ${branch} branch`);
			throw new Helpers.Errors.RequestError(400, `missing_field`);
		}

		// TODO it should only clone the lambda file from the repo
		await exec(`cd ${Config.paths.lambda.code}/lambda-${name}; git checkout ${gitHash}`);
	}

	async pullLambdaCode(lambda, lambdaDeployInfo: any = {}) {
		try {
			const branch = (lambdaDeployInfo.branch) ? lambdaDeployInfo.branch : lambda.git.branch;
			const gitHash = (lambdaDeployInfo.hash) ? lambdaDeployInfo.hash : lambda.git.hash;
			const entryFilePath = (lambdaDeployInfo.entryFilePath) ? lambdaDeployInfo.entryFilePath : lambda.git.entryFile;
			const entryPoint = (lambdaDeployInfo.entryPoint) ? lambdaDeployInfo.entryPoint : lambda.git.entryPoint;

			// TODO: Refactor below code into a seperate file for handling managment of lambda deployments.
			const lambdaFolderName = `lambda-${gitHash}`;
			if (!fs.existsSync(`${Config.paths.lambda.code}/${lambdaFolderName}`)) {
				await this.gitFolderClone(gitHash, branch, lambda.name, lambda.git.url, entryFilePath);
				await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${lambda.git.hash}; mv lambda-${lambda.name} lambda-${lambda.git.hash}`);
			} else {
				await exec(`cd ${Config.paths.lambda.code}/${lambdaFolderName}; git fetch`);
				const checkoutRes = await exec(`cd ${Config.paths.lambda.code}/${lambdaFolderName}; git checkout ${branch}`);
				if (!checkoutRes.stdout) {
					Logging.log(`[${this.name}] Lambda ${branch} does not exist`);
					return Promise.reject(new Helpers.Errors.RequestError(400, `branch_${branch}_does_not_exist_for_lambda`));
				}

				await exec(`cd ${Config.paths.lambda.code}/${lambdaFolderName}; git pull`);
				const results = await exec(`cd ${Config.paths.lambda.code}/${lambdaFolderName}; git branch ${branch} --contains ${gitHash}`);
				if (!results.stdout) {
					Logging.log(`[${this.name}] Lambda hash:${gitHash} does not exist on ${branch} branch`);
					return Promise.reject(new Helpers.Errors.RequestError(400, `lambda_${gitHash}_does_not_exist_on_branch_${branch}`));
				}

				await exec(`cd ${Config.paths.lambda.code}/${lambdaFolderName}; git checkout ${gitHash}`);

				const entryDir = path.dirname(entryFilePath);
				const lambdaDir = `${Config.paths.lambda.code}/${lambdaFolderName}/./${entryDir}`; // Ugly `/./` because I am lazy
				const files = fs.readdirSync(lambdaDir);
				const entryFile = entryFilePath.split('/').pop();
				if (entryFilePath && !files.includes(entryFile)) {
					Logging.log(`[${this.name}] No such file ${entryFile} - ${lambda.name} ${gitHash} ${branch}`);
					throw new Helpers.Errors.RequestError(404, `entry_file_not_found`);
				}

				for await (const file of files) {
					if (path.extname(file) !== '.js') continue;

					const content = fs.readFileSync(`${lambdaDir}/${file}`, 'utf8');
					if (entryFile === file && entryPoint && !content.includes(entryPoint)) {
						Logging.log(`[${this.name}] No such function ${entryPoint} - ${lambda.name}`);
						throw new Helpers.Errors.RequestError(404, `entry_point_not_found`);
					}
				}
			}

			const deployment = await this.__modelManager.Deployment.findOne({
				lambdaId: this.createId(lambda.id),
				hash: gitHash,
			});
			if (!deployment) {
				await this.__modelManager.Deployment.add({
					lambdaId: lambda.id,
					hash: gitHash,
					branch: branch,
				}, lambda._appId);
			} else {
				await this.__modelManager.Deployment.update({
					id: this.__modelManager.Deployment.createId(deployment.id),
				}, {$set: {deployedAt: Sugar.Date.create('now')}});
			}
		} catch (err) {
			if (fs.existsSync(`${Config.paths.lambda.code}/lambda-${lambda.name}`)) {
				await exec(`cd ${Config.paths.lambda.code}; rm -rf lambda-${lambda.name}`);
			}

			if (err instanceof Error) {
				Logging.logError(`[${this.name}] ${err.message}`);
			}
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
}