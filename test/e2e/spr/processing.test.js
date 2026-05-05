/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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
import assert from 'node:assert';

import { io } from 'socket.io-client';
import { describe, it, before, after } from 'mocha';

import NRP from '../../../dist/services/nrp.js';

import Config from '../../config.js';

import {
	bjsReq,
	createApp,
	createLambda,
	createPolicy,
	createPolicyUser,
	updateSchema,
	registerDataSharing,
	extractPolicyPropertyListFromPolicies,
	ENDPOINT,
} from '../../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';
import BootstrapSocketPolicyRouter from '../../../dist/bootstrap-spr.js';
import BootstrapSocket from '../../../dist/bootstrap-socket.js';

// const { default: PolicyTestData } = await import('../../data/policy/index.js');

import PolicyTestData from '../../data/policy/index.js';
import { runStep } from '../helpers.js';

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Processing', async () => {
	const TestPolicies = [
		PolicyTestData['admin-access'],
		PolicyTestData['env-static-value-query'],
		PolicyTestData['env-date-condition'],
		PolicyTestData['env-entity-condition'],
		PolicyTestData['env-user-query'],
		PolicyTestData['env-user-condition'],
		PolicyTestData['lambda-test-access'],
	];

	const PolicyPropertyList = extractPolicyPropertyListFromPolicies(TestPolicies);

	let NRP_INSTANCE = null;

	let REST_PROCESS = null;
	let SPR_PROCESS = null;
	let SOCK_PROCESS = null;

	const DS1_NAME = 'app1-to-app2';
	const DS2_NAME = 'app2-to-app1';

	const testEnv = {
		apps: {},
		users: {},
		lambdas: {},
		sockets: {},
		dataSharing: {},
		tokens: {},
	};

	const subs = {};

	const carsSchema = {
		name: 'car',
		type: 'collection',
		properties: {
			name: {
				__type: 'string',
				__default: null,
				__required: true,
				__allowUpdate: true,
			},
			userId: {
				__type: 'id',
				__default: null,
				__required: true,
				__allowUpdate: true,
			},
			status: {
				__type: 'string',
				__default: "ACTIVE",
				__required: true,
				__allowUpdate: true,
			},
			colour: {
				__type: 'string',
				__default: null,
				__required: false,
				__allowUpdate: true,
			},
			createdAt: {
				__type: 'date',
				__default: "now",
				__required: true,
				__allowUpdate: true,
			}
		},
	};

	const createUserSocket = (name, app = 'app1') => {
		createTokenSocket(name, testEnv.users[name].tokens[0].value, app);
	};

	const createTokenSocket = (name, token, app = 'app1') => {
		testEnv.sockets[name] = io(`${ENDPOINT.SOCK}/${testEnv.apps[app].apiPath}`, {
			auth: { token: token },
			forceNew: true
		});
	};

	const createAppWithSchema = async (ref, name, path, policyProps) => {
		testEnv.apps[ref] = await createApp(ENDPOINT.REST, name, path, policyProps);
		testEnv.apps[ref].schema = await updateSchema(ENDPOINT.REST, [
			carsSchema,
			{
				name: 'selector',
				type: 'collection',
				properties: {
					name: {
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
			}
		], testEnv.apps[ref].token);
	};

	const envAwaitPostedCar = async (ref, tokenId, userId, app) => {
		let addedCar = null;

		let resolve = null;
		const futurePromise = new Promise((r) => resolve = r);

		subs[ref] = await NRP_INSTANCE.subscribe('spr:activity', async (data) => {
			// We've got an event too early.
			if (!addedCar) return;

			const json = JSON.parse(data);
			if (json.activity.schemaName !== 'car' || json.activity.response.id !== addedCar.id) return;

			const result = json.tokens.includes(tokenId);
			// assert(result, 'Token not found in the list of tokens');

			if (result) {
				await subs[ref]();
				delete subs[ref];
				resolve(json);
			}
		});

		[addedCar] = await bjsReq({
			url: `${ENDPOINT.REST}/${app.apiPath}/api/v1/car`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: ref, userId: userId, colour: 'red' }),
		}, app.token);

		await futurePromise;
	};

	const populateTestEnvTokens = async () => {
		const [systemToken] = await bjsReq({
			url: `${ENDPOINT.REST}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: { value: Config.testToken } }),
		}, Config.testToken);
		testEnv.tokens.systemToken = systemToken;

		const [appToken] = await bjsReq({
			url: `${ENDPOINT.REST}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: { value: testEnv.apps.app2.token } }),
		}, Config.testToken);
		testEnv.tokens.appToken = appToken;

		const [dataSharingToken] = await bjsReq({
			url: `${ENDPOINT.REST}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			// TODO: Needs changing, We shouldn't be able to query internal prefixed data.
			body: JSON.stringify({ query: { _appDataSharingId: testEnv.dataSharing[DS2_NAME].id } }),
		}, Config.testToken);
		testEnv.tokens.dataSharingToken = dataSharingToken;

		const [lambdaToken] = await bjsReq({
			url: `${ENDPOINT.REST}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			// TODO: Needs changing, We shouldn't be able to query internal prefixed data.
			body: JSON.stringify({ query: { _lambdaId: testEnv.lambdas['token-test-lambda'].id } }),
		}, Config.testToken);
		testEnv.tokens.lambdaToken = lambdaToken;
	};

	before(async function () {
		this.timeout(60000);

		await runStep('connect NRP', async () => {
			NRP_INSTANCE = new NRP(Config.redis);
			await NRP_INSTANCE.connect();
		}, 'Processing setup');

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, 'Processing setup');

		await runStep('init SPR process', async () => {
			SPR_PROCESS = new BootstrapSocketPolicyRouter();
			await SPR_PROCESS.init();
		}, 'Processing setup');

		await runStep('init SOCK process', async () => {
			SOCK_PROCESS = new BootstrapSocket();
			await SOCK_PROCESS.init();
		}, 'Processing setup');

		// Create an app
		await runStep('create app1 with schema', async () =>
			createAppWithSchema('app1', 'Test SPR 1', 'test-spr-1', PolicyPropertyList)
		, 'Processing setup');

		await runStep('create app1 policies', async () => {
			for await (const policy of TestPolicies) {
				await createPolicy(ENDPOINT.REST, policy, testEnv.apps.app1.token);
			}
		}, 'Processing setup');

		// Create a user to test with
		testEnv.users['basic1'] = await runStep('create user basic1', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'basic1', { adminAccess: true })
		, 'Processing setup');

		testEnv.users['env-test-1'] = await runStep('create user env-test-1', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'env-test-1', { envTest: 1 })
		, 'Processing setup');
		testEnv.users['env-test-2'] = await runStep('create user env-test-2', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'env-test-2', { envTest: 2 })
		, 'Processing setup');
		testEnv.users['env-test-3'] = await runStep('create user env-test-3', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'env-test-3', { envTest: 3 })
		, 'Processing setup');
		testEnv.users['env-test-4'] = await runStep('create user env-test-4', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'env-test-4', { envTest: 4 })
		, 'Processing setup');
		testEnv.users['env-test-5'] = await runStep('create user env-test-5', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'env-test-5', { envTest: 5 })
		, 'Processing setup');

		const usersKeys = Object.keys(testEnv.users);
		const colours = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'brown', 'black', 'white'];
		await runStep('seed app1 car records', async () =>
			bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/add`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(new Array(1000).fill(0).map((val, idx) => ({
					name: `name-${Math.floor(Math.random() * 100)}`,
					colour: colours[Math.floor(Math.random() * colours.length)],
					userId: testEnv.users[usersKeys[Math.floor(Math.random() * usersKeys.length)]].id,
				}))),
			}, testEnv.apps.app1.token)
		, 'Processing setup');

		await runStep('create app1 selector record', async () =>
			bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/selector`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: `example-selector`,
					value: 'red',
				}),
			}, testEnv.apps.app1.token)
		, 'Processing setup');

		testEnv.sockets.app = io(`${ENDPOINT.SOCK}/${testEnv.apps.app1.apiPath}`, {
			auth: { token: testEnv.apps.app1.token },
			forceNew: true
		});

		// Open up some sockets for the users.
		createUserSocket('basic1');

		createUserSocket('env-test-1');
		createUserSocket('env-test-2');
		createUserSocket('env-test-3');
		createUserSocket('env-test-4');
		createUserSocket('env-test-5');
	});

	after(async function () {
		Object.values(testEnv.sockets).forEach((socket) => socket.close());

		Object.values(subs).forEach((fn) => fn());

		await NRP_INSTANCE.quit();

		if (REST_PROCESS) await REST_PROCESS.clean();
		if (SPR_PROCESS) await SPR_PROCESS.clean();
		if (SOCK_PROCESS) await SOCK_PROCESS.clean();
	});

	describe('Basic', () => {
		it('Should receive a `rest:activity` event after a REST post', async function () {
			this.timeout(5000);
			const name = `name-${Math.floor(Math.random() * 100)}`;

			let resolve = null;
			const futurePromise = new Promise((r) => resolve = r);

			// Subscribe to the NRP event and wait for it to be received.
			subs['test1'] = await NRP_INSTANCE.subscribe('rest:activity', async (data) => {
				await subs['test1']();
				delete subs['test1'];
				resolve(JSON.parse(data));
			});

			// Make a request to REST to generate the event.
			await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, userId: testEnv.users.basic1.id }),
			}, testEnv.apps.app1.token);

			// Wait for the sub promise to resolve.
			await futurePromise;
		});

		it('Should generate a `spr:activity` event after a REST post', async function () {
			const name = `name-${Math.floor(Math.random() * 100)}`;

			let resolve = null;
			const futurePromise = new Promise((r) => resolve = r);

			// Subscribe to the NRP event and wait for it to be received.
			subs['test2'] = await NRP_INSTANCE.subscribe('spr:activity', async (dataRaw) => {
				await subs['test2']();
				delete subs['test2'];
				const data = JSON.parse(dataRaw);

				assert(Array.isArray(data.tokens), 'Tokens is not an array');
				assert(data.tokens.length > 0, 'Tokens is empty');

				assert(data.activity.schemaName === 'car', 'Schema name is not car');

				resolve();
			});

			// Make a request to REST to generate the event.
			await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, userId: testEnv.users.basic1.id }),
			}, testEnv.apps.app1.token);

			// Wait for the sub promise to resolve.
			await futurePromise;
		});
	});

	describe('Env', () => {
		it('Should handle a policy with a env inlcuding a static value query', async function () {
			this.timeout(10000);
			const ref = 'env-test-1';
			await envAwaitPostedCar(ref, testEnv.users[ref].tokens[0].id, testEnv.users[ref].id, testEnv.apps.app1);
		});

		it('Should handle a policy with a env inlcuding a date based query', async function () {
			this.timeout(10000);

			const ref = 'env-test-2';
			await envAwaitPostedCar(ref, testEnv.users[ref].tokens[0].id, testEnv.users[ref].id, testEnv.apps.app1);
		});

		it('Should handle a policy with a env inlcuding a entity based query', async function () {
			this.timeout(10000);

			const ref = 'env-test-3';
			await envAwaitPostedCar(ref, testEnv.users[ref].tokens[0].id, testEnv.users[ref].id, testEnv.apps.app1);
		});

		it('Should handle a policy with a env inlcuding a user base query', async function () {
			this.timeout(10000);

			// TODO: If the env prop contains "user" then we need to check the policy against each token rather than in a group.
			const ref = 'env-test-4';
			await envAwaitPostedCar(ref, testEnv.users[ref].tokens[0].id, testEnv.users[ref].id, testEnv.apps.app1);
		});

		it('Should handle a policy with a env inlcuding a user base condition', async function () {
			this.timeout(10000);

			const ref = 'env-test-5';
			await envAwaitPostedCar(ref, testEnv.users[ref].tokens[0].id, testEnv.users[ref].id, testEnv.apps.app1);
		});
	});

	describe('Token Types', () => {
		before(async function () {
			// CI can be slower for app/data-sharing/lambda provisioning in this hook.
			this.timeout(60000);

			testEnv.sockets.super = io(`${ENDPOINT.REST}`, {
				auth: { token: Config.testToken },
				forceNew: true
			});

			await runStep('create app2 with schema', async () =>
				createAppWithSchema('app2', 'Test SPR 2', 'test-spr-2', PolicyPropertyList)
			, 'Token Types setup');

			await runStep('create app2 env-static-value-query policy', async () =>
				createPolicy(ENDPOINT.REST, PolicyTestData['env-static-value-query'], testEnv.apps.app2.token)
			, 'Token Types setup');
			await runStep('create app2 lambda-test-access policy', async () =>
				createPolicy(ENDPOINT.REST, PolicyTestData['lambda-test-access'], testEnv.apps.app2.token)
			, 'Token Types setup');

			testEnv.dataSharing[DS1_NAME] = await runStep('register DS1 app1->app2', async () => registerDataSharing(ENDPOINT.REST, {
				name: DS1_NAME,

				remoteApp: {
					endpoint: ENDPOINT.REST,
					ws: ENDPOINT.SOCK,
					apiPath: testEnv.apps.app2.apiPath,
					token: null,
				},

				policyConfig: [{
					verbs: ['%ALL%'],
					schema: ['%ALL%'],
					query: {
						access: '%FULL_ACCESS%',
					},
				}],
			}, testEnv.apps.app1.token), 'Token Types setup');

			testEnv.dataSharing[DS2_NAME] = await runStep('register DS2 app2->app1', async () => registerDataSharing(ENDPOINT.REST, {
				name: DS2_NAME,

				remoteApp: {
					endpoint: ENDPOINT.REST,
					ws: ENDPOINT.SOCK,
					apiPath: testEnv.apps.app1.apiPath,
					token: testEnv.dataSharing[DS1_NAME].registrationToken,
				},

				policyConfig: [{
					verbs: ['%ALL%'],
					schema: ['%ALL%'],
					query: {
						access: '%FULL_ACCESS%',
					},
				}],
			}, testEnv.apps.app2.token), 'Token Types setup');

			// Pre-create expected lambda dir to skip gitFolderClone
			await runStep('pre-create lambda-HEAD stub', async () => {
				const dir = `${Config.paths.lambda.code}/lambda-HEAD/test/data/lambda`;
				if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

				const src = `${Config.paths.root}/test/data/lambda/hello-world.cjs`;
				const dest = `${dir}/hello-world.cjs`;
				if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
			}, 'Token Types setup');

			testEnv.lambdas['token-test-lambda'] = await runStep('create token-test-lambda', async () => createLambda(ENDPOINT.REST, {
					name: 'token-test-lambda',
					type: 'PUBLIC',
					git: {
						url: Config.paths.root,
						branch: 'develop',
						hash: 'HEAD',
						entryFile: 'test/data/lambda/hello-world.cjs',
						entryPoint: 'execute',
					},
					trigger: [{
						type: 'API_ENDPOINT',
						apiEndpoint: {
							method: 'GET',
							url: 'test/token/hello/world',
							type: 'SYNC',
						},
					}],
				}, {
					domains: ['localhost'],
					permissions: [{route: '*', permission: '*'}],
					policyProperties: { lambda: 'TEST_ACCESS' },
				}, testEnv.apps.app2.token), 'Token Types setup');

			testEnv.users['token-type-test-1'] = await runStep('create token-type-test-1 user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'token-type-test-1', { envTest: 1 })
			, 'Token Types setup');

			await runStep('populate token lookup values', async () => populateTestEnvTokens(), 'Token Types setup');

			// TODO: Connected using IO so tokens are tracked.
			createTokenSocket('token-type-app', testEnv.tokens.appToken.value, 'app2');
			createTokenSocket('token-type-lambda', testEnv.tokens.lambdaToken.value, 'app2');
			createUserSocket('token-type-test-1', 'app2');
		});

		it('Should handle dealing with a token type super', async function () {
			await envAwaitPostedCar('token-super', testEnv.tokens.systemToken.id, null, testEnv.apps.app2);
		});

		it('Should handle dealing with a token type app', async function () {
			await envAwaitPostedCar('token-app', testEnv.tokens.appToken.id, null, testEnv.apps.app2);
		});
		
		it('Should handle dealing with a token type dataSharing', async function () {
			await envAwaitPostedCar('token-dataSharing', testEnv.tokens.dataSharingToken.id, null, testEnv.apps.app2);
		});

		it('Should handle dealing with a token type lambda', async function () {
			await envAwaitPostedCar('token-lambda', testEnv.tokens.lambdaToken.id, null, testEnv.apps.app2);
		});

		it('Should handle dealing with a token type user', async function () {
			const ref = 'token-type-test-1';
			await envAwaitPostedCar(ref, testEnv.users[ref].tokens[0].id, testEnv.users[ref].id, testEnv.apps.app2);
		});
	});
});
