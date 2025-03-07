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

const {io} = require('socket.io-client');
const {describe, it, before, after} = require('mocha');
const assert = require('assert');
const fetch = require('cross-fetch');

const NRP = require('node-redis-pubsub');

const Config = require('node-env-obj')();

const {
	createApp,
	updateSchema,
	bjsReq,
	createPolicy,
	createPolicyUser,
	extractPolicyPropertyListFromPolicies
} = require('../../helpers');

const {default: BootstrapRest} = require('../../../dist/bootstrap-rest');
const {default: BootstrapSocketPolicyRouter} = require('../../../dist/bootstrap-spr');
const {default: BootstrapSocket} = require('../../../dist/bootstrap-socket');

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Processing', async () => {
	const PolicyTestData = require('../../data/policy/index.js');

	const TestPolicies = [
		PolicyTestData['admin-access'],
		PolicyTestData['env-static-value-query'],
		PolicyTestData['env-date-condition'],
		PolicyTestData['env-entity-condition'],
		PolicyTestData['env-user-query'],
		PolicyTestData['env-user-condition'],
	];

	const PolicyPropertyList = extractPolicyPropertyListFromPolicies(TestPolicies);

	const ENDPOINT = `https://test.local.buttressjs.com`;

	let NRP_INSTANCE = null;

	let REST_PROCESS = null;
	let SPR_PROCESS = null;
	let SOCK_PROCESS = null;

	const testEnv = {
		apps: {},
		users: {},
		sockets: {
			app: null
		}
	};

	const subs = {};

	const createUserSocket = (name, app = 'app1') => {
		testEnv.sockets[name] = io(`${ENDPOINT}/${testEnv.apps.app1.apiPath}`, {
			auth: { token: testEnv.users[name].tokens[0].value },
			forceNew: true
		});
	};

	before(async function() {
		this.timeout(20000);

		NRP_INSTANCE = NRP(Config.redis);

		REST_PROCESS = new BootstrapRest();
		await REST_PROCESS.init();

		SPR_PROCESS = new BootstrapSocketPolicyRouter();
		await SPR_PROCESS.init();

		SOCK_PROCESS = new BootstrapSocket();
		await SOCK_PROCESS.init();

		// Creating test data.
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
				createdAt: {
					__type: 'date',
					__default: "now",
					__required: true,
					__allowUpdate: true,
				}
			},
		};

		// Create an app
		testEnv.apps.app1 = await createApp(ENDPOINT, 'Test SOCK 1', 'test-sock-1', PolicyPropertyList);
		testEnv.apps.app1.schema = await updateSchema(ENDPOINT, [carsSchema], testEnv.apps.app1.token);

		for await (const policy of TestPolicies) {
			await createPolicy(ENDPOINT, policy, testEnv.apps.app1.token);
		}

		// Create a user to test with
		testEnv.users['basic1'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'basic1', { adminAccess: true });

		// testEnv.users['summarWorkingDate'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'summarWorkingDate', { grade: 6 });

		testEnv.users['env-test-1'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-1', { envTest: 1 });
		testEnv.users['env-test-2'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-2', { envTest: 2 });
		testEnv.users['env-test-3'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-3', { envTest: 3 });
		// testEnv.users['env-test-4'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-4', { envTest: 4 });
		testEnv.users['env-test-5'] = await createPolicyUser(ENDPOINT, testEnv.apps.app1, 'env-test-5', { envTest: 5 });

		const usersKeys = Object.keys(testEnv.users);
		const colours = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'brown', 'black', 'white'];
		await bjsReq({
			url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/add`,
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(new Array(1000).fill(0).map((val, idx) => ({
				name: `name-${Math.floor(Math.random()*100)}`,
				colour: colours[idx & colours.length],
				userId: testEnv.users[usersKeys[idx % usersKeys.length]].id
			}))),
		}, testEnv.apps.app1.token);

		testEnv.sockets.app = io(`${ENDPOINT}/${testEnv.apps.app1.apiPath}`, {
			auth: { token: testEnv.apps.app1.token },
			forceNew: true
		});

		// Open up some sockets for the users.
		createUserSocket('basic1');
		// createUserSocket('summarWorkingDate');

		createUserSocket('env-test-1');
		console.log('Connected as', testEnv.users['env-test-1'].tokens[0].id);
		createUserSocket('env-test-2');
		createUserSocket('env-test-3');
		// createUserSocket('env-test-4');
		createUserSocket('env-test-5');
	});

	after(async function() {
		if (testEnv.socket) testEnv.socket.disconnect();

		Object.values(subs).forEach((fn) => fn());

		await REST_PROCESS.clean();
		await SPR_PROCESS.clean();
		await SOCK_PROCESS.clean();
		NRP_INSTANCE.quit();
	});

	describe('Basic', () => {
		it('Should receive a `rest:activity` event after a REST post', async function() {
			this.timeout(5000);
			const name = `name-${Math.floor(Math.random()*100)}`;

			// Subscribe to the NRP event and wait for it to be received.
			const subProm = new Promise((resolve) => {
				subs['test1'] = NRP_INSTANCE.subscribe('rest:activity', async (data) => {
					subs['test1']();
					delete subs['test1'];
					resolve(JSON.parse(data));
				});
			});

			// Make a request to REST to generate the event.
			await bjsReq({
				url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name, userId: testEnv.users.basic1.id}),
			}, testEnv.apps.app1.token);


			// Wait for the sub promise to resolve.
			await subProm;
		});

		it('Should generate a `spr:activity` event after a REST post', async function() {
			const name = `name-${Math.floor(Math.random()*100)}`;

			// Subscribe to the NRP event and wait for it to be received.
			const subProm = new Promise((resolve) => {
				subs['test1'] = NRP_INSTANCE.subscribe('spr:activity', async (data) => {
					subs['test1']();
					delete subs['test1'];
					resolve(JSON.parse(data));
				});
			});

			// Make a request to REST to generate the event.
			await bjsReq({
				url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name, userId: testEnv.users.basic1.id}),
			}, testEnv.apps.app1.token);

			// Wait for the sub promise to resolve.
			await subProm;
		});
	});

	describe('Env', () => {
		const envAwaitPostedCar = async (testKey) => {
			let addedCar = null;

			const subProm = new Promise((resolve) => {
				subs[testKey] = NRP_INSTANCE.subscribe('spr:activity', async (data) => {
					// We've got an event too early.
					if (!addedCar) return;

					const json = JSON.parse(data);
					if (json.activty.schemaName !== 'car' || json.activty.response.id !== addedCar.id) return;

					const result = json.tokens.includes(testEnv.users[testKey].tokens[0].id);
					// assert(result, 'Token not found in the list of tokens');

					if (result) {
						subs[testKey]();
						delete subs[testKey];
						resolve(json);
					}
				});
			});

			[addedCar] = await bjsReq({
				url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name: testKey, userId: testEnv.users[testKey].id}),
			}, testEnv.apps.app1.token);

			await subProm;
		};

		it('Should handle a policy with a env inlcuding a static value query', async function() {
			this.timeout(10000);

			await envAwaitPostedCar('env-test-1');
		});
		
		it('Should handle a policy with a env inlcuding a date based condition', async function() {
			this.timeout(10000);

			await envAwaitPostedCar('env-test-2');
		});

		it('Should handle a policy with a env inlcuding a entity based condition', async function() {
			// TODO
			throw new Error('Not implemented');
		});

		it('Should handle a policy with a env inlcuding a user base query', async function() {
			// TODO
			// TODO: If the env prop contains "user" then we need to check the policy against each token rather than in a group.
			throw new Error('Not implemented');
		});

		it('Should handle a policy with a env inlcuding a user base condition', async function() {
			// TODO
			throw new Error('Not implemented');
		});
	});
});
