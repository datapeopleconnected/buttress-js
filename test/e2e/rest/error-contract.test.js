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
	createPolicyUser,
	updateSchema,
	deleteApp,
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
			await runStep(`add the note schema to ${app}`, async () => updateSchema(ENDPOINT.REST, [{
				name: 'note',
				type: 'collection',
				properties: {
					text: { __type: 'string', __default: null, __required: true, __allowUpdate: true },
				},
			}], testEnv.apps[app].token), scope);
		}

		// A user no policy applies to
		testEnv.users.unpoliced = await runStep('create a user without policies', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app, 'error-contract-user', {})
		, scope);
	});

	after(async function () {
		for (const app of Object.values(testEnv.apps)) {
			if (app?.id) await deleteApp(ENDPOINT.REST, app.id);
		}

		await REST_PROCESS.clean();
	});

	const appToken = () => testEnv.apps.app.token;
	const notes = (path = '') => `${ENDPOINT.REST}/${testEnv.apps.app.apiPath}/api/v1/note${path}`;
	const json = { 'Content-Type': 'application/json' };

	// [condition, () => [url, fetch options, token (undefined for none)], status, code, details (undefined to skip)]
	const table = [
		['a malformed JSON body', () => [notes(), { method: 'POST', headers: json, body: '{"text":' }, appToken()],
			400, 'invalid_body'],
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
			if (details !== undefined) assert.deepStrictEqual(body.details, details);
		});
	}
});
