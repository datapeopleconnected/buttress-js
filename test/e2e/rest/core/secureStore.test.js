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

import { createApp, bjsReq, deleteApp, BJSReqError, ENDPOINT } from '../../../helpers.js';
import { runStep } from '../../helpers.js';

import BootstrapRest from '../../../../dist/bootstrap-rest.js';

let REST_PROCESS = null;

const testEnv = {
	apps: {},
	secureStores: {},
};

describe('Secure Store API', async () => {
	before(async function () {
		this.timeout(60000);

		await runStep(
			'init REST process',
			async () => {
				REST_PROCESS = new BootstrapRest();
				await REST_PROCESS.init();
			},
			'Secure Store API setup',
		);

		testEnv.apps.app1 = await runStep(
			'create app1',
			async () => createApp(ENDPOINT.REST, 'Test Secure Store API', 'test-secure-store-api-1'),
			'Secure Store API setup',
		);

		testEnv.apps.app2 = await runStep(
			'create app2',
			async () => createApp(ENDPOINT.REST, 'Test Secure Store API App 2', 'test-secure-store-api-2'),
			'Secure Store API setup',
		);

		testEnv.secureStores.app2 = await runStep(
			'create app2 secure store',
			async () => bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						name: 'app-2-private-secret',
						storeData: {
							client_secret: 'APP_2_SECRET',
						},
					}),
				},
				testEnv.apps.app2.token,
			),
			'Secure Store API setup',
		);
	});

	after(async function () {
		if (testEnv.apps.app1?.id) {
			await deleteApp(ENDPOINT.REST, testEnv.apps.app1.id);
		}

		if (testEnv.apps.app2?.id) {
			await deleteApp(ENDPOINT.REST, testEnv.apps.app2.id);
		}

		await REST_PROCESS.clean();
	});

	describe('Cross App Isolation', () => {
		it('Should not allow app1 to fetch app2 secure store by ID', async () => {
			try {
				await bjsReq(
					{
						url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.app2.id}`,
						method: 'GET',
						headers: { 'Content-Type': 'application/json' },
					},
					testEnv.apps.app1.token,
				);
				throw new Error('Expected app1 to be blocked from app2 secure store by ID');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.ok(error.code >= 400, 'Cross-app secure store fetch should be blocked');
			}
		});

		it('Should not allow app1 to find app2 secure store by name', async () => {
			try {
				await bjsReq(
					{
						url: `${ENDPOINT.REST}/api/v1/secure-store/name/${testEnv.secureStores.app2.name}`,
						method: 'GET',
						headers: { 'Content-Type': 'application/json' },
					},
					testEnv.apps.app1.token,
				);
				throw new Error('Expected app1 to be blocked from app2 secure store by name');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.ok(error.code >= 400, 'Cross-app secure store find should be blocked');
			}
		});

		it('Should not return app2 secure stores in app1 search results', async () => {
			const secureStores = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store`,
					method: 'SEARCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ query: { name: testEnv.secureStores.app2.name } }),
				},
				testEnv.apps.app1.token,
			);

			assert.ok(Array.isArray(secureStores), 'Secure store search should return an array');
			assert.strictEqual(secureStores.length, 0, 'Cross-app secure stores should not be returned in search');
		});

		it('Should not allow app1 to update app2 secure store', async () => {
			try {
				await bjsReq(
					{
						url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.app2.id}`,
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify([
							{
								path: 'storeData.client_secret',
								value: 'COMPROMISED_BY_APP_1',
							},
						]),
					},
					testEnv.apps.app1.token,
				);
				throw new Error('Expected app1 to be blocked from updating app2 secure store');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.ok(error.code >= 400, 'Cross-app secure store update should be blocked');
			}
		});

		it('Should not allow app1 to delete app2 secure store', async () => {
			try {
				await bjsReq(
					{
						url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.app2.id}`,
						method: 'DELETE',
						headers: { 'Content-Type': 'application/json' },
					},
					testEnv.apps.app1.token,
				);
				throw new Error('Expected app1 to be blocked from deleting app2 secure store');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.ok(error.code >= 400, 'Cross-app secure store delete should be blocked');
			}
		});
	});

	describe('AddSecureStore', () => {
		it('Should create a secure store with an app token', async () => {
			const payload = {
				name: 'google-credentials',
				storeData: {
					client_id: 'CLIENT_ID',
					client_secret: 'CLIENT_SECRET',
					redirect_uri: 'https://example.com/redirect',
				},
			};

			const secureStore = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				},
				testEnv.apps.app1.token,
			);

			testEnv.secureStores.primary = secureStore;

			assert.ok(secureStore.id, 'Secure store should have an ID');
			assert.strictEqual(secureStore.name, payload.name, 'Secure store name should match');
			assert.strictEqual(
				secureStore.storeData.client_secret,
				payload.storeData.client_secret,
				'Secure store payload should match',
			);
		});

		it('Should reject duplicate secure store names for an app', async () => {
			try {
				await bjsReq(
					{
						url: `${ENDPOINT.REST}/api/v1/secure-store`,
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							name: testEnv.secureStores.primary.name,
							storeData: { value: 'duplicate' },
						}),
					},
					testEnv.apps.app1.token,
				);
				throw new Error('Expected duplicate secure store creation to fail');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.strictEqual(error.code, 400, 'Error status code should be 400');
			}
		});
	});

	describe('Get and Find SecureStore', () => {
		it('Should fetch a secure store by ID', async () => {
			const secureStore = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.primary.id}`,
					method: 'GET',
					headers: { 'Content-Type': 'application/json' },
				},
				testEnv.apps.app1.token,
			);

			assert.ok(secureStore && !Array.isArray(secureStore), 'Secure store lookup should return an object');
			assert.strictEqual(secureStore.id, testEnv.secureStores.primary.id, 'Secure store ID should match');
			assert.strictEqual(secureStore.name, testEnv.secureStores.primary.name, 'Secure store name should match');
		});

		it('Should find a secure store by name', async () => {
			const secureStore = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store/name/${testEnv.secureStores.primary.name}`,
					method: 'GET',
					headers: { 'Content-Type': 'application/json' },
				},
				testEnv.apps.app1.token,
			);

			assert.strictEqual(secureStore.id, testEnv.secureStores.primary.id, 'Secure store ID should match');
			assert.strictEqual(secureStore.name, testEnv.secureStores.primary.name, 'Secure store name should match');
		});
	});

	describe('UpdateSecureStore', () => {
		it('Should update secure store data', async () => {
			const patch = [
				{
					path: 'storeData',
					value: {
						client_id: 'CLIENT_ID',
						client_secret: 'ROTATED_SECRET',
						redirect_uri: 'https://example.com/redirect',
					},
				},
			];

			const [update] = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.primary.id}`,
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(patch),
				},
				testEnv.apps.app1.token,
			);

			assert.strictEqual(update.path, 'storeData', 'Update path should be storeData');
			assert.strictEqual(update.type, 'scalar', 'Update type should be scalar');

			const secureStore = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.primary.id}`,
					method: 'GET',
					headers: { 'Content-Type': 'application/json' },
				},
				testEnv.apps.app1.token,
			);
			assert.strictEqual(
				secureStore.storeData.client_secret,
				'ROTATED_SECRET',
				'Secure store should return updated storeData',
			);
		});
	});

	describe('Search and Count SecureStore', () => {
		it('Should search secure stores with a name query', async () => {
			const secureStores = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store`,
					method: 'SEARCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ query: { name: testEnv.secureStores.primary.name } }),
				},
				testEnv.apps.app1.token,
			);

			assert.ok(Array.isArray(secureStores), 'Secure store search should return an array');
			assert.strictEqual(secureStores.length, 1, 'Secure store search should return one result');
			assert.strictEqual(secureStores[0].name, testEnv.secureStores.primary.name, 'Secure store name should match');
		});

		it('Should count secure stores with a name query', async () => {
			const count = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store/count`,
					method: 'SEARCH',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ query: { name: testEnv.secureStores.primary.name } }),
				},
				testEnv.apps.app1.token,
			);

			assert.strictEqual(count, 1, 'Secure store count should return one result');
		});
	});

	describe('DeleteSecureStore', () => {
		it('Should delete a secure store by ID', async () => {
			const response = await bjsReq(
				{
					url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.primary.id}`,
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
				},
				testEnv.apps.app1.token,
			);

			assert.strictEqual(response, true, 'Delete response should be true');

			try {
				const secureStoreList = await bjsReq(
					{
						url: `${ENDPOINT.REST}/api/v1/secure-store/${testEnv.secureStores.primary.id}`,
						method: 'GET',
						headers: { 'Content-Type': 'application/json' },
					},
					testEnv.apps.app1.token,
				);
				assert.ok(Array.isArray(secureStoreList), 'Deleted secure store lookup should return an array');
				assert.strictEqual(secureStoreList.length, 0, 'Deleted secure store lookup should return no results');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.ok(error.code >= 400, 'Error status code should be non-200 after deletion');
			}
		});
	});
});
