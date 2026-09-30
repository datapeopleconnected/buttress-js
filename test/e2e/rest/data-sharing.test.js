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

import { createApp, updateSchema, bjsReq, registerDataSharing, ENDPOINT } from '../../helpers.js';
import { runStep } from '../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';

let REST_PROCESS = null;

const testEnv = {
	apps: {},
	agreements: {},
	cars: [],
};

const createCar = async (app, name) => {
	const [car] = await bjsReq({
		url: `${ENDPOINT.REST}/${app.apiPath}/api/v1/car`,
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			name: name,
		}),
	}, app.token);
	testEnv.cars.push(car);
};

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Data Sharing', async () => {
	before(async function() {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, 'Data Sharing setup');

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
			},
		};

		testEnv.apps.app1 = await runStep('create app1', async () =>
			createApp(ENDPOINT.REST, 'Test App 1', 'data-sharing-app-1')
		, 'Data Sharing setup');
		testEnv.apps.app1.schema = await runStep('update app1 schema', async () =>
			updateSchema(ENDPOINT.REST, [carsSchema], testEnv.apps.app1.token)
		, 'Data Sharing setup');

		await runStep('create app1 seed car', async () =>
			createCar(testEnv.apps.app1, 'A red car')
		, 'Data Sharing setup');

		// Test app 2 doesn't need a schema from the start, we'll add one later.
		testEnv.apps.app2 = await runStep('create app2', async () =>
			createApp(ENDPOINT.REST, 'Test App 2', 'test-app-2')
		, 'Data Sharing setup');

		// Create a third app which will be used as a cars sources too.
		testEnv.apps.app3 = await runStep('create app3', async () =>
			createApp(ENDPOINT.REST, 'Test App 3', 'test-app-3')
		, 'Data Sharing setup');
		testEnv.apps.app3.schema = await runStep('update app3 schema', async () =>
			updateSchema(ENDPOINT.REST, [carsSchema], testEnv.apps.app3.token)
		, 'Data Sharing setup');

		await runStep('create app3 seed car', async () =>
			createCar(testEnv.apps.app3, 'A green car')
		, 'Data Sharing setup');
	});

	after(async function() {
		// Shutdown
		await REST_PROCESS.clean();
	});

	describe('Basics', async () => {
		it('Should register an agreement with the correct data fields', async () => {
			const name = `app1-to-app2`;
			const agreement = await registerDataSharing(ENDPOINT.REST, {
				name,

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
			}, testEnv.apps.app1.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT.REST);
			assert.strictEqual(agreement.remoteApp.ws, ENDPOINT.SOCK);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app2.apiPath);
			assert.strictEqual(agreement.remoteApp.token, null);
			assert.strictEqual(agreement.active, false);
			assert(agreement.registrationToken !== null && agreement.registrationToken !== undefined);
		});
	});

	describe('Creating a agreement', async () => {
		it('Should register a data sharing agreement between app1 and app2', async () => {
			const name = `app1-to-app2`;
			const agreement = await registerDataSharing(ENDPOINT.REST, {
				name,

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
			}, testEnv.apps.app1.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT.REST);
			assert.strictEqual(agreement.remoteApp.ws, ENDPOINT.SOCK);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app2.apiPath);
			assert.strictEqual(agreement.remoteApp.token, null);
			assert.strictEqual(agreement.active, false);
			assert(agreement.registrationToken !== null && agreement.registrationToken !== undefined);

			testEnv.agreements[name] = agreement;
		});

		it(`Should register a data sharing agreement between app2 and app1 & activate it`, async () => {
			const name = `app2-to-app1`;
			const agreement = await registerDataSharing(ENDPOINT.REST, {
				name,

				remoteApp: {
					endpoint: ENDPOINT.REST,
					ws: ENDPOINT.SOCK,
					apiPath: testEnv.apps.app1.apiPath,
					token: testEnv.agreements[`app1-to-app2`].registrationToken,
				},

				policyConfig: [{
					verbs: ['%ALL%'],
					schema: ['%ALL%'],
					query: {
						access: '%FULL_ACCESS%',
					},
				}],
			}, testEnv.apps.app2.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT.REST);
			assert.strictEqual(agreement.remoteApp.ws, ENDPOINT.SOCK);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app1.apiPath);
			assert.strictEqual(agreement.active, true);

			testEnv.agreements[name] = agreement;
		});

		const updatePolicy = async (agreement, app) => bjsReq({
			url: `${ENDPOINT.REST}/api/v1/app-data-sharing/${agreement.id}/policy`,
			method: 'PUT',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({car: ['READ']}),
		}, app.token);

		it(`Should update the policy of an app's own agreement`, async () => {
			const result = await updatePolicy(testEnv.agreements[`app1-to-app2`], testEnv.apps.app1);

			assert.strictEqual(result, true);
		});

		it(`Should refuse to update the policy of another app's agreement`, async () => {
			await assert.rejects(
				updatePolicy(testEnv.agreements[`app1-to-app2`], testEnv.apps.app2),
				(err) => err.code === 400 && err.message === 'unknown_data_sharing',
			);
		});

		it(`Should update app2 schema to reference cars collection from app1`, async () => {
			testEnv.apps.app2.schema = await updateSchema(ENDPOINT.REST, [{
				name: 'car',
				type: 'collection',
				remotes: [{
					name: 'app2-to-app1',
					schema: 'car',
				}],
			}], testEnv.apps.app2.token);

			assert(testEnv.apps.app2.schema[0].properties.id);
			assert(testEnv.apps.app2.schema[0].properties.name);
			assert(testEnv.apps.app2.schema[0].properties.sourceId);

			// Give Buttress time to create the routes.
			await new Promise((r) => setTimeout(r, 500));
		});

		it('Should be able to GET cars from App2 which will use data sharing to retrive data from App1', async function() {
			const cars = await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/car`,
				method: 'GET',
			}, testEnv.apps.app2.token);

			assert.strictEqual(cars.length, 1);
			assert.strictEqual(cars[0].id, testEnv.cars[0].id);
			assert.strictEqual(cars[0].name, testEnv.cars[0].name);
		});

		it('Should be able to POST cars from App2 which will save the data against App2 because no source is provided', async function() {
			const [result] = await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/car`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					name: 'A blue car',
				}),
			}, testEnv.apps.app2.token);
			testEnv.cars.push(result);

			assert(result.id !== null && result.id !== undefined);
			assert.strictEqual(result.name, 'A blue car');
		});

		it('Should be able to POST cars from App2 which will save the data against App1 because a source is provided', async function() {
			const [result] = await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/car`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					name: 'A purple car',
					sourceId: testEnv.cars[0].sourceId, // This should be the sourceId for app 1.
				}),
			}, testEnv.apps.app2.token);
			testEnv.cars.push(result);

			assert(result.id !== null && result.id !== undefined);
			assert.strictEqual(result.name, 'A purple car');
		});

		const app2Cars = (urlPath, opts = {}) => bjsReq({
			url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/car${urlPath}`,
			headers: {'Content-Type': 'application/json'},
			...opts,
		}, testEnv.apps.app2.token);
		const app1Cars = () => bjsReq({
			url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
			method: 'GET',
		}, testEnv.apps.app1.token);
		const forget = (car) => testEnv.cars.splice(testEnv.cars.indexOf(car), 1);

		it('Should find cars from App2 by a query, from App2 and App1', async function() {
			const cars = await app2Cars('', {method: 'SEARCH', body: JSON.stringify({query: {name: {$eq: 'A red car'}}})});

			assert.deepStrictEqual(cars.map((car) => car.id), [testEnv.cars[0].id]);
		});

		it('Should get one of App1\'s cars by id from App2', async function() {
			const car = await app2Cars(`/${testEnv.cars[0].id}`, {method: 'GET'});

			assert.strictEqual(car.name, 'A red car');
			assert.strictEqual(car.sourceId, testEnv.apps.app1.id);
		});

		it('Should update one of App1\'s cars from App2 by its source', async function() {
			const [red] = testEnv.cars;
			await app2Cars(`/${testEnv.apps.app1.id}/${red.id}`, {
				method: 'PUT',
				body: JSON.stringify({path: 'name', value: 'A dark red car'}),
			});
			red.name = 'A dark red car';

			const onApp1 = (await app1Cars()).find((car) => car.id === red.id);
			assert.strictEqual(onApp1.name, 'A dark red car');
		});

		it('Should delete one of App1\'s cars from App2 by its id', async function() {
			await createCar(testEnv.apps.app1, 'A scrap car');
			const scrap = testEnv.cars.at(-1);

			assert.strictEqual(await app2Cars(`/${scrap.id}`, {method: 'DELETE'}), true);
			forget(scrap);

			assert(!(await app1Cars()).some((car) => car.id === scrap.id), 'the car is still on App1');
		});

		it('Should delete one of App2\'s own cars from its collection with remotes', async function() {
			const blue = testEnv.cars.find((car) => car.name === 'A blue car');

			assert.strictEqual(await app2Cars(`/${blue.id}`, {method: 'DELETE'}), true);
			forget(blue);

			assert(!(await app2Cars('', {method: 'GET'})).some((car) => car.id === blue.id), 'the car is still on App2');
		});
	});

	describe('Handling mutiple agreement sources', async () => {
		it('Should register a data sharing agreement between app3 and app2', async () => {
			const name = `app3-to-app2`;
			const agreement = await registerDataSharing(ENDPOINT.REST, {
				name,

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
			}, testEnv.apps.app3.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT.REST);
			assert.strictEqual(agreement.remoteApp.ws, ENDPOINT.SOCK);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app2.apiPath);
			assert.strictEqual(agreement.remoteApp.token, null);
			assert.strictEqual(agreement.active, false);
			assert(agreement.registrationToken !== null && agreement.registrationToken !== undefined);

			testEnv.agreements[name] = agreement;
		});

		it(`Should register a data sharing agreement between app2 and app1 & activate it`, async () => {
			const name = `app2-to-app3`;
			const agreement = await registerDataSharing(ENDPOINT.REST, {
				name,

				remoteApp: {
					endpoint: ENDPOINT.REST,
					ws: ENDPOINT.SOCK,
					apiPath: testEnv.apps.app3.apiPath,
					token: testEnv.agreements[`app3-to-app2`].registrationToken,
				},

				policyConfig: [{
					verbs: ['%ALL%'],
					schema: ['%ALL%'],
					query: {
						access: '%FULL_ACCESS%',
					},
				}],
			}, testEnv.apps.app2.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT.REST);
			assert.strictEqual(agreement.remoteApp.ws, ENDPOINT.SOCK);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app3.apiPath);
			assert.strictEqual(agreement.active, true);

			testEnv.agreements[name] = agreement;
		});

		it(`Should update app2 schema to reference cars collection from app1 & app2`, async () => {
			testEnv.apps.app2.schema = await updateSchema(ENDPOINT.REST, [{
				name: 'car',
				type: 'collection',
				remotes: [{
					name: 'app2-to-app1',
					schema: 'car',
				}, {
					name: 'app2-to-app3',
					schema: 'car',
				}],
			}], testEnv.apps.app2.token);

			// Give Buttress time to create the routes.
			await new Promise((r) => setTimeout(r, 500));
		});

		it('Should be able to GET cars from App2 which will use data sharing to retrive data from App1 & App3 combined', async function() {
			this.timeout(20000);
			const cars = await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/car`,
				method: 'GET',
				headers: {'mode': 'no-cors'},
			}, testEnv.apps.app2.token);

			assert.strictEqual(cars.length, testEnv.cars.length);

			for (const expectedCar of testEnv.cars) {
				const car = cars.find((c) => c.name === expectedCar.name);
				assert(car, `Expected car "${expectedCar.name}" not found in response`);
				assert.strictEqual(car.id, expectedCar.id);
				assert.strictEqual(car.name, expectedCar.name);
			}
		});
	});

	describe('Deactivating an agreement', async () => {
		// The names of app1's cars that app2 can read through its agreement
		const app1CarsReadByApp2 = async () => {
			try {
				const cars = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/car`,
					method: 'GET',
				}, testEnv.apps.app2.token);
				return cars.filter((car) => car.sourceId === testEnv.apps.app1.id).map((car) => car.name);
			} catch (err) {
				return [];
			}
		};
		const setActive = (active) => bjsReq({
			url: `${ENDPOINT.REST}/api/v1/app-data-sharing/${active ? 'reactivate' : 'deactivate'}/${testEnv.agreements['app1-to-app2'].id}`,
			method: 'PUT',
		}, testEnv.apps.app1.token);

		it('Should stop the partner reading the app\'s data once the app deactivates its agreement', async function() {
			this.timeout(20000);
			assert((await app1CarsReadByApp2()).length > 0, 'app2 reads app1\'s cars to begin with');

			await setActive(false);

			assert.deepStrictEqual(await app1CarsReadByApp2(), []);
		});

		it('Should not let the partner activate an agreement the app deactivated', async function() {
			const res = await fetch(`${ENDPOINT.REST}/api/v1/app-data-sharing/activate`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${testEnv.agreements['app2-to-app1'].remoteApp.token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ newToken: 'a-token-of-the-partner' }),
			});

			assert.strictEqual(res.status, 401);
			assert.strictEqual(await app1CarsReadByApp2().then((names) => names.length), 0);
		});

		it('Should let the partner read the app\'s data again once the app reactivates its agreement', async function() {
			this.timeout(20000);
			await setActive(true);

			assert((await app1CarsReadByApp2()).length > 0, 'app2 reads app1\'s cars again');
		});
	});
});
