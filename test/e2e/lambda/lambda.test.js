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
const {describe, it, before, after} = require('mocha');
const assert = require('assert');

const Config = require('node-env-obj')();

const {createApp, createLambda, updatePolicyPropertyList, bjsReq, bjsReqPost} = require('../../helpers');

const BootstrapRest = require('../../../dist/bootstrap-rest');
const BootstrapLambda = require('../../../dist/bootstrap-lambda');

let LAMBDA_PROCESS = null;
let REST_PROCESS = null;
const ENDPOINT = `https://test.local.buttressjs.com`;

const testEnv = {
	apps: {},
	lambdas: {},
	exec: {},
};

const getExecResult = async (url, query, attempt=0) => {
	if (attempt > 6) return;

	const [result] = await bjsReq({
		url,
		method: 'SEARCH',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({query}),
	}, testEnv.apps.app1.token);
	if (result) return result;

	await new Promise((resolve) => setTimeout(resolve, 2000));
	return getExecResult(url, query, attempt + 1);
};

// This suite of tests will run against the REST API
describe('Lambda', async () => {
	before(async function() {
		LAMBDA_PROCESS = new BootstrapLambda();
		REST_PROCESS = new BootstrapRest();

		await REST_PROCESS.init();
		await LAMBDA_PROCESS.init();

		testEnv.apps.app1 = await createApp(ENDPOINT, 'Test Lambda App', 'test-lambda-app');
		await updatePolicyPropertyList(ENDPOINT, {
			lambda: ['TEST_ACCESS'],
		}, testEnv.apps.app1.token);
	});

	after(async function() {
		await LAMBDA_PROCESS.clean();
		await REST_PROCESS.clean();
	});

	describe('Basic', async () => {
		it('Should create a lambda \'hello-world\' in the test app', async function() {
			testEnv.lambdas['api-hello-world'] = await createLambda(ENDPOINT, {
				name: 'api-hello-world',
				type: 'PUBLIC',
				git: {
					url: Config.paths.root,
					branch: 'develop',
					hash: 'HEAD',
					entryFile: 'test/data/lambda/hello-world.js',
					entryPoint: 'execute',
				},
				trigger: [{
					type: 'API_ENDPOINT',
					apiEndpoint: {
						method: 'GET',
						url: 'hello/world',
						type: 'SYNC',
					},
				}],
			}, {
				domains: ['localhost'],
				permissions: [{route: '*', permission: '*'}],
				policyProperties: {lambda: 'TEST_ACCESS'},
			}, testEnv.apps.app1.token);
		});

		// TODO: Basics tests to do with the lambda process
	});

	describe('Trigger', async () => {
		describe('Cron', async () => {
			it('Should create a cron lambda', async function() {
				testEnv.lambdas['cron-test'] = await createLambda(ENDPOINT, {
					name: 'cron-test',
					type: 'PUBLIC',
					git: {
						url: Config.paths.root,
						branch: 'develop',
						hash: 'HEAD',
						entryFile: 'test/data/lambda/hello-world.js',
						entryPoint: 'execute',
					},
					trigger: [{
						type: 'CRON',
						cron: {
							executionTime: 'now',
							periodicExecution: 'in 5 minutes',
							status: 'PENDING',
						},
					}],
				}, {
					domains: ['localhost'],
					permissions: [{route: '*', permission: '*'}],
					policyProperties: {lambda: 'TEST_ACCESS'},
				}, testEnv.apps.app1.token);
			});

			it('Should change the cron execution status from pending to complete.', async function() {
				this.timeout(20000);

				const result = await getExecResult(`${ENDPOINT}/api/v1/lambda-execution`, {
					lambdaId: {
						$eq: testEnv.lambdas['cron-test'].id,
					},
					status: {
						$eq: 'COMPLETE',
					},
				});
				assert.notEqual(result, undefined);
				assert.strictEqual(result.status, 'COMPLETE');
			});

			it('Should create a single lambda exeuction.', async function() {
				const exec = await bjsReqPost(`${ENDPOINT}/api/v1/lambda/${testEnv.lambdas['cron-test'].id}/schedule`, {
					executeAfter: new Date().toISOString(),
				}, testEnv.apps.app1.token);

				assert.notEqual(exec, undefined);
				assert.strictEqual(exec.lambdaId, testEnv.lambdas['cron-test'].id);
				assert.strictEqual(exec.status, 'PENDING');

				testEnv.exec['cron-test-schedule'] = exec;
			});

			it('Should change the scheduled execution status from pending to complete.', async function() {
				this.timeout(20000);

				const result = await getExecResult(`${ENDPOINT}/api/v1/lambda-execution`, {
					id: {
						$eq: testEnv.exec['cron-test-schedule'].id,
					},
					status: {
						$eq: 'COMPLETE',
					},
				});
				assert.notEqual(result, undefined);
				assert.strictEqual(result.status, 'COMPLETE');
			});
		});

		describe('Path Mutation', async () => {
			it('Should create a path mutation lambda', async function() {
				testEnv.lambdas['path-mutation'] = await createLambda(ENDPOINT, {
					name: 'path-mutation',
					type: 'PUBLIC',
					git: {
						url: Config.paths.root,
						branch: 'develop',
						hash: 'HEAD',
						entryFile: 'test/data/lambda/hello-world.js',
						entryPoint: 'execute',
					},
					trigger: [{
						type: 'PATH_MUTATION',
						pathMutation: {
							'paths': [`apps.${testEnv.apps.app1.id}.name`],
						},
					}],
				}, {
					domains: ['localhost'],
					permissions: [{route: '*', permission: '*'}],
					policyProperties: {lambda: 'TEST_ACCESS'},
				}, testEnv.apps.app1.token);
			});

			it(`Should trigger the path mutation lambda when the app name is changed`, async function() {
				this.timeout(20000);

				const [updateResult] = await bjsReq({
					url: `${ENDPOINT}/api/v1/app/${testEnv.apps.app1.id}`,
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify([{
						path: 'name',
						value: 'Test Lambda App 2',
					}]),
				}, testEnv.apps.app1.token);

				assert.strictEqual(updateResult.type, 'scalar');
				assert.strictEqual(updateResult.path, 'name');
				assert.strictEqual(updateResult.value, 'Test Lambda App 2');

				// Verify path mutation lambda ran
				const verifyLambdaRan = await getExecResult(`${ENDPOINT}/api/v1/lambda-execution`, {
					lambdaId: {
						$eq: testEnv.lambdas['path-mutation'].id,
					},
					status: {
						$eq: 'COMPLETE',
					},
				});
				assert.notEqual(verifyLambdaRan, undefined);
				assert.strictEqual(verifyLambdaRan.status, 'COMPLETE');
			});
		});

		describe('API Endpoint', async () => {
			it('Should receive 200 from \'hello-world\' lambda', async function() {
				await bjsReq({
					url: `${ENDPOINT}/api/v1/lambda/${testEnv.apps.app1.apiPath}/hello/world`,
					method: 'GET',
				}, testEnv.apps.app1.token);
			});
		});
	});
});
