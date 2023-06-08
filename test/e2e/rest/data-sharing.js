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

const REST_PROCESS = new BootstrapRest();

const ENDPOINT = `https://test.local.buttressjs.com`;

const testEnv = {
	apps: {},
	agreements: {},
	car: null,
};

const bjsReq = async (opts, token=Config.testToken) => {
	const req = await fetch(`${opts.url}?token=${token}`, opts);
	if (req.status !== 200) throw new Error(`Received non-200 from POST ${opts.url}`);
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

before(async function() {
	this.timeout(20000);

	await REST_PROCESS.init();

	// Create two new apps
	testEnv.apps.app1 = await createApp('Test App 1', 'test-app-1');
	testEnv.apps.app1.schema = await updateSchema([{
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
	}], testEnv.apps.app1.token);

	testEnv.apps.app2 = await createApp('Test App 2', 'test-app-2');
});

after(async () => {
	// Shutdown
	await REST_PROCESS.clean();
});

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Data Sharing', async () => {
	it('Should register a data sharing agreement between app1 and app2', async () => {
		const agreement = await registerDataSharing({
			name: 'app1-to-app2',

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

		assert.strictEqual(agreement.name, 'app1-to-app2');
		assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT);
		assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app2.apiPath);
		assert.strictEqual(agreement.remoteApp.token, null);
		assert.strictEqual(agreement.active, false);
		assert(agreement.registrationToken !== null && agreement.registrationToken !== undefined);

		testEnv.agreements.app1 = agreement;
		testEnv.apps.app1.registrationToken = agreement.registrationToken;
	});

	it(`Should register a data sharing agreement between app2 and app1 & activate it`, async () => {
		const agreement = await registerDataSharing({
			name: 'app2-to-app1',

			remoteApp: {
				endpoint: ENDPOINT,
				apiPath: testEnv.apps.app1.apiPath,
				token: testEnv.apps.app1.registrationToken,
			},

			policy: [{
				endpoints: ['%ALL%'],
				query: [{
					schema: ['%ALL%'],
					access: '%FULL_ACCESS%',
				}],
			}],
		}, testEnv.apps.app2.token);

		assert.strictEqual(agreement.name, 'app2-to-app1');
		assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT);
		assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app1.apiPath);
		assert.strictEqual(agreement.active, true);

		testEnv.agreements.app2 = agreement;
	});

	it(`Should update app2 schema to reference cars collection from app1`, async () => {
		testEnv.apps.app2.schema = await updateSchema([{
			name: 'car',
			type: 'collection',
			remote: 'app2-to-app1.car',
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

	it('Should be able to POST cars from App2 which will use data sharing to post the data to App1', async function() {
		const result = await bjsReq({
			url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				name: 'Vaxhall Astra 1.7 CDTi ecoFLEX Exclusiv Euro 5 5dr',
				price: 2000.00,
			}),
		}, testEnv.apps.app2.token);
		testEnv.car = result;

		assert(result.id !== null && result.id !== undefined);
		assert.strictEqual(result.name, 'Vaxhall Astra 1.7 CDTi ecoFLEX Exclusiv Euro 5 5dr');
		assert.strictEqual(result.price, 2000.00);
	});

	it('Should be able to GET cars direct from App1 without extra price property', async function() {
		const cars = await bjsReq({
			url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
			method: 'GET',
		}, testEnv.apps.app1.token);

		assert.strictEqual(cars.length, 1);
		assert.strictEqual(cars[0].id, testEnv.car.id);
		assert.strictEqual(cars[0].name, testEnv.car.name);
	});

	it('Should be able to GET cars from App2 which will use data sharing to retrive data from App1', async function() {
		const cars = await bjsReq({
			url: `${ENDPOINT}/${testEnv.apps.app2.apiPath}/api/v1/car`,
			method: 'GET',
		}, testEnv.apps.app2.token);

		assert.strictEqual(cars.length, 1);
		assert.strictEqual(cars[0].id, testEnv.car.id);
		assert.strictEqual(cars[0].name, testEnv.car.name);
		assert.strictEqual(cars[0].price, testEnv.car.price);
	});
});
