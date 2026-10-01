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

import {
	createApp,
	createPolicy,
	createPolicyUser,
	updatePolicyPropertyList,
	updateSchema,
	deleteApp,
	bjsReqPost,
	ENDPOINT,
} from '../../helpers.js';
import { runStep } from '../helpers.js';
import Config from '../../config.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';

// Every error is answered with one body shape, `{code, message, details?}`, and each condition with one status and
// code, wherever it's found: before any route, in a core route or in an app's schema route.
describe('Error contract', async () => {
	const testEnv = {
		apps: {},
		users: {},
	};

	let REST_PROCESS = null;

	before(async function () {
		this.timeout(60000);
		const scope = 'Error contract setup';

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, scope);

		testEnv.apps.app = await runStep('create app', async () =>
			createApp(ENDPOINT.REST, 'Test Error Contract', 'test-error-contract')
		, scope);
		testEnv.apps.other = await runStep('create another app', async () =>
			createApp(ENDPOINT.REST, 'Test Error Contract Other', 'test-error-contract-other')
		, scope);

		for (const app of ['app', 'other']) {
			await runStep(`add the note and crate schemas to ${app}`, async () => updateSchema(ENDPOINT.REST, [{
				name: 'note',
				type: 'collection',
				properties: {
					text: { __type: 'string', __default: null, __required: true, __allowUpdate: true },
					due: { __type: 'date', __default: null, __required: false, __allowUpdate: true },
					done: { __type: 'boolean', __default: false, __required: false, __allowUpdate: true },
					serial: { __type: 'string', __default: null, __required: false, __allowUpdate: false },
				},
			}, {
				// It refuses fields it doesn't define
				name: 'crate',
				type: 'collection',
				strict: true,
				properties: {
					label: { __type: 'string', __default: null, __required: false, __allowUpdate: true },
					// No two crates share one
					code: { __type: 'string', __default: null, __required: false, __allowUpdate: true, __unique: true },
				},
			}], testEnv.apps[app].token), scope);
		}

		// A user no policy applies to
		testEnv.users.unpoliced = await runStep('create a user without policies', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app, 'error-contract-user', {})
		, scope);

		// A user whose policy reads and writes only the notes it wrote
		for (const app of ['app', 'other']) {
			await runStep(`allow the role policy property on ${app}`, async () =>
				updatePolicyPropertyList(ENDPOINT.REST, { role: ['WRITER', 'NOBODY'] }, testEnv.apps[app].token)
			, scope);
		}
		await runStep('create the writer policy', async () => createPolicy(ENDPOINT.REST, {
			name: 'error-contract-writer',
			version: '1',
			selection: { role: { '@eq': 'WRITER' } },
			config: [{ verbs: ['GET', 'SEARCH', 'POST', 'PUT', 'DELETE'], schema: ['note'], query: { text: { '@eq': 'mine' } } }],
		}, testEnv.apps.app.token), scope);
		testEnv.users.writer = await runStep('create the writer user', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app, 'error-contract-writer', { role: 'WRITER' })
		, scope);

		// Policies no token holds, to look up by id
		testEnv.policy = await runStep('create a policy', async () => createPolicy(ENDPOINT.REST, {
			name: 'error-contract-policy',
			version: '1',
			selection: { role: { '@eq': 'NOBODY' } },
			config: [{ verbs: ['GET'], schema: ['note'], query: { access: '%FULL_ACCESS%' } }],
		}, testEnv.apps.app.token), scope);
		testEnv.otherPolicy = await runStep("create the other app's policy", async () => createPolicy(ENDPOINT.REST, {
			name: 'error-contract-other-policy',
			version: '1',
			selection: { role: { '@eq': 'NOBODY' } },
			config: [{ verbs: ['GET'], schema: ['note'], query: { access: '%FULL_ACCESS%' } }],
		}, testEnv.apps.other.token), scope);

		// Adding one entity answers with a list of the one
		[testEnv.note] = [].concat(await runStep('add a note', async () =>
			bjsReqPost(notes(), { text: 'not mine' }, testEnv.apps.app.token)
		, scope));
		[testEnv.otherNote] = [].concat(await runStep("add a note to the other app", async () =>
			bjsReqPost(`${ENDPOINT.REST}/${testEnv.apps.other.apiPath}/api/v1/note`, { text: 'theirs' }, testEnv.apps.other.token)
		, scope));
	});

	after(async function () {
		for (const app of Object.values(testEnv.apps)) {
			if (app?.id) await deleteApp(ENDPOINT.REST, app.id);
		}

		await REST_PROCESS.clean();
	});

	const appToken = () => testEnv.apps.app.token;
	const writerToken = () => testEnv.users.writer.tokens[0].value;
	const notes = (path = '') => `${ENDPOINT.REST}/${testEnv.apps.app.apiPath}/api/v1/note${path}`;
	const core = (path) => `${ENDPOINT.REST}/api/v1/${path}`;
	const json = { 'Content-Type': 'application/json' };
	const put = (body) => ({ method: 'PUT', headers: json, body: JSON.stringify(body) });
	const post = (body) => ({ method: 'POST', headers: json, body: JSON.stringify(body) });
	// A well-formed id nothing has
	const NOBODYS_ID = '6abd0000000000000000dead';

	// [condition, () => [url, fetch options, token (undefined for none)], status, code, details (undefined to skip)]
	const table = [
		['a malformed JSON body', () => [notes(), { method: 'POST', headers: json, body: '{"text":' }, appToken()],
			400, 'invalid_body'],
		['a path no route takes', () => [`${ENDPOINT.REST}/api/v1/nothing-here`, { method: 'GET' }, appToken()],
			404, 'unknown_route', { method: 'GET', path: '/api/v1/nothing-here' }],
		['no token', () => [notes(), { method: 'GET' }], 401, 'missing_token'],
		['a token nobody has', () => [notes(), { method: 'GET' }, 'not-a-token-anybody-has'], 401, 'invalid_token'],
		['?apiPath= naming another app', () => [`${ENDPOINT.REST}/api/v1/app/schema?apiPath=another-app`, { method: 'GET' }, appToken()],
			400, 'apiPath_not_supported', { apiPath: 'test-error-contract' }],
		["an app token on another app's route", () => [`${ENDPOINT.REST}/${testEnv.apps.other.apiPath}/api/v1/note`, { method: 'GET' }, appToken()],
			403, 'insufficient_authority'],
		['a token no policy lets read the schema', () => [notes(), { method: 'GET' }, testEnv.users.unpoliced.tokens[0].value],
			403, 'access_denied'],
		['a token no policy lets call the core route', () => [`${ENDPOINT.REST}/api/v1/user`, { method: 'GET' }, testEnv.users.unpoliced.tokens[0].value],
			403, 'access_denied'],
		['a lambda endpoint no lambda has', () => [`${ENDPOINT.REST}/lambda/v1/${testEnv.apps.app.apiPath}/nothing/here`, { method: 'GET' }, appToken()],
			404, 'unknown_lambda_endpoint'],
		['a system token for an admin route, given in the URL', () => [`${ENDPOINT.REST}/api/v1/admin/activate/${Config.testToken}`, { method: 'GET' }],
			400, 'token_in_url_not_supported'],

		// Ids that name nothing the caller can reach, and ids that can't be one
		['a policy id nothing has', () => [core(`policy/${NOBODYS_ID}`), { method: 'GET' }, appToken()],
			404, 'not_found', () => ({ schema: 'policy', id: NOBODYS_ID })],
		["another app's policy id", () => [core(`policy/${testEnv.otherPolicy.id}`), { method: 'GET' }, appToken()],
			404, 'not_found', () => ({ schema: 'policy', id: testEnv.otherPolicy.id })],
		['a policy id that is not an id', () => [core('policy/not-an-id'), { method: 'GET' }, appToken()],
			400, 'invalid_id'],
		["an update to another app's policy", () => [core(`policy/${testEnv.otherPolicy.id}`), put([{ path: 'name', value: 'x' }]), appToken()],
			404, 'not_found'],
		['a lambda id nothing has', () => [core(`lambda/${NOBODYS_ID}`), { method: 'GET' }, appToken()],
			404, 'not_found', () => ({ schema: 'lambda', id: NOBODYS_ID })],
		['a user id nothing has', () => [core(`user/${NOBODYS_ID}`), { method: 'GET' }, appToken()],
			404, 'not_found', () => ({ schema: 'user', id: NOBODYS_ID })],
		['a secure store id nothing has', () => [core(`secure-store/${NOBODYS_ID}`), { method: 'GET' }, appToken()],
			404, 'not_found', () => ({ schema: 'secureStore', id: NOBODYS_ID })],
		['a data sharing agreement id nothing has', () => [core(`app-data-sharing/${NOBODYS_ID}`), { method: 'GET' }, appToken()],
			404, 'not_found'],
		['a note id nothing has', () => [notes(`/${NOBODYS_ID}`), { method: 'GET' }, appToken()],
			404, 'not_found', () => ({ schema: 'note', id: NOBODYS_ID })],
		["another app's note id", () => [notes(`/${testEnv.otherNote.id}`), { method: 'GET' }, appToken()],
			404, 'not_found'],
		['a note id that is not an id', () => [notes('/not-an-id'), { method: 'DELETE' }, appToken()],
			400, 'invalid_id'],
		["a note the caller's policy doesn't read", () => [notes(`/${testEnv.note.id}`), { method: 'GET' }, writerToken()],
			404, 'not_found'],
		["an update to a note the caller's policy doesn't read", () => [notes(`/${testEnv.note.id}`), put({ path: 'text', value: 'mine' }), writerToken()],
			404, 'not_found'],

		// Bodies the schema refuses
		['a note whose done flag is not a boolean', () => [notes(), post({ text: 'a', done: 'banana' }), appToken()],
			400, 'invalid_value', {
				schema: 'note', path: 'done', issues: [{ path: 'done', code: 'type', expected: 'boolean', received: 'string' }],
			}],
		['a search on a flag it cannot read', () => [notes(), { method: 'SEARCH', headers: json, body: JSON.stringify({ query: { done: 'banana' } }) }, appToken()],
			400, 'invalid_value', { path: 'done', expected: 'boolean' }],
		['a field a strict schema does not define', () => [`${ENDPOINT.REST}/${testEnv.apps.app.apiPath}/api/v1/crate`, post({ label: 'a', extra: 1 }), appToken()],
			400, 'unknown_path', { schema: 'crate', path: 'extra', issues: [{ path: 'extra', code: 'unknown_path' }] }],
		['a schema with a misspelt property key', () => [core('app/schema'), put([{ name: 'note', type: 'collection', properties: { text: { __type: 'string', __requried: true } } }]), appToken()],
			400, 'invalid_schema', { schema: 'note', issues: [{ path: 'text.__requried', code: 'unknown_path' }] }],
		['a policy whose config has no query', () => [core('policy'), post({ name: 'no-query', version: '1', selection: { role: { '@eq': 'NOBODY' } }, config: [{ verbs: ['GET'], schema: ['note'] }] }), appToken()],
			400, 'invalid_policy', { issues: [{ path: 'config.0.query', code: 'required' }] }],
		['a policy whose priority is not a number', () => [core('policy'), post({ name: 'bad-priority', version: '1', priority: 'high', selection: { role: { '@eq': 'NOBODY' } }, config: [{ verbs: ['GET'], schema: ['note'], query: { access: '%FULL_ACCESS%' } }] }), appToken()],
			400, 'invalid_value', { schema: 'policy', path: 'priority', issues: [{ path: 'priority', code: 'type', expected: 'number', received: 'string' }] }],
		['a lambda whose endpoint method is not one it takes', () => [core('lambda'), post({
			lambda: {
				name: 'bad-method',
				git: { url: Config.paths.root, branch: 'develop', hash: 'HEAD', entryFile: 'test/data/lambda/hello-world.cjs', entryPoint: 'execute' },
				trigger: [{ type: 'API_ENDPOINT', apiEndpoint: { method: 'PUT', url: 'bad-method' } }],
			},
			auth: { domains: ['localhost'], policyProperties: {} },
		}), appToken()],
			400, 'invalid_value', {
				schema: 'lambda', path: 'trigger.0.apiEndpoint.method',
				issues: [{ path: 'trigger.0.apiEndpoint.method', code: 'enum', expected: ['GET', 'POST'], received: 'string' }],
			}],
		['a note without its required text', () => [notes(), post({}), appToken()],
			400, 'missing_field', { schema: 'note', path: 'text', issues: [{ path: 'text', code: 'required' }] }],
		['a batch of notes whose second lacks its text', () => [notes('/bulk/add'), post([{ text: 'a' }, {}]), appToken()],
			400, 'missing_field', { schema: 'note', path: 'text', index: 1, issues: [{ path: 'text', code: 'required' }] }],
		['a batch of notes that gives an id twice', () => [notes('/bulk/add'), post([{ id: NOBODYS_ID, text: 'a' }, { id: NOBODYS_ID, text: 'b' }]), appToken()],
			400, 'duplicate_id', { schema: 'note', id: NOBODYS_ID, index: 1 }],
		['an update to a path the note has not got', () => [notes(`/${testEnv.note.id}`), put({ path: 'nothing', value: 1 }), appToken()],
			400, 'invalid_update', { schema: 'note', issues: [{ path: 'nothing', code: 'unknown_path' }] }],
		['an update to a property that does not allow updates', () => [notes(`/${testEnv.note.id}`), put({ path: 'serial', value: 'x' }), appToken()],
			400, 'invalid_update', { schema: 'note', issues: [{ path: 'serial', code: 'immutable' }] }],
		['a note update that lists every problem', () => [notes(`/${testEnv.note.id}`), put([{ path: 'done', value: 'banana' }, { path: 'nothing', value: 1 }]), appToken()],
			400, 'invalid_update', {
				schema: 'note',
				issues: [{ path: 'done', code: 'type', expected: 'boolean', received: 'string' }, { path: 'nothing', code: 'unknown_path' }],
			}],
		['a policy update to a path policies have not got', () => [core(`policy/${testEnv.policy.id}`), put([{ path: 'nothing', value: 1 }]), appToken()],
			400, 'invalid_update'],
		["a note the caller's policy wouldn't let it read", () => [notes(), post({ text: 'not mine' }), writerToken()],
			403, 'access_denied', { schema: 'note', index: 0 }],
		['a search on a date it cannot read', () => [notes(), { method: 'SEARCH', headers: json, body: JSON.stringify({ query: { due: { $gtDate: 'not a date' } } }) }, appToken()],
			400, 'invalid_value', { path: 'due', expected: 'date' }],
	];

	for (const [condition, request, status, code, details] of table) {
		it(`Should answer ${condition} with ${status} ${code}`, async () => {
			const [url, opts, token] = request();
			const headers = { ...opts.headers, ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) };
			const res = await fetch(url, { ...opts, headers });

			assert.strictEqual(res.status, status);
			assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
			const body = await res.json();
			assert.deepStrictEqual(Object.keys(body).filter((key) => key !== 'details'), ['code', 'message'], JSON.stringify(body));
			assert.strictEqual(body.code, code, JSON.stringify(body));
			assert.strictEqual(typeof body.message, 'string');
			assert.ok(body.message.length > 0);
			if (details !== undefined) assert.deepStrictEqual(body.details, typeof details === 'function' ? details() : details);
		});
	}

	it('Should refuse a second crate with the code of the first, and take any number without one', async () => {
		const crates = `${ENDPOINT.REST}/${testEnv.apps.app.apiPath}/api/v1/crate`;
		await bjsReqPost(crates, { label: 'first', code: 'C-1' }, appToken());
		await bjsReqPost(crates, { label: 'no code' }, appToken());
		await bjsReqPost(crates, { label: 'no code either' }, appToken());

		const res = await fetch(crates, { ...post({ label: 'second', code: 'C-1' }), headers: { ...json, Authorization: `Bearer ${appToken()}` } });

		assert.strictEqual(res.status, 400);
		const body = await res.json();
		assert.strictEqual(body.code, 'duplicate');
		assert.deepStrictEqual(body.details, { path: 'code' });
	});

	it('Should drop a field a schema that is not strict does not define', async () => {
		const [note] = [].concat(await bjsReqPost(notes(), { text: 'kept', extra: 1 }, appToken()));

		assert.strictEqual(note.text, 'kept');
		assert.strictEqual(note.extra, undefined);
	});

	it("Should report each refused item of a bulk update with the status and body its request would have had", async () => {
		const res = await fetch(notes('/bulk/update'), {
			method: 'POST',
			headers: { ...json, Authorization: `Bearer ${appToken()}` },
			body: JSON.stringify([
				{ id: testEnv.note.id, body: { path: 'nothing', value: 1 } },
				{ id: NOBODYS_ID, body: { path: 'text', value: 'x' } },
			]),
		});

		assert.strictEqual(res.status, 200);
		const [invalid, missing] = await res.json();
		assert.deepStrictEqual({ ...invalid.validation, message: undefined }, {
			status: 400, code: 'invalid_update', message: undefined, details: { schema: 'note', issues: [{ path: 'nothing', code: 'unknown_path' }] },
		});
		assert.deepStrictEqual(missing.validation, {
			status: 404, code: 'not_found', message: 'No note was found with that id', details: { schema: 'note', id: NOBODYS_ID },
		});
	});
});
