/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import assert from 'assert';

import { io } from 'socket.io-client';
import { describe, it, before, after } from 'mocha';

import NRP from 'node-redis-pubsub';

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
} from '../../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';
import BootstrapSocketPolicyRouter from '../../../dist/bootstrap-spr.js';
import BootstrapSocket from '../../../dist/bootstrap-socket.js';

// const { default: PolicyTestData } = await import('../../data/policy/index.js');

import PolicyTestData from '../../data/policy/index.js';

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

	const ENDPOINT = `https://test.local.buttressjs.com`;

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
		testEnv.sockets[name] = io(`${ENDPOINT}/${testEnv.apps[app].apiPath}`, {
			auth: { token: token },
			forceNew: true
		});
	};

	const createAppWithSchema = async (ref, name, path, policyProps) => {
		testEnv.apps[ref] = await createApp(ENDPOINT, name, path, policyProps);
		testEnv.apps[ref].schema = await updateSchema(ENDPOINT, [
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

		const subProm = new Promise((resolve) => {
			subs[ref] = NRP_INSTANCE.subscribe('spr:activity', async (data) => {
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
		});

		[addedCar] = await bjsReq({
			url: `${ENDPOINT}/${app.apiPath}/api/v1/car`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: ref, userId: userId, colour: 'red' }),
		}, app.token);

		await subProm;
	};

	const populateTestEnvTokens = async () => {
		const [systemToken] = await bjsReq({
			url: `${ENDPOINT}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: { value: Config.testToken } }),
		}, Config.testToken);
		testEnv.tokens.systemToken = systemToken;

		const [appToken] = await bjsReq({
			url: `${ENDPOINT}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: { value: testEnv.apps.app2.token } }),
		}, Config.testToken);
		testEnv.tokens.appToken = appToken;

		const [dataSharingToken] = await bjsReq({
			url: `${ENDPOINT}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			// TODO: Needs changing, We shouldn't be able to query internal prefixed data.
			body: JSON.stringify({ query: { _appDataSharingId: testEnv.dataSharing[DS2_NAME].id } }),
		}, Config.testToken);
		testEnv.tokens.dataSharingToken = dataSharingToken;

		const [lambdaToken] = await bjsReq({
			url: `${ENDPOINT}/api/v1/token`,
			method: 'SEARCH',
			headers: { 'Content-Type': 'application/json' },
			// TODO: Needs changing, We shouldn't be able to query internal prefixed data.
			body: JSON.stringify({ query: { _lambdaId: testEnv.lambdas['token-test-lambda'].id } }),
		}, Config.testToken);
		testEnv.tokens.lambdaToken = lambdaToken;
	};

	before(async function () {
		this.timeout(20000);

		NRP_INSTANCE = NRP(Config.redis);

		REST_PROCESS = new BootstrapRest();
		await REST_PROCESS.init();

		SPR_PROCESS = new BootstrapSocketPolicyRouter();
		await SPR_PROCESS.init();

		SOCK_PROCESS = new BootstrapSocket();
		await SOCK_PROCESS.init();

		// Create an app
		await createAppWithSchema('app1', 'Test SPR 1', 'test-spr-1', PolicyPropertyList);

		for await (const policy of TestPolicies) {
			await createPolicy(ENDPOINT, policy, testEnv.apps.app1.token);
		}

		// Create a user to test with
		testEnv.users['basic1'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'basic1', { adminAccess: true });

		testEnv.users['env-test-1'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-1', { envTest: 1 });
		testEnv.users['env-test-2'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-2', { envTest: 2 });
		testEnv.users['env-test-3'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-3', { envTest: 3 });
		testEnv.users['env-test-4'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-4', { envTest: 4 });
		testEnv.users['env-test-5'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-5', { envTest: 5 });

		const usersKeys = Object.keys(testEnv.users);
		const colours = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'brown', 'black', 'white'];
		await bjsReq({
			url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/add`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(new Array(1000).fill(0).map((val, idx) => ({
				name: `name-${Math.floor(Math.random() * 100)}`,
				colour: colours[Math.floor(Math.random() * colours.length)],
				userId: testEnv.users[usersKeys[Math.floor(Math.random() * usersKeys.length)]].id,
			}))),
		}, testEnv.apps.app1.token);

		await bjsReq({
			url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/selector`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: `example-selector`,
				value: 'red',
			}),
		}, testEnv.apps.app1.token);

		testEnv.sockets.app = io(`${ENDPOINT}/${testEnv.apps.app1.apiPath}`, {
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

		NRP_INSTANCE.end();

		if (REST_PROCESS) await REST_PROCESS.clean();
		if (SPR_PROCESS) await SPR_PROCESS.clean();
		if (SOCK_PROCESS) await SOCK_PROCESS.clean();
	});

	describe('Basic', () => {
		it('Should receive a `rest:activity` event after a REST post', async function () {
			this.timeout(5000);
			const name = `name-${Math.floor(Math.random() * 100)}`;

			// Subscribe to the NRP event and wait for it to be received.
			const subProm = new Promise((resolve) => {
				subs['test1'] = NRP_INSTANCE.subscribe('rest:activity', async (data) => {
					await subs['test1']();
					delete subs['test1'];
					resolve(JSON.parse(data));
				});
			});

			// Make a request to REST to generate the event.
			await bjsReq({
				url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, userId: testEnv.users.basic1.id }),
			}, testEnv.apps.app1.token);

			// Wait for the sub promise to resolve.
			await subProm;
		});

		it('Should generate a `spr:activity` event after a REST post', async function () {
			const name = `name-${Math.floor(Math.random() * 100)}`;

			// Subscribe to the NRP event and wait for it to be received.
			const subProm = new Promise((resolve) => {
				subs['test2'] = NRP_INSTANCE.subscribe('spr:activity', async (dataRaw) => {
					await subs['test2']();
					delete subs['test2'];
					const data = JSON.parse(dataRaw);

					assert(Array.isArray(data.tokens), 'Tokens is not an array');
					assert(data.tokens.length > 0, 'Tokens is empty');

					assert(data.activity.schemaName === 'car', 'Schema name is not car');

					resolve();
				});
			});

			// Make a request to REST to generate the event.
			await bjsReq({
				url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, userId: testEnv.users.basic1.id }),
			}, testEnv.apps.app1.token);

			// Wait for the sub promise to resolve.
			await subProm;
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
			testEnv.sockets.super = io(`${ENDPOINT}`, {
				auth: { token: Config.testToken },
				forceNew: true
			});

			await createAppWithSchema('app2', 'Test SPR 2', 'test-spr-2', PolicyPropertyList);

			await createPolicy(ENDPOINT, PolicyTestData['env-static-value-query'], testEnv.apps.app2.token);
			await createPolicy(ENDPOINT, PolicyTestData['lambda-test-access'], testEnv.apps.app2.token);

			testEnv.dataSharing[DS1_NAME] = await registerDataSharing(ENDPOINT, {
				name: DS1_NAME,

				remoteApp: {
					endpoint: ENDPOINT,
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
			}, testEnv.apps.app1.token);

			testEnv.dataSharing[DS2_NAME] = await registerDataSharing(ENDPOINT, {
				name: DS2_NAME,

				remoteApp: {
					endpoint: ENDPOINT,
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
			}, testEnv.apps.app2.token);

			testEnv.lambdas['token-test-lambda'] = await createLambda(ENDPOINT, {
					name: 'token-test-lambda',
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
							url: 'test/token/hello/world',
							type: 'SYNC',
						},
					}],
				}, {
					domains: ['localhost'],
					permissions: [{route: '*', permission: '*'}],
					policyProperties: { lambda: 'TEST_ACCESS' },
				}, testEnv.apps.app2.token);

			testEnv.users['token-type-test-1'] = await createPolicyUser(ENDPOINT, testEnv.apps.app2, 'token-type-test-1', { envTest: 1 });

			await populateTestEnvTokens();

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
