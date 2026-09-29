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

import { createApp, createPolicyUser, bjsReq, deleteApp, ENDPOINT } from '../../../helpers.js';
import { runStep } from '../../helpers.js';

import BootstrapRest from '../../../../dist/bootstrap-rest.js';

// Core search and count routes, called with an app token and no request body, return only the calling
// app's entities.
describe('Core search tenant scoping', async () => {
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
		}, 'Core search tenant scoping setup');

		testEnv.apps.app1 = await runStep('create app1', async () =>
			createApp(ENDPOINT.REST, 'Test Tenant Scoping 1', 'test-tenant-scoping-1')
		, 'Core search tenant scoping setup');
		testEnv.apps.app2 = await runStep('create app2', async () =>
			createApp(ENDPOINT.REST, 'Test Tenant Scoping 2', 'test-tenant-scoping-2')
		, 'Core search tenant scoping setup');

		testEnv.users.app1 = await runStep('create app1 user', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'tenant-scoping-user1', {})
		, 'Core search tenant scoping setup');
		testEnv.users.app2 = await runStep('create app2 user', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app2, 'tenant-scoping-user2', {})
		, 'Core search tenant scoping setup');
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
});
