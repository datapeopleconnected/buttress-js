/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

const fetch = require('cross-fetch');

const {describe, it, before, after} = require('mocha');
const assert = require('assert');

const Config = require('node-env-obj')();

const BootstrapRest = require('../../../dist/bootstrap-rest');

let REST_PROCESS = null;
const ENDPOINT = `https://test.local.buttressjs.com`;

const testEnv = {
	apps: {},
	agreements: {},
	cars: [],
};

const bjsReq = async (opts, token=Config.testToken) => {
	const req = await fetch(`${opts.url}?token=${token}`, opts);
	if (req.status !== 200) throw new Error(`Received non-200 (${req.status}) from POST ${opts.url}`);
	return await req.json();
};

const createApp = async (name, apiPath, token) => await bjsReq({
	url: `${ENDPOINT}/api/v1/app`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify({
		name,
		apiPath,
	}),
}, token);
const updateSchema = async (schema, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/schema`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(schema),
}, token);
const registerDataSharing = async (agreement, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/appDataSharing`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(agreement),
}, token);

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

		testEnv.apps.app1 = await createApp('Test App 1', 'test-app-1');
		testEnv.apps.app1.schema = await updateSchema([carsSchema], testEnv.apps.app1.token);

		await createCar(testEnv.apps.app1, 'A red car');

		// Test app 2 doesn't need a schema from the start, we'll add one later.
		testEnv.apps.app2 = await createApp('Test App 2', 'test-app-2');

		// Create a third app which will be used as a cars sources too.
		testEnv.apps.app3 = await createApp('Test App 3', 'test-app-3');
		testEnv.apps.app3.schema = await updateSchema([carsSchema], testEnv.apps.app3.token);

		await createCar(testEnv.apps.app3, 'A green car');
	});

	after(async function() {
		// Shutdown
		await REST_PROCESS.clean();
	});

	describe('Creating a agreement', async () => {
		it('Should register a data sharing agreement between app1 and app2', async () => {
			const name = `app1-to-app2`;
			const agreement = await registerDataSharing({
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
			const agreement = await registerDataSharing({
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
			testEnv.apps.app2.schema = await updateSchema([{
				name: 'car',
				type: 'collection',
				remotes: [{
					name: 'app2-to-app1',
					schema: 'car',
				}],
				properties: {
					price: {
						__type: 'number',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
				},
			}], testEnv.apps.app2.token);

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

		// it('Should be able to POST cars from App2 which will use data sharing to post the data to App1', async function() {
		// 	const [result] = await bjsReq({
		// 		url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
		// 		method: 'POST',
		// 		headers: {'Content-Type': 'application/json'},
		// 		body: JSON.stringify({
		// 			name: 'A blue car',
		// 			price: 2000.00,
		// 		}),
		// 	}, testEnv.apps.app2.token);
		// 	testEnv.cars.push(result);

		// 	assert(result.id !== null && result.id !== undefined);
		// 	assert.strictEqual(result.name, 'A blue car');
		// 	assert.strictEqual(result.price, 2000.00);
		// });

		// it('Should be able to GET cars direct from App1 without extra price property', async function() {
		// 	const cars = await bjsReq({
		// 		url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
		// 		method: 'GET',
		// 	}, testEnv.apps.app1.token);

		// 	assert.strictEqual(cars.length, 1);
		// 	assert.strictEqual(cars[0].id, testEnv.cars[1].id);
		// 	assert.strictEqual(cars[0].name, testEnv.cars[1].name);
		// });

		// it('Should be able to GET cars from App2 which will use data sharing to retrive data from App1', async function() {
		// 	const cars = await bjsReq({
		// 		url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
		// 		method: 'GET',
		// 	}, testEnv.apps.app2.token);

		// 	assert.strictEqual(cars.length, 2);

		// 	assert.strictEqual(cars[0].id, testEnv.cars[0].id);
		// 	assert.strictEqual(cars[0].name, testEnv.cars[0].name);

		// 	assert.strictEqual(cars[1].id, testEnv.cars[1].id);
		// 	assert.strictEqual(cars[1].name, testEnv.cars[1].name);
		// 	assert.strictEqual(cars[1].price, testEnv.cars[1].price);
		// });
	});

	describe('Handling mutiple agreement sources', async () => {
		it('Should register a data sharing agreement between app3 and app2', async () => {
			const name = `app3-to-app2`;
			const agreement = await registerDataSharing({
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
			const agreement = await registerDataSharing({
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
			testEnv.apps.app2.schema = await updateSchema([{
				name: 'car',
				type: 'collection',
				remotes: [{
					name: 'app2-to-app1',
					schema: 'car',
				}, {
					name: 'app2-to-app3',
					schema: 'car',
				}],
				properties: {
					price: {
						__type: 'number',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
				},
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

			assert.strictEqual(cars.length, 2);
			assert.strictEqual(cars[0].id, testEnv.cars[0].id);
			assert.strictEqual(cars[0].name, testEnv.cars[0].name);

			assert.strictEqual(cars[1].id, testEnv.cars[1].id);
			assert.strictEqual(cars[1].name, testEnv.cars[1].name);
		});

		// TODO: more here

		// it('Should be able to POST cars from App2 which will use data sharing to post the data to App1', async function() {
		// 	const result = await bjsReq({
		// 		url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
		// 		method: 'POST',
		// 		headers: {'Content-Type': 'application/json'},
		// 		body: JSON.stringify({
		// 			name: 'A blue car',
		// 			price: 2000.00,
		// 		}),
		// 	}, testEnv.apps.app2.token);
		// 	testEnv.car = result;

		// 	assert(result.id !== null && result.id !== undefined);
		// 	assert.strictEqual(result.name, 'A blue car');
		// 	// TODO: Uncomment when feature is complete
		// 	// assert.strictEqual(result.price, 2000.00);
		// });
	});
});
