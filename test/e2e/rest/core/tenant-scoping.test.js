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

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import fs from 'node:fs';

import {
	createApp,
	createLambda,
	createPolicy,
	createPolicyUser,
	registerDataSharing,
	updatePolicyPropertyList,
	updateSchema,
	bjsReq,
	bjsReqPost,
	deleteApp,
	BJSReqError,
	ENDPOINT,
} from '../../../helpers.js';
import { runStep } from '../../helpers.js';
import Config from '../../../config.js';

import BootstrapRest from '../../../../dist/bootstrap-rest.js';

// Core routes called with one app's token reach only that app's entities: search and count with no request
// body, and routes that take another app's id.
describe('Core route tenant scoping', async () => {
	const testEnv = {
		apps: {},
		users: {},
	};

	let REST_PROCESS = null;

	const search = (path, token) => bjsReq({ url: `${ENDPOINT.REST}/api/v1/${path}`, method: 'SEARCH' }, token);

	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, 'Core route tenant scoping setup');

		testEnv.apps.app1 = await runStep('create app1', async () =>
			createApp(ENDPOINT.REST, 'Test Tenant Scoping 1', 'test-tenant-scoping-1')
		, 'Core route tenant scoping setup');
		testEnv.apps.app2 = await runStep('create app2', async () =>
			createApp(ENDPOINT.REST, 'Test Tenant Scoping 2', 'test-tenant-scoping-2')
		, 'Core route tenant scoping setup');

		testEnv.users.app1 = await runStep('create app1 user', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'tenant-scoping-user1', {})
		, 'Core route tenant scoping setup');
		testEnv.users.app2 = await runStep('create app2 user', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-user2', {})
		, 'Core route tenant scoping setup');
	});

	// app2's entities, which app1's token must not reach by id
	const owned = {};

	before(async function () {
		this.timeout(60000);
		const scope = 'Core route tenant scoping setup';

		// Both apps allow the same policy properties, so app1's requests aren't refused for using ones it lacks
		for (const app of ['app1', 'app2']) {
			await runStep(`allow policy properties on ${app}`, async () => updatePolicyPropertyList(ENDPOINT.REST, {
				lambda: ['TEST_ACCESS'],
				role: ['ADMIN', 'VIEWER', 'EDITOR', 'NOBODY', 'WRITER', 'SCOPED', 'EXPIRED', 'LIMITED'],
			}, testEnv.apps[app].token), scope);
		}

		owned.policy = await runStep('create app2 policy', async () => createPolicy(ENDPOINT.REST, {
			name: 'tenant-scoping-policy',
			version: '1',
			selection: { lambda: { '@eq': 'TEST_ACCESS' } },
			config: [{ verbs: ['GET'], schema: ['%ALL%'], query: { access: '%FULL_ACCESS%' } }],
		}, testEnv.apps.app2.token), scope);

		// As the SPR suite does, so the lambda is added without cloning
		await runStep('pre-create lambda-HEAD stub', async () => {
			const dir = `${Config.paths.lambda.code}/lambda-HEAD/test/data/lambda`;
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const dest = `${dir}/hello-world.cjs`;
			if (!fs.existsSync(dest)) fs.copyFileSync(`${Config.paths.root}/test/data/lambda/hello-world.cjs`, dest);
		}, scope);

		owned.lambda = await runStep('create app2 lambda', async () => createLambda(ENDPOINT.REST, {
			name: 'tenant-scoping-lambda',
			type: 'PUBLIC',
			git: {
				url: Config.paths.root,
				branch: 'develop',
				hash: 'HEAD',
				entryFile: 'test/data/lambda/hello-world.cjs',
				entryPoint: 'execute',
			},
			trigger: [],
		}, {
			domains: ['localhost'],
			permissions: [{ route: '*', permission: '*' }],
			policyProperties: { lambda: 'TEST_ACCESS' },
		}, testEnv.apps.app2.token), scope);

		owned.privateLambda = await runStep('create app2 private lambda', async () => createLambda(ENDPOINT.REST, {
			name: 'tenant-scoping-private',
			type: 'PRIVATE',
			git: {
				url: Config.paths.root,
				branch: 'develop',
				hash: 'HEAD',
				entryFile: 'test/data/lambda/hello-world.cjs',
				entryPoint: 'execute',
			},
			trigger: [{ type: 'API_ENDPOINT', apiEndpoint: { method: 'GET', url: 'tenant-scoping/private', type: 'ASYNC' } }],
		}, {
			domains: ['localhost'],
			permissions: [{ route: '*', permission: '*' }],
			policyProperties: { lambda: 'TEST_ACCESS' },
		}, testEnv.apps.app2.token), scope);

		owned.execution = await runStep('schedule app2 lambda execution', async () =>
			bjsReqPost(`${ENDPOINT.REST}/api/v1/lambda/${owned.lambda.id}/schedule`, {
				executeAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
			}, testEnv.apps.app2.token)
		, scope);

		owned.agreement = await runStep('register app2 agreement', async () => registerDataSharing(ENDPOINT.REST, {
			name: 'tenant-scoping-agreement',
			remoteApp: { endpoint: ENDPOINT.REST, ws: ENDPOINT.SOCK, apiPath: testEnv.apps.app1.apiPath, token: null },
			policyConfig: [{ verbs: ['%ALL%'], schema: ['%ALL%'], query: { access: '%FULL_ACCESS%' } }],
		}, testEnv.apps.app2.token), scope);

		// Both apps have a note collection, and app2 has a note in it
		for (const app of ['app1', 'app2']) {
			await runStep(`add the note schema to ${app}`, async () => updateSchema(ENDPOINT.REST, [{
				name: 'note',
				type: 'collection',
				properties: {
					text: { __type: 'string', __default: null, __required: true, __allowUpdate: true },
					secret: { __type: 'string', __default: null, __required: false, __allowUpdate: true },
				},
			}], testEnv.apps[app].token), scope);
		}
		[owned.note] = await runStep('add app2 note', async () =>
			bjsReqPost(`${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note`, { text: 'app2 note', secret: 'app2 secret' }, testEnv.apps.app2.token)
		, scope);
	});

	after(async function () {
		if (testEnv.apps.app1?.id) await deleteApp(ENDPOINT.REST, testEnv.apps.app1.id);
		if (testEnv.apps.app2?.id) await deleteApp(ENDPOINT.REST, testEnv.apps.app2.id);

		await REST_PROCESS.clean();
	});

	it('Should return only the calling app, with its own token value', async () => {
		const apps = await search('app', testEnv.apps.app1.token);

		assert.deepStrictEqual(apps.map((a) => a.id), [testEnv.apps.app1.id]);
		assert.strictEqual(apps[0].tokenValue, testEnv.apps.app1.token);
	});

	it('Should still return every app, with token values, to a system token', async () => {
		const apps = await search('app');
		const ids = apps.map((a) => a.id);

		assert.ok(ids.includes(testEnv.apps.app1.id) && ids.includes(testEnv.apps.app2.id));
		assert.strictEqual(apps.find((a) => a.id === testEnv.apps.app2.id).tokenValue, testEnv.apps.app2.token);
	});

	it("Should return only the calling app's users", async () => {
		const users = await search('user', testEnv.apps.app1.token);

		assert.deepStrictEqual(users.map((u) => u.id), [testEnv.users.app1.id]);
	});

	it("Should count only the calling app's users", async () => {
		const count = await search('user/count', testEnv.apps.app1.token);

		assert.strictEqual(count, 1);
	});

	it("Should refuse to update another app, and leave it unchanged", async () => {
		await assert.rejects(bjsReq({
			url: `${ENDPOINT.REST}/api/v1/app/${testEnv.apps.app2.id}`,
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify([{ path: 'name', value: 'Renamed by app1' }]),
		}, testEnv.apps.app1.token), (err) => err instanceof BJSReqError && err.code === 400 && err.message === 'invalid_id');

		const [app2] = await search('app', testEnv.apps.app2.token);
		assert.strictEqual(app2.name, 'Test Tenant Scoping 2');
	});

	it('Should still update the calling app', async () => {
		await bjsReq({
			url: `${ENDPOINT.REST}/api/v1/app/${testEnv.apps.app1.id}`,
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify([{ path: 'name', value: 'Test Tenant Scoping 1 renamed' }]),
		}, testEnv.apps.app1.token);

		const [app1] = await search('app', testEnv.apps.app1.token);
		assert.strictEqual(app1.name, 'Test Tenant Scoping 1 renamed');
	});

	describe("By-id routes refuse another app's entities", () => {
		const api = (path) => `${ENDPOINT.REST}/api/v1/${path}`;
		const json = { 'Content-Type': 'application/json' };
		const asApp1 = (opts) => bjsReq(opts, testEnv.apps.app1.token);
		const asApp2 = (opts) => bjsReq(opts, testEnv.apps.app2.token);
		const update = (path, value) => JSON.stringify([{ path, value }]);

		// The route answers as it does for an id that doesn't exist: 400 or 404, or for the agreement reactivate,
		// deactivate and status routes 500 no_datasharing
		const refused = (promise, message) => assert.rejects(promise, (err) => {
			assert.ok(err instanceof BJSReqError, err);
			const unknownId = [400, 404].includes(err.code) || (err.code === 500 && err.message === 'no_datasharing');
			assert.ok(unknownId, `answered ${err.code} ${err.message}`);
			if (message) assert.strictEqual(err.message, message);
			return true;
		});

		const byIdRoutes = [
			['GET policy/:id', () => ({ url: api(`policy/${owned.policy.id}`), method: 'GET' })],
			['PUT policy/:id', () => ({
				url: api(`policy/${owned.policy.id}`), method: 'PUT', headers: json, body: update('name', 'by app1'),
			})],
			['POST policy/bulk/update', () => ({
				url: api('policy/bulk/update'), method: 'POST', headers: json,
				body: JSON.stringify([{ id: owned.policy.id, body: [{ path: 'name', value: 'by app1' }] }]),
			})],
			['DELETE policy/:id', () => ({ url: api(`policy/${owned.policy.id}`), method: 'DELETE' })],

			['GET lambda/:id', () => ({ url: api(`lambda/${owned.lambda.id}`), method: 'GET' })],
			['PUT lambda/:id', () => ({
				url: api(`lambda/${owned.lambda.id}`), method: 'PUT', headers: json, body: update('name', 'by-app1'),
			})],
			['POST lambda/bulk/update', () => ({
				url: api('lambda/bulk/update'), method: 'POST', headers: json,
				body: JSON.stringify([{ id: owned.lambda.id, body: [{ path: 'name', value: 'by-app1' }] }]),
			})],
			// The lambda's checkout is a stub, so git fails if the lookup finds it
			['PUT lambda/:id/deployment', () => ({
				url: api(`lambda/${owned.lambda.id}/deployment`), method: 'PUT', headers: json,
				body: JSON.stringify({ branch: 'develop', hash: 'HEAD' }),
			}), 'invalid_lambda_id'],
			...['policy-property', 'update-policy-property', 'clear-policy-property'].map((route) => [
				`PUT lambda/:id/${route}`,
				() => ({
					url: api(`lambda/${owned.lambda.id}/${route}`), method: 'PUT', headers: json,
					body: JSON.stringify({ lambda: 'TEST_ACCESS' }),
				}),
			]),
			['DELETE lambda/:id', () => ({ url: api(`lambda/${owned.lambda.id}`), method: 'DELETE' })],

			['GET lambda-execution/:id', () => ({ url: api(`lambda-execution/${owned.execution.id}`), method: 'GET' })],
			['GET lambda-execution/:id/status', () => ({
				url: api(`lambda-execution/${owned.execution.id}/status`), method: 'GET',
			})],
			['PUT lambda-execution/:id', () => ({
				url: api(`lambda-execution/${owned.execution.id}`), method: 'PUT', headers: json,
				body: update('status', 'COMPLETE'),
			})],

			['POST user/:id/token', () => ({
				url: api(`user/${testEnv.users.app2.id}/token`), method: 'POST', headers: json,
				body: JSON.stringify({ domains: ['localhost'], policyProperties: { role: 'ADMIN' } }),
			})],
			['PUT user/:id', () => ({
				url: api(`user/${testEnv.users.app2.id}`), method: 'PUT', headers: json,
				body: update('auth.0.email', 'by-app1@example.com'),
			})],
			...['policy-property', 'update-policy-property', 'remove-policy-property', 'clear-policy-property'].map((route) => [
				`PUT user/:id/${route}/:tokenId`,
				() => ({
					url: api(`user/${testEnv.users.app2.id}/${route}/${testEnv.users.app2.tokens[0].id}`), method: 'PUT',
					headers: json, body: JSON.stringify({ role: 'ADMIN' }),
				}),
			]),
			['POST user/:id/clear-local-data', () => ({
				url: api(`user/${testEnv.users.app2.id}/clear-local-data`), method: 'POST', headers: json, body: '{}',
			})],
			['DELETE user/:id', () => ({ url: api(`user/${testEnv.users.app2.id}`), method: 'DELETE' })],
			// Answered as a user that doesn't exist, rather than with an empty list, which would say it's another app's
			['SEARCH token/:userId', () => ({
				url: api(`token/${testEnv.users.app2.id}`), method: 'SEARCH', headers: json, body: '{}',
			}), 'invalid_param_id'],

			['GET app-data-sharing/:id', () => ({ url: api(`app-data-sharing/${owned.agreement.id}`), method: 'GET' })],
			['PUT app-data-sharing/:id', () => ({
				url: api(`app-data-sharing/${owned.agreement.id}`), method: 'PUT', headers: json, body: update('name', 'by app1'),
			})],
			['POST app-data-sharing/bulk/update', () => ({
				url: api('app-data-sharing/bulk/update'), method: 'POST', headers: json,
				body: JSON.stringify([{ id: owned.agreement.id, body: [{ path: 'name', value: 'by app1' }] }]),
			})],
			...['reactivate', 'deactivate'].map((route) => [
				`PUT app-data-sharing/${route}/:id`,
				() => ({ url: api(`app-data-sharing/${route}/${owned.agreement.id}`), method: 'PUT', headers: json, body: '{}' }),
			]),
			['GET app-data-sharing/:id/status', () => ({
				url: api(`app-data-sharing/${owned.agreement.id}/status`), method: 'GET',
			})],
			['DELETE app-data-sharing/:id', () => ({ url: api(`app-data-sharing/${owned.agreement.id}`), method: 'DELETE' })],
		];

		for (const [name, request, message] of byIdRoutes) {
			it(`Should refuse ${name}`, async () => {
				await refused(asApp1(request()), message);
			});
		}

		it("Should leave app2's entities unchanged", async () => {
			const policy = await asApp2({ url: api(`policy/${owned.policy.id}`), method: 'GET' });
			assert.strictEqual(policy.name, 'tenant-scoping-policy');

			const lambda = await asApp2({ url: api(`lambda/${owned.lambda.id}`), method: 'GET' });
			assert.strictEqual(lambda.name, 'tenant-scoping-lambda');

			const execution = await asApp2({ url: api(`lambda-execution/${owned.execution.id}`), method: 'GET' });
			assert.strictEqual(execution.status, 'PENDING');

			const user = await asApp2({ url: api(`user/${testEnv.users.app2.id}`), method: 'GET' });
			assert.strictEqual(user.auth[0].email, testEnv.users.app2.auth[0].email);
			assert.strictEqual(user.tokens.length, 1);

			const agreement = await asApp2({ url: api(`app-data-sharing/${owned.agreement.id}`), method: 'GET' });
			assert.strictEqual(agreement.name, 'tenant-scoping-agreement');
		});
	});
	describe("App routes refuse another app's token", () => {
		const notes = (path = '') => `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note${path}`;
		const json = { 'Content-Type': 'application/json' };
		const asApp1 = (opts) => bjsReq(opts, testEnv.apps.app1.token);

		const appRoutes = [
			['GET note', () => ({ url: notes(), method: 'GET' })],
			['GET note/:id', () => ({ url: notes(`/${owned.note.id}`), method: 'GET' })],
			['SEARCH note', () => ({ url: notes(), method: 'SEARCH', headers: json, body: '{}' })],
			['SEARCH note/count', () => ({ url: notes('/count'), method: 'SEARCH', headers: json, body: '{}' })],
			['SEARCH note/bulk/load', () => ({
				url: notes('/bulk/load'), method: 'SEARCH', headers: json, body: JSON.stringify([owned.note.id]),
			})],
			['POST note', () => ({ url: notes(), method: 'POST', headers: json, body: JSON.stringify({ text: 'by app1' }) })],
			['POST note/bulk/add', () => ({
				url: notes('/bulk/add'), method: 'POST', headers: json, body: JSON.stringify([{ text: 'by app1' }]),
			})],
			['PUT note/:id', () => ({
				url: notes(`/${owned.note.id}`), method: 'PUT', headers: json,
				body: JSON.stringify([{ path: 'text', value: 'by app1' }]),
			})],
			['POST note/bulk/update', () => ({
				url: notes('/bulk/update'), method: 'POST', headers: json,
				body: JSON.stringify([{ id: owned.note.id, body: [{ path: 'text', value: 'by app1' }] }]),
			})],
			['DELETE note/:id', () => ({ url: notes(`/${owned.note.id}`), method: 'DELETE' })],
			['POST note/bulk/delete', () => ({
				url: notes('/bulk/delete'), method: 'POST', headers: json, body: JSON.stringify([owned.note.id]),
			})],
			['DELETE note', () => ({ url: notes(), method: 'DELETE' })],
		];

		for (const [name, request] of appRoutes) {
			it(`Should refuse ${name}`, async () => {
				await assert.rejects(asApp1(request()), (err) => {
					assert.ok(err instanceof BJSReqError, err);
					assert.strictEqual(err.code, 403, `answered ${err.code} ${err.message}`);
					assert.strictEqual(err.body.code, 'insufficient_authority');
					return true;
				});
			});
		}

		it("Should leave app2's notes unchanged, and still serve them to app2 and system tokens", async () => {
			const expected = [{ id: owned.note.id, text: 'app2 note' }];
			const summary = (list) => list.map(({ id, text }) => ({ id, text }));

			assert.deepStrictEqual(summary(await bjsReq({ url: notes(), method: 'GET' }, testEnv.apps.app2.token)), expected);
			assert.deepStrictEqual(summary(await bjsReq({ url: notes(), method: 'GET' })), expected);
		});
	});
	describe('PRIVATE lambda endpoints take only their own app\'s tokens', () => {
		const endpoint = () => `${ENDPOINT.REST}/lambda/v1/${testEnv.apps.app2.apiPath}/tenant-scoping/private`;
		const call = (token) => fetch(endpoint(), { headers: token ? { Authorization: `Bearer ${token}` } : {} });

		it("Should refuse another app's token", async () => {
			const res = await call(testEnv.apps.app1.token);

			assert.strictEqual(res.status, 403);
			assert.strictEqual((await res.json()).code, 'insufficient_authority');
		});

		it("Should refuse another app's user token", async () => {
			const res = await call(testEnv.users.app1.tokens[0].value);

			assert.strictEqual(res.status, 403);
		});

		it('Should refuse a request with no token', async () => {
			const res = await call(null);

			assert.strictEqual(res.status, 401);
		});

		it("Should keep no credential headers of the call in the lambda's execution", async () => {
			const res = await fetch(endpoint(), {
				headers: { Authorization: `Bearer ${testEnv.users.app2.tokens[0].value}`, Cookie: 'session=s3cr3t', 'X-Api-Key': 'k3y', 'X-Trace': 'kept' },
			});
			const { executionId } = await res.json();

			const execution = await bjsReq({ url: `${ENDPOINT.REST}/api/v1/lambda-execution/${executionId}`, method: 'GET' });
			const headers = JSON.parse(execution.metadata.find((m) => m.key === 'HEADERS').value);
			for (const name of ['authorization', 'cookie', 'x-api-key']) assert.ok(!(name in headers), `kept ${name}`);
			assert.strictEqual(headers['x-trace'], 'kept');
		});

		it("Should still run for the app's own tokens and a system token", async () => {
			for (const token of [testEnv.users.app2.tokens[0].value, testEnv.apps.app2.token, Config.testToken]) {
				const res = await call(token);

				assert.strictEqual(res.status, 200);
				assert.ok((await res.json()).executionId);
			}
		});
	});
	describe('Policy queries that refer to env values that are not set', () => {
		before(async function () {
			this.timeout(20000);
			const scope = 'Policy env setup';

			await runStep('create app2 policy on an unset user field', async () => createPolicy(ENDPOINT.REST, {
				name: 'tenant-scoping-unset-env',
				version: '1',
				selection: { role: { '@eq': 'ADMIN' } },
				config: [{ verbs: ['GET', 'SEARCH'], schema: ['note'], query: { owner: { '@eq': '#env.user.nickname' } } }],
			}, testEnv.apps.app2.token), scope);

			testEnv.users.app2Admin = await runStep('create app2 admin user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-admin', { role: 'ADMIN' })
			, scope);
		});

		it("Should refuse a read whose only policy query can't be resolved, rather than match entities without the field", async () => {
			await assert.rejects(bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note`,
				method: 'GET',
			}, testEnv.users.app2Admin.tokens[0].value), (err) => err instanceof BJSReqError && err.code === 403);
		});
	});
	describe('Policy projections', () => {
		before(async function () {
			this.timeout(20000);
			const scope = 'Policy projection setup';

			await runStep('create app2 policy that projects the text', async () => createPolicy(ENDPOINT.REST, {
				name: 'tenant-scoping-text-only',
				version: '1',
				selection: { role: { '@eq': 'VIEWER' } },
				config: [{
					verbs: ['GET', 'SEARCH'],
					schema: ['note'],
					query: { access: '%FULL_ACCESS%' },
					projection: { keys: ['text'] },
				}],
			}, testEnv.apps.app2.token), scope);

			testEnv.users.app2Viewer = await runStep('create app2 viewer user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-viewer', { role: 'VIEWER' })
			, scope);
		});

		it('Should give only the projected properties, whatever the request projects', async () => {
			for (const project of [{ secret: 1 }, { text: 1, secret: 1 }, undefined]) {
				const notes = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note`,
					method: 'SEARCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ query: {}, project }),
				}, testEnv.users.app2Viewer.tokens[0].value);

				assert.ok(notes.length > 0, JSON.stringify(project));
				for (const note of notes) {
					assert.ok(!('secret' in note), `${JSON.stringify(project)} gave ${JSON.stringify(note)}`);
					assert.strictEqual(note.text, 'app2 note');
				}
			}
		});
	});
	describe('Changing a policy', () => {
		const readNotes = (token) => bjsReq({ url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note`, method: 'GET' }, token);

		before(async function () {
			this.timeout(20000);
			const scope = 'Policy change setup';

			owned.editorPolicy = await runStep('create app2 editor policy', async () => createPolicy(ENDPOINT.REST, {
				name: 'tenant-scoping-editors',
				version: '1',
				selection: { role: { '@eq': 'EDITOR' } },
				config: [{ verbs: ['GET', 'SEARCH'], schema: ['note'], query: { access: '%FULL_ACCESS%' } }],
			}, testEnv.apps.app2.token), scope);

			testEnv.users.app2Editor = await runStep('create app2 editor user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-editor', { role: 'EDITOR' })
			, scope);
		});

		it('Should stop granting a policy to a token once its selection no longer selects it', async () => {
			const token = testEnv.users.app2Editor.tokens[0].value;
			assert.ok((await readNotes(token)).length > 0);

			await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/policy/${owned.editorPolicy.id}`,
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				// A role no token has
				body: JSON.stringify([{ path: 'selection', value: { role: { '@eq': 'NOBODY' } } }]),
			}, testEnv.apps.app2.token);

			await assert.rejects(readNotes(token), (err) => err instanceof BJSReqError && err.code === 403);
		});
	});
	describe('Writes limited by a policy projection', () => {
		const notes = (path = '') => `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note${path}`;
		const json = { 'Content-Type': 'application/json' };

		before(async function () {
			this.timeout(20000);
			const scope = 'Policy projection writes setup';

			await runStep('create app2 policy that writes only the text', async () => createPolicy(ENDPOINT.REST, {
				name: 'tenant-scoping-text-writer',
				version: '1',
				selection: { role: { '@eq': 'WRITER' } },
				config: [{
					verbs: ['GET', 'SEARCH', 'POST', 'PUT'],
					schema: ['note'],
					query: { access: '%FULL_ACCESS%' },
					projection: { keys: ['text'] },
				}],
			}, testEnv.apps.app2.token), scope);

			testEnv.users.app2Writer = await runStep('create app2 writer user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-writer', { role: 'WRITER' })
			, scope);
		});

		it('Should refuse a bulk update of a property the projection hides', async () => {
			const token = testEnv.users.app2Writer.tokens[0].value;

			await assert.rejects(bjsReq({
				url: notes('/bulk/update'),
				method: 'POST',
				headers: json,
				body: JSON.stringify([{ id: owned.note.id, body: [{ path: 'secret', value: 'by writer' }] }]),
			}, token), (err) => err instanceof BJSReqError && err.code === 403);

			const [note] = await bjsReq({ url: notes(), method: 'SEARCH', headers: json, body: JSON.stringify({ query: { id: owned.note.id } }) });
			assert.strictEqual(note.secret, 'app2 secret');
		});

		it('Should create entities without the properties the projection hides', async () => {
			const token = testEnv.users.app2Writer.tokens[0].value;

			const [one] = await bjsReq({
				url: notes(), method: 'POST', headers: json, body: JSON.stringify({ text: 'by writer', secret: 'set by writer' }),
			}, token);
			const many = await bjsReq({
				url: notes('/bulk/add'), method: 'POST', headers: json, body: JSON.stringify([{ text: 'by writer 2', secret: 'set by writer' }]),
			}, token);

			const stored = await bjsReq({
				url: notes(), method: 'SEARCH', headers: json,
				body: JSON.stringify({ query: { id: { $in: [one.id, ...many.map((n) => n.id)] } } }),
			});
			assert.strictEqual(stored.length, 2);
			for (const note of stored) assert.strictEqual(note.secret, null, JSON.stringify(note));
		});
	});
	describe('Creates limited by a policy query', () => {
		const notes = (path = '') => `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note${path}`;
		const json = { 'Content-Type': 'application/json' };
		const create = (path, body) => bjsReq({ url: notes(path), method: 'POST', headers: json, body: JSON.stringify(body) },
			testEnv.users.app2Scoped.tokens[0].value);

		before(async function () {
			this.timeout(20000);
			const scope = 'Policy query creates setup';

			await runStep('create app2 policy scoped to one text', async () => createPolicy(ENDPOINT.REST, {
				name: 'tenant-scoping-scoped',
				version: '1',
				selection: { role: { '@eq': 'SCOPED' } },
				config: [{ verbs: ['GET', 'SEARCH', 'POST'], schema: ['note'], query: { text: { '@eq': 'scoped' } } }],
			}, testEnv.apps.app2.token), scope);

			testEnv.users.app2Scoped = await runStep('create app2 scoped user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-scoped', { role: 'SCOPED' })
			, scope);
		});

		it("Should refuse to create an entity the policy's query doesn't read", async () => {
			for (const [path, body] of [['', { text: 'outside' }], ['', [{ text: 'scoped' }, { text: 'outside' }]], ['/bulk/add', [{ text: 'outside' }]]]) {
				await assert.rejects(create(path, body), (err) => err instanceof BJSReqError && err.code === 401, JSON.stringify(body));
			}

			const stored = await bjsReq({ url: notes(), method: 'SEARCH', headers: json, body: JSON.stringify({ query: { text: 'outside' } }) });
			assert.deepStrictEqual(stored, []);
		});

		it("Should still create an entity the policy's query reads", async () => {
			const [created] = await create('', { text: 'scoped' });
			assert.strictEqual(created.text, 'scoped');
		});
	});
	describe('App api paths', () => {
		const json = { 'Content-Type': 'application/json' };

		it("Should refuse to create an app with another app's api path, a reserved one, or one that isn't a plain name", async () => {
			for (const [apiPath, message] of [
				[testEnv.apps.app1.apiPath, 'duplicate_api_path'],
				[testEnv.apps.app1.apiPath.toUpperCase(), 'duplicate_api_path'],
				['lambda', 'reserved_api_path'],
				['plugin-thing', 'reserved_api_path'],
				['a/b', 'invalid_api_path'],
				['', 'invalid_api_path'],
			]) {
				await assert.rejects(createApp(ENDPOINT.REST, 'Clashing App', apiPath),
					(err) => err instanceof BJSReqError && err.code === 400 && err.message === message, apiPath);
			}
		});

		it("Should refuse to move an app to another app's api path", async () => {
			await assert.rejects(bjsReq({
				url: `${ENDPOINT.REST}/api/v1/app/${testEnv.apps.app1.id}`,
				method: 'PUT',
				headers: json,
				body: JSON.stringify([{ path: 'apiPath', value: testEnv.apps.app2.apiPath }]),
			}, testEnv.apps.app1.token), (err) => err instanceof BJSReqError && err.code === 400 && err.message === 'duplicate_api_path');

			const [app2] = await bjsReq({ url: `${ENDPOINT.REST}/api/v1/app`, method: 'SEARCH' }, testEnv.apps.app2.token);
			assert.strictEqual(app2.apiPath, testEnv.apps.app2.apiPath);
		});
	});
	describe('Looking a user up by token', () => {
		const byToken = (token, callerToken) => bjsReqPost(`${ENDPOINT.REST}/api/v1/user/get-by-token`, { token }, callerToken);

		it("Should refuse another app's user token, as an unknown token", async () => {
			await assert.rejects(byToken(testEnv.users.app2.tokens[0].value, testEnv.apps.app1.token),
				(err) => err instanceof BJSReqError && err.code === 400 && err.message === 'invalid_token');
		});

		it("Should still find the caller's own user, and any app's for a system token", async () => {
			const own = await byToken(testEnv.users.app1.tokens[0].value, testEnv.apps.app1.token);
			const other = await byToken(testEnv.users.app2.tokens[0].value);

			assert.strictEqual(own.id, testEnv.users.app1.id);
			assert.strictEqual(other.id, testEnv.users.app2.id);
		});
	});
	describe('Responses', () => {
		it('Should answer a lookup of an id that names nothing as not found, not as a server error', async () => {
			await assert.rejects(bjsReq({ url: `${ENDPOINT.REST}/api/v1/app/507f1f77bcf86cd799439011`, method: 'GET' }),
				(err) => err instanceof BJSReqError && err.code >= 400 && err.code < 500, 'app');
		});

		it('Should tell browsers not to send the URL on as a referrer', async () => {
			for (const url of [`${ENDPOINT.REST}/api/v1/app`, `${ENDPOINT.REST}/api/v1/check/admin`]) {
				const res = await fetch(url, { headers: { Authorization: `Bearer ${testEnv.apps.app1.token}` } });
				assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer', url);
			}
		});
	});
	describe('Policies with a limit', () => {
		const readNotes = (token) => bjsReq({ url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/note`, method: 'GET' }, token);
		const limitedPolicy = (role, limit) => ({
			name: `tenant-scoping-${role.toLowerCase()}`,
			version: '1',
			selection: { role: { '@eq': role } },
			config: [{ verbs: ['GET', 'SEARCH'], schema: ['note'], query: { access: '%FULL_ACCESS%' } }],
			limit,
		});

		before(async function () {
			this.timeout(20000);
			const scope = 'Policy limit setup';
			const day = 24 * 60 * 60 * 1000;

			await runStep('create an expired policy', async () =>
				createPolicy(ENDPOINT.REST, limitedPolicy('EXPIRED', new Date(Date.now() - day).toISOString()), testEnv.apps.app2.token)
			, scope);
			await runStep('create a policy that expires in two days', async () =>
				createPolicy(ENDPOINT.REST, limitedPolicy('LIMITED', new Date(Date.now() + 2 * day).toISOString()), testEnv.apps.app2.token)
			, scope);
			testEnv.users.app2Expired = await runStep('create app2 expired user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-expired', { role: 'EXPIRED' })
			, scope);
			testEnv.users.app2Limited = await runStep('create app2 limited user', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-limited', { role: 'LIMITED' })
			, scope);
		});

		it('Should grant nothing through a policy whose limit has passed', async () => {
			await assert.rejects(readNotes(testEnv.users.app2Expired.tokens[0].value),
				(err) => err instanceof BJSReqError && err.code === 403);
		});

		it('Should keep granting through a policy with a limit to come, once it comes from the cache', async () => {
			const token = testEnv.users.app2Limited.tokens[0].value;

			assert.ok((await readNotes(token)).length > 0);
			assert.ok((await readNotes(token)).length > 0);
		});
	});
});
