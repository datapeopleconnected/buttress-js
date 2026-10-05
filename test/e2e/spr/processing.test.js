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
import { randomUUID } from 'node:crypto';

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
	// Lets a user read only the name of each car.
	const NameOnlyPolicy = {
		name: 'realtime-name-only',
		version: 1,
		priority: 1,
		selection: { realtimeNameOnly: { '@eq': 1 } },
		config: [{ verbs: ['GET'], schema: ['car'], query: { access: '%FULL_ACCESS%' }, projection: { keys: ['name'] } }],
	};

	const TestPolicies = [
		NameOnlyPolicy,
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

	const createUserSocket = async (name, app = 'app1') => {
		await createTokenSocket(name, testEnv.users[name].tokens[0].value, app);
	};

	const createTokenSocket = async (name, token, app = 'app1') => {
		const socket = io(`${ENDPOINT.SOCK}/${testEnv.apps[app].apiPath}`, {
			auth: { token: token },
			forceNew: true
		});
		await new Promise((resolve) => socket.on('connect', resolve));
		testEnv.sockets[name] = socket;
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

	// Posts a car and collects every SPR activity for it until well after the SPR has handled it
	const collectPostedCarActivity = async (name, userId, app) => {
		let addedCar = null;
		const received = [];
		const unsubscribe = await NRP_INSTANCE.subscribe('spr:activity', async (data) => {
			const json = JSON.parse(data);
			if (addedCar && json.activity.schemaName === 'car' && json.activity.response.id === addedCar.id) received.push(json);
		});
		[addedCar] = await bjsReq({
			url: `${ENDPOINT.REST}/${app.apiPath}/api/v1/car`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, userId, colour: 'red' }),
		}, app.token);
		await new Promise((r) => setTimeout(r, 1500));
		await unsubscribe();
		return received;
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

	const captureNextRestActivityForApp = async (appApiPath, timeoutMs = 5000) => {
		let unsubscribe = null;

		return await new Promise((resolve) => {
			const timeout = setTimeout(async () => {
				if (unsubscribe) await unsubscribe();
				resolve(null);
			}, timeoutMs);

			NRP_INSTANCE.subscribe('rest:activity', async (raw) => {
				const json = JSON.parse(raw);
				if (json.appAPIPath !== appApiPath) return;

				clearTimeout(timeout);
				if (unsubscribe) await unsubscribe();
				resolve(json);
			}).then((fn) => {
				unsubscribe = fn;
			});
		});
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
		testEnv.users['name-only'] = await runStep('create user name-only', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'name-only', { realtimeNameOnly: 1 })
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

		testEnv.sockets.app = await new Promise((resolve) => {
			const socket = io(`${ENDPOINT.SOCK}/${testEnv.apps.app1.apiPath}`, {
				auth: { token: testEnv.apps.app1.token },
				forceNew: true
			});
			socket.on('connect', () => resolve(socket));
		});

		// Open up some sockets for the users.
		await createUserSocket('basic1');

		await createUserSocket('env-test-1');
		await createUserSocket('env-test-2');
		await createUserSocket('env-test-3');
		await createUserSocket('env-test-4');
		await createUserSocket('env-test-5');
		await createUserSocket('name-only');

		// Allow time for the server to process socket connections and rehydrate tokens
		await new Promise((r) => setTimeout(r, 1000));
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

		it('Should preserve clientSessionId from REST to SPR', async function () {
			this.timeout(5000);
			// A name no other car has. The SPR can still be relaying the car the test before posted, and a name-<0-99>
			// name would let that car's activity be taken for this one's.
			const name = `client-session-${randomUUID()}`;
			const clientSessionId = '11111111-1111-4111-8111-111111111111';

			// REST publishes the activity twice, for system tokens (isSuper) and for the policies, and the SPR relays
			// both, in no set order. The car's copies are kept until both have come through on each channel.
			const rest = [];
			const spr = [];
			let resolve = null;
			const arrived = new Promise((r) => resolve = r);
			const hasBoth = (activities) => activities.some((a) => a.isSuper) && activities.some((a) => !a.isSuper);
			const keep = (activities, activity) => {
				if (activity.appAPIPath !== testEnv.apps.app1.apiPath || activity.response?.name !== name) return;
				activities.push(activity);
				if (hasBoth(rest) && hasBoth(spr)) resolve();
			};

			const restSubscription = await NRP_INSTANCE.subscribe('rest:activity', (data) => keep(rest, JSON.parse(data)));
			const sprSubscription = await NRP_INSTANCE.subscribe('spr:activity', (data) => keep(spr, JSON.parse(data).activity));

			try {
				await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-client-session-id': clientSessionId,
					},
					body: JSON.stringify({ name, userId: testEnv.users.basic1.id }),
				}, testEnv.apps.app1.token);

				await arrived;
			} finally {
				await restSubscription();
				await sprSubscription();
			}

			// Checked here, not in the handlers: NRP only logs a handler's failed assertion, so the test would time out
			for (const activity of [...rest, ...spr]) assert.equal(activity.clientSessionId, clientSessionId);
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

	describe('Bulk writes and deletes', () => {
		const CLIENT_SESSION_ID = '22222222-2222-4222-8222-222222222222';

		// Records the db-activity packets a socket receives for the given entity ids.
		const recordActivity = (socket, ids) => {
			const packets = [];
			const listener = (packet) => {
				if (ids.includes(packet.data.params?.id)) packets.push(packet.data);
			};
			socket.on('db-activity', listener);
			return { packets, stop: () => socket.off('db-activity', listener) };
		};

		const waitUntil = async (check, timeoutMs = 5000) => {
			const start = Date.now();
			while (!check() && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 50));
			// Leave time for any packet that shouldn't arrive.
			await new Promise((r) => setTimeout(r, 300));
		};

		const bulkRequest = (action, body) => bjsReq({
			url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/${action}`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-client-session-id': CLIENT_SESSION_ID },
			body: JSON.stringify(body),
		}, testEnv.apps.app1.token);

		let owned = null;
		let notOwned = null;
		let refused = null;

		before(async function () {
			// env-test-4's policy (env-user-query) only reads the cars it owns.
			[owned, notOwned, refused] = await bulkRequest('add', [
				{ name: 'bulk-owned', userId: testEnv.users['env-test-4'].id },
				{ name: 'bulk-not-owned', userId: testEnv.users['env-test-1'].id },
				{ name: 'bulk-refused', userId: testEnv.users['env-test-4'].id },
			]);
		});

		it('Should relay each entity of a bulk update to the tokens whose policies can read it', async function () {
			this.timeout(10000);
			const ids = [owned.id, notOwned.id, refused.id];
			const fullAccess = recordActivity(testEnv.sockets['basic1'], ids);
			const ownCars = recordActivity(testEnv.sockets['env-test-4'], ids);

			const response = await bulkRequest('update', [
				{ id: owned.id, body: { path: 'colour', value: 'green' } },
				{ id: notOwned.id, body: { path: 'colour', value: 'green' } },
				{ id: refused.id, body: { path: 'notAProperty', value: 'x' } },
			]);
			assert.strictEqual(response.find((r) => r.id === refused.id).results, null);

			await waitUntil(() => fullAccess.packets.length >= 2 && ownCars.packets.length >= 1);
			fullAccess.stop();
			ownCars.stop();

			assert.deepStrictEqual(fullAccess.packets.map((p) => p.params.id).sort(), [owned.id, notOwned.id].sort());
			assert.deepStrictEqual(ownCars.packets.map((p) => p.params.id), [owned.id]);

			const [packet] = ownCars.packets;
			assert.strictEqual(packet.verb, 'put');
			assert.strictEqual(packet.path, `/car/${owned.id}`);
			assert.strictEqual(packet.schemaName, 'car');
			assert.strictEqual(packet.clientSessionId, CLIENT_SESSION_ID);
			assert.deepStrictEqual(packet.response.map((r) => [r.type, r.path, r.value]), [['scalar', 'colour', 'green']]);
		});

		it('Should relay a bulk delete as one delete per id, to the tokens whose policies could read each entity', async function () {
			this.timeout(10000);
			const ids = [owned.id, notOwned.id];
			const fullAccess = recordActivity(testEnv.sockets['basic1'], ids);
			const ownCars = recordActivity(testEnv.sockets['env-test-4'], ids);

			const response = await bulkRequest('delete', ids);
			assert.strictEqual(response, true);

			await waitUntil(() => fullAccess.packets.length >= 2 && ownCars.packets.length >= 1);
			fullAccess.stop();
			ownCars.stop();

			// Each delete is checked against the entity as it was, so env-test-4 only hears about its own car.
			assert.deepStrictEqual(fullAccess.packets.map((p) => p.params.id).sort(), [...ids].sort());
			assert.deepStrictEqual(ownCars.packets.map((p) => p.params.id), [owned.id]);
			for (const packet of [...fullAccess.packets, ...ownCars.packets]) {
				assert.strictEqual(packet.verb, 'delete');
				assert.strictEqual(packet.path, `/car/${packet.params.id}`);
				assert.strictEqual(packet.isBulkDelete, false);
				assert.strictEqual(packet.response, true);
				assert(!('deletedEntities' in packet));
			}
		});

		it('Should relay a single delete to the tokens whose policies could read the entity', async function () {
			this.timeout(10000);
			const [otherCar] = await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'single-not-owned', userId: testEnv.users['env-test-1'].id }),
			}, testEnv.apps.app1.token);
			const ids = [refused.id, otherCar.id];
			const fullAccess = recordActivity(testEnv.sockets['basic1'], ids);
			const ownCars = recordActivity(testEnv.sockets['env-test-4'], ids);

			for (const id of ids) {
				const response = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/${id}`,
					method: 'DELETE',
				}, testEnv.apps.app1.token);
				assert.strictEqual(response, true);
			}

			await waitUntil(() => fullAccess.packets.length >= 2 && ownCars.packets.length >= 1);
			fullAccess.stop();
			ownCars.stop();

			assert.deepStrictEqual(fullAccess.packets.map((p) => [p.verb, p.path]), ids.map((id) => ['delete', `/car/${id}`]));
			assert.deepStrictEqual(ownCars.packets.map((p) => [p.verb, p.path]), [['delete', `/car/${refused.id}`]]);
		});
	});

	describe('Deleted tokens', () => {
		it("Should close a deleted token's socket, so it receives nothing more", async function () {
			this.timeout(20000);
			const user = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'deleted-token', { adminAccess: true });
			const socket = io(`${ENDPOINT.SOCK}/${testEnv.apps.app1.apiPath}`, {
				auth: { token: user.tokens[0].value },
				forceNew: true,
			});
			await new Promise((resolve) => socket.on('connect', resolve));
			const disconnected = new Promise((resolve) => socket.on('disconnect', resolve));
			const received = [];
			socket.on('db-activity', (packet) => received.push(packet.data.response?.name));

			// Deleting the user deletes its token.
			await bjsReq({ url: `${ENDPOINT.REST}/api/v1/user/${user.id}`, method: 'DELETE' }, testEnv.apps.app1.token);
			const reason = await Promise.race([disconnected, new Promise((r) => setTimeout(() => r('still connected'), 5000))]);

			await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'deleted-token-car', userId: user.id }),
			}, testEnv.apps.app1.token);
			await new Promise((r) => setTimeout(r, 1000));
			socket.close();

			assert.strictEqual(reason, 'io server disconnect');
			assert(!received.includes('deleted-token-car'), 'the socket received activity after its token was deleted');
		});
	});

	describe('Several sockets for one token', () => {
		it("Should keep sending to a token's other sockets once one of them closes", async function () {
			this.timeout(20000);
			const user = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'two-tabs', { adminAccess: true });
			const open = async () => {
				const socket = io(`${ENDPOINT.SOCK}/${testEnv.apps.app1.apiPath}`, { auth: { token: user.tokens[0].value }, forceNew: true });
				await new Promise((resolve) => socket.on('connect', resolve));
				return socket;
			};
			const closing = await open();
			const staying = await open();
			const received = [];
			staying.on('db-activity', (packet) => received.push(packet.data.response?.name));

			closing.close();
			// Time for the disconnect to reach the SPR
			await new Promise((r) => setTimeout(r, 1000));
			await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'two-tabs-car', userId: user.id }),
			}, testEnv.apps.app1.token);
			const start = Date.now();
			while (!received.includes('two-tabs-car') && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
			staying.close();

			assert(received.includes('two-tabs-car'), "the token's open socket got nothing once its other socket closed");
		});
	});

	describe('System tokens', () => {
		it("Should relay a system token's write to an app's data to that app's tokens, as that app's", async function () {
			this.timeout(10000);
			const received = [];
			const listener = (packet) => received.push(packet.data);
			testEnv.sockets['basic1'].on('db-activity', listener);

			const res = await fetch(`${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${Config.testToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'system-token-car', userId: testEnv.users['env-test-1'].id }),
			});
			assert.strictEqual(res.status, 200);
			const [car] = await res.json();
			assert.strictEqual(car.sourceId, testEnv.apps.app1.id);

			const start = Date.now();
			while (!received.some((p) => p.response?.id === car.id) && Date.now() - start < 5000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			testEnv.sockets['basic1'].off('db-activity', listener);

			const packet = received.find((p) => p.response?.id === car.id);
			assert(packet, "app1's socket got nothing");
			assert.strictEqual(packet.verb, 'post');
			assert.strictEqual(packet.path, '/car');
			assert.strictEqual(packet.response.sourceId, testEnv.apps.app1.id);
		});
	});

	describe('Projection', () => {
		const carUrl = (id = '') => `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car${id ? `/${id}` : ''}`;
		const send = (url, method, body) => bjsReq({
			url,
			method,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}, testEnv.apps.app1.token);

		// Collects the db-activity packets the name-only socket gets for a car, until `until` or the timeout.
		const packetsFor = async (id, act, until = () => false, timeoutMs = 2000) => {
			const packets = [];
			const listener = (packet) => {
				const data = packet.data;
				if (data.params?.id === id || data.response?.id === id) packets.push(data);
			};
			testEnv.sockets['name-only'].on('db-activity', listener);
			await act();
			const start = Date.now();
			while (!until(packets) && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 50));
			testEnv.sockets['name-only'].off('db-activity', listener);
			return packets;
		};

		let car = null;

		it('Should send a created entity with only the properties the policy projects', async function () {
			this.timeout(10000);

			// The id isn't known until the POST returns, so collect everything and pick the create out afterwards.
			const collected = [];
			const listener = (packet) => collected.push(packet.data);
			testEnv.sockets['name-only'].on('db-activity', listener);
			[car] = await send(carUrl(), 'POST', { name: 'projected', colour: 'red', userId: testEnv.users['name-only'].id });
			const start = Date.now();
			while (!collected.some((d) => d.response?.id === car.id) && Date.now() - start < 5000) {
				await new Promise((r) => setTimeout(r, 50));
			}
			testEnv.sockets['name-only'].off('db-activity', listener);

			const packet = collected.find((d) => d.response?.id === car.id);
			assert(packet, 'The create should reach the name-only socket');
			assert.deepStrictEqual(Object.keys(packet.response).sort(), ['id', 'name', 'sourceId']);
			assert.strictEqual(packet.response.name, 'projected');
		});

		it('Should send an update only for the properties the policy projects', async function () {
			this.timeout(10000);

			const hidden = await packetsFor(car.id, () => send(carUrl(car.id), 'PUT', { path: 'colour', value: 'blue' }));
			assert.deepStrictEqual(hidden, [], 'An update to a hidden property should not be sent');

			const visible = await packetsFor(
				car.id,
				() => send(carUrl(car.id), 'PUT', [{ path: 'colour', value: 'green' }, { path: 'name', value: 'renamed' }]),
				(packets) => packets.length > 0,
			);
			assert.strictEqual(visible.length, 1);
			assert.deepStrictEqual(visible[0].response.map((r) => [r.path, r.value]), [['name', 'renamed']]);
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

		// env-test-5's condition reads #env.user.role.auth.appId, which a user doesn't have, so it never holds
		it("Should not send a token activity that its policy's condition refuses, as REST refuses it", async function () {
			this.timeout(10000);

			const ref = 'env-test-5';
			const user = testEnv.users[ref];
			const read = await fetch(`${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`, {
				headers: { Authorization: `Bearer ${user.tokens[0].value}` },
			});
			assert.strictEqual(read.status, 403);

			const received = await collectPostedCarActivity(ref, user.id, testEnv.apps.app1);

			assert.ok(received.length > 0, 'the SPR should have sent the activity to some token');
			assert.ok(!received.some((json) => json.tokens.includes(user.tokens[0].id)), 'the refused token was sent it');
		});
	});

	describe('Revocation', () => {
		it('Should stop sending a token activity once its policy properties no longer select the policy', async function () {
			this.timeout(20000);

			const ref = 'revoke-1';
			testEnv.users[ref] = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, ref, { envTest: 1 });
			await createUserSocket(ref);
			await new Promise((r) => setTimeout(r, 500));
			const user = testEnv.users[ref];
			const tokenId = user.tokens[0].id;

			await envAwaitPostedCar(ref, tokenId, user.id, testEnv.apps.app1);

			await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${user.id}/clear-policy-property/${tokenId}`,
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			}, testEnv.apps.app1.token);

			const received = await collectPostedCarActivity(ref, user.id, testEnv.apps.app1);
			assert.ok(received.length > 0, 'the SPR should have sent the activity to some token');
			assert.ok(!received.some((json) => json.tokens.includes(tokenId)), 'the revoked token was sent it');
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
			const relayPromise = captureNextRestActivityForApp(testEnv.apps.app2.apiPath);
			await envAwaitPostedCar('token-dataSharing', testEnv.tokens.dataSharingToken.id, null, testEnv.apps.app2);

			const relay = await relayPromise;
			assert(relay, 'Expected to observe a relayed rest:activity for app2');
			assert(relay.schemaName === 'car', `Expected relayed schemaName car, got ${relay?.schemaName}`);
		});

		it('Should handle dealing with a token type lambda', async function () {
			await envAwaitPostedCar('token-lambda', testEnv.tokens.lambdaToken.id, null, testEnv.apps.app2);
		});

		it('Should handle dealing with a token type user', async function () {
			const ref = 'token-type-test-1';
			await envAwaitPostedCar(ref, testEnv.users[ref].tokens[0].id, testEnv.users[ref].id, testEnv.apps.app2);
		});

		it("Should refuse a token on another app's namespace", async function () {
			const socket = io(`${ENDPOINT.SOCK}/${testEnv.apps.app1.apiPath}`, {
				auth: { token: testEnv.apps.app2.token },
				forceNew: true,
				reconnection: false,
			});

			const error = await new Promise((resolve, reject) => {
				socket.once('connect_error', resolve);
				socket.once('connect', () => reject(new Error('Connected with a token for another app')));
			});
			socket.close();

			assert.strictEqual(error.message, 'invalid-namespace');
		});

		it('Should refuse a token that is not a string', async function () {
			// A query object would otherwise find whichever token Mongo returns first, a system token included.
			for (const [app, token] of [[testEnv.apps.app1, { $ne: null }], [testEnv.apps.app2, { $regex: '.' }]]) {
				const socket = io(`${ENDPOINT.SOCK}/${app.apiPath}`, { auth: { token }, forceNew: true, reconnection: false });

				const error = await new Promise((resolve, reject) => {
					socket.once('connect_error', resolve);
					socket.once('connect', () => reject(new Error(`Connected to /${app.apiPath} with ${JSON.stringify(token)}`)));
				});
				socket.close();

				assert.strictEqual(error.message, 'invalid-token');
			}
		});
	});
});
