/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

const {describe, it, before, after} = require('mocha');
const assert = require('assert');

const {createApp, updateSchema, bjsReq, registerDataSharing} = require('../../helpers');

const BootstrapRest = require('../../../dist/bootstrap-rest');

let REST_PROCESS = null;
const ENDPOINT = `https://test.local.buttressjs.com`;

const testEnv = {
	apps: {},
	agreements: {},
	cars: [],
};

const createCar = async (app, name) => {
	const [car] = await bjsReq({
		url: `${ENDPOINT}/${app.apiPath}/api/v1/car`,
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
		// this.timeout(20000);

		REST_PROCESS = new BootstrapRest();

		await REST_PROCESS.init();

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

		testEnv.apps.app1 = await createApp(ENDPOINT, 'Test App 1', 'test-app-1');
		testEnv.apps.app1.schema = await updateSchema(ENDPOINT, [carsSchema], testEnv.apps.app1.token);

		await createCar(testEnv.apps.app1, 'A red car');

		// Test app 2 doesn't need a schema from the start, we'll add one later.
		testEnv.apps.app2 = await createApp(ENDPOINT, 'Test App 2', 'test-app-2');

		// Create a third app which will be used as a cars sources too.
		testEnv.apps.app3 = await createApp(ENDPOINT, 'Test App 3', 'test-app-3');
		testEnv.apps.app3.schema = await updateSchema(ENDPOINT, [carsSchema], testEnv.apps.app3.token);

		await createCar(testEnv.apps.app3, 'A green car');
	});

	after(async function() {
		// Shutdown
		await REST_PROCESS.clean();
	});

	describe('Creating a agreement', async () => {
		it('Should register a data sharing agreement between app1 and app2', async () => {
			const name = `app1-to-app2`;
			const agreement = await registerDataSharing(ENDPOINT, {
				name,

				remoteApp: {
					endpoint: ENDPOINT,
					apiPath: testEnv.apps.app2.apiPath,
					token: null,
				},

				policy: [{
					endpoints: ['%ALL%'],
					query: [{
						schema: ['%ALL%'],
						access: '%FULL_ACCESS%',
					}],
				}],
			}, testEnv.apps.app1.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app2.apiPath);
			assert.strictEqual(agreement.remoteApp.token, null);
			assert.strictEqual(agreement.active, false);
			assert(agreement.registrationToken !== null && agreement.registrationToken !== undefined);

			testEnv.agreements[name] = agreement;
		});

		it(`Should register a data sharing agreement between app2 and app1 & activate it`, async () => {
			const name = `app2-to-app1`;
			const agreement = await registerDataSharing(ENDPOINT, {
				name,

				remoteApp: {
					endpoint: ENDPOINT,
					apiPath: testEnv.apps.app1.apiPath,
					token: testEnv.agreements[`app1-to-app2`].registrationToken,
				},

				policy: [{
					endpoints: ['%ALL%'],
					query: [{
						schema: ['%ALL%'],
						access: '%FULL_ACCESS%',
					}],
				}],
			}, testEnv.apps.app2.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app1.apiPath);
			assert.strictEqual(agreement.active, true);

			testEnv.agreements[name] = agreement;
		});

		it(`Should update app2 schema to reference cars collection from app1`, async () => {
			testEnv.apps.app2.schema = await updateSchema(ENDPOINT, [{
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
				url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
				method: 'GET',
			}, testEnv.apps.app2.token);

			assert.strictEqual(cars.length, 1);
			assert.strictEqual(cars[0].id, testEnv.cars[0].id);
			assert.strictEqual(cars[0].name, testEnv.cars[0].name);
		});

		it('Should be able to POST cars from App2 which will save the data against App2 because no source is provided', async function() {
			const [result] = await bjsReq({
				url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
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
				url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
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
	});

	describe('Handling mutiple agreement sources', async () => {
		it('Should register a data sharing agreement between app3 and app2', async () => {
			const name = `app3-to-app2`;
			const agreement = await registerDataSharing(ENDPOINT, {
				name,

				remoteApp: {
					endpoint: ENDPOINT,
					apiPath: testEnv.apps.app2.apiPath,
					token: null,
				},

				policy: [{
					endpoints: ['%ALL%'],
					query: [{
						schema: ['%ALL%'],
						access: '%FULL_ACCESS%',
					}],
				}],
			}, testEnv.apps.app3.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app2.apiPath);
			assert.strictEqual(agreement.remoteApp.token, null);
			assert.strictEqual(agreement.active, false);
			assert(agreement.registrationToken !== null && agreement.registrationToken !== undefined);

			testEnv.agreements[name] = agreement;
		});

		it(`Should register a data sharing agreement between app2 and app1 & activate it`, async () => {
			const name = `app2-to-app3`;
			const agreement = await registerDataSharing(ENDPOINT, {
				name,

				remoteApp: {
					endpoint: ENDPOINT,
					apiPath: testEnv.apps.app3.apiPath,
					token: testEnv.agreements[`app3-to-app2`].registrationToken,
				},

				policy: [{
					endpoints: ['%ALL%'],
					query: [{
						schema: ['%ALL%'],
						access: '%FULL_ACCESS%',
					}],
				}],
			}, testEnv.apps.app2.token);

			assert.strictEqual(agreement.name, name);
			assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT);
			assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app3.apiPath);
			assert.strictEqual(agreement.active, true);

			testEnv.agreements[name] = agreement;
		});

		it(`Should update app2 schema to reference cars collection from app1 & app2`, async () => {
			testEnv.apps.app2.schema = await updateSchema(ENDPOINT, [{
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
				url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
				method: 'GET',
				headers: {'mode': 'no-cors'},
			}, testEnv.apps.app2.token);

			assert.strictEqual(cars.length, testEnv.cars.length);
			assert.strictEqual(cars[0].id, testEnv.cars[0].id);
			assert.strictEqual(cars[0].name, testEnv.cars[0].name);

			assert.strictEqual(cars[1].id, testEnv.cars[1].id);
			assert.strictEqual(cars[1].name, testEnv.cars[1].name);

			assert.strictEqual(cars[2].id, testEnv.cars[2].id);
			assert.strictEqual(cars[2].name, testEnv.cars[2].name);

			assert.strictEqual(cars[3].id, testEnv.cars[3].id);
			assert.strictEqual(cars[3].name, testEnv.cars[3].name);
		});
	});
});
