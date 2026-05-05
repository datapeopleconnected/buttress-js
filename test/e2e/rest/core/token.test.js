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

import { createApp, bjsReq, createPolicyUser, deleteApp, ENDPOINT } from '../../../helpers.js';
import { runStep } from '../../helpers.js';

import BootstrapRest from '../../../../dist/bootstrap-rest.js';

let REST_PROCESS = null;

const testEnv = {
	apps: {},
	users: {},
};

describe('Token API', async () => {
	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, 'Token API setup');

		testEnv.apps.app1 = await runStep('create app1', async () =>
			createApp(ENDPOINT.REST, 'Test Token API', 'test-token-api-1')
		, 'Token API setup');

		testEnv.users.user1 = await runStep('create token-test-user1', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'token-test-user1', {})
		, 'Token API setup');
	});

	after(async function () {
		await deleteApp(ENDPOINT.REST, testEnv.apps.app1.id);

		// Shutdown
		await REST_PROCESS.clean();
	});

	describe('GetTokenList', async () => {
		it('Should list all tokens in the system after a GET with a system token', async () => {
			const tokens = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			});

			assert.strictEqual(tokens.length, 3, "Tokens length should be 2, System and App1");
		});

		it('Should list all tokens in the system after a GET with a app token', async () => {
			const tokens = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(tokens.length, 2, "Tokens length should be 1, App1");
		});
	});

	describe('DeleteAllTokens', () => {
		it('Should delete all tokens in the system with a system token', async () => {
			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token`,
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' }
			});

			assert.strictEqual(response, true, "Response should be true");

			const tokens = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			});

			assert.strictEqual(tokens.length, 1, "Tokens length should be 1 after deletion by system");

			// Prepare space for next test
			await deleteApp(ENDPOINT.REST, testEnv.apps.app1.id);

			testEnv.apps.app1 = await createApp(ENDPOINT.REST, 'Test Token API', 'test-token-api-1');
			testEnv.users.user1 = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'token-test-user1', {});
		});

		it('Should delete all tokens for an app with an app token', async () => {
			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token`,
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, "Response should be true");

			const tokens = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(tokens.length, 1, "Tokens length should be 1 after deletion by app");
		});
	});

	describe('SearchUserToken', () => {
		before(async function () {
			testEnv.users.user1 = await runStep('recreate token-test-user1', async () =>
				createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'token-test-user1', {})
			, 'Token API search setup');
		});

		it('Should search and return tokens for a specific user with a system token', async () => {
			const tokens = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token/${testEnv.users.user1.id}`,
				method: 'SEARCH',
				headers: { 'Content-Type': 'application/json' }
			});

			assert.strictEqual(tokens.length, 1, "Tokens length should be 1 for the user");
		});

		it('Should search and return tokens for a specific user with an app token', async () => {
			const tokens = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/token/${testEnv.users.user1.id}`,
				method: 'SEARCH',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(tokens.length, 1, "Tokens length should be 1 for the user");
		});
	});
});
