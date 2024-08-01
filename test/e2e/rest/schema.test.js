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
const fetch = require('cross-fetch');
const {describe, it, before, after} = require('mocha');
const assert = require('assert');

const {createApp, updateSchema, bjsReq, registerDataSharing} = require('../../helpers');

const BootstrapRest = require('../../../dist/bootstrap-rest');

let REST_PROCESS = null;
const ENDPOINT = `https://test.local.buttressjs.com`;

const testEnv = {
	apps: {},
	cars: [],
};

// This suite of tests will run against the REST API
describe('Schema', async () => {
	before(async function() {
		REST_PROCESS = new BootstrapRest();

		await REST_PROCESS.init();

		testEnv.apps.app1 = await createApp(ENDPOINT, 'Test Req App', 'test-req-app');
	});

	after(async function() {
		await REST_PROCESS.clean();
	});

	describe('Basic', async () => {
		it('Should update the app schema', async () => {
			const schema = [{
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
			}, {
				name: 'colours',
				type: 'collection',
				properties: {
					name: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
				},
			}];

			testEnv.apps.app1.schema = await updateSchema(ENDPOINT, schema, testEnv.apps.app1.token);
			assert.strictEqual(testEnv.apps.app1.schema.length, 2);
			assert.strictEqual(testEnv.apps.app1.schema[0].name, 'car');
			assert.strictEqual(typeof testEnv.apps.app1.schema[0].properties.id, 'object');
			assert.strictEqual(typeof testEnv.apps.app1.schema[0].properties.name, 'object');
			assert.strictEqual(typeof testEnv.apps.app1.schema[0].properties.sourceId, 'object');
		});

		it('Should have added id to the schema even though it wasn\'t provided', async () => {
			assert.strictEqual(typeof testEnv.apps.app1.schema[0].properties.id, 'object');
		});

		it('Should have added source to the schema even though it wasn\'t provided', async () => {
			assert.notEqual(typeof testEnv.apps.app1.schema[0].properties.source, undefined);
		});

		it('Should be able to fetch the schema', async () => {
			const getResponse = await fetch(`${ENDPOINT}/api/v1/app/schema?token=${testEnv.apps.app1.token}`);
			assert.strictEqual(getResponse.status, 200);

			const body = await getResponse.json();
			assert.strictEqual(body.length, 2);
			assert.strictEqual(body[0].name, 'car');
			assert.strictEqual(body[1].name, 'colours');
		});

		it('Should be able to fetch only the requested schema', async () => {
			const getResponse = await fetch(`${ENDPOINT}/api/v1/app/schema?token=${testEnv.apps.app1.token}&only=colours`);
			assert.strictEqual(getResponse.status, 200);

			const body = await getResponse.json();
			assert.strictEqual(body.length, 1);
			assert.strictEqual(body[0].name, 'colours');
		});
	});

	describe('Requests', async () => {
		describe('Methods', async () => {
			it('Should make a POST request to bulk add', async function() {
				this.timeout(5000);
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/add?token=${testEnv.apps.app1.token}`, {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify(new Array(5000).fill(0).map(() => ({name: `name-${Math.floor(Math.random()*100)}`}))),
				});
				assert.strictEqual(getResponse.status, 200);

				const body = await getResponse.json();
				assert.strictEqual(body.length, 5000);
			});

			it('Should make a GET request without providing params (LIST)', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car?token=${testEnv.apps.app1.token}`);
				assert.strictEqual(getResponse.status, 200);

				const body = await getResponse.json();
				assert.strictEqual(body.length, 5000);
			});

			it('Should make a POST request', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car?token=${testEnv.apps.app1.token}`, {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({name: `name-test`}),
				});
				assert.strictEqual(getResponse.status, 200);

				const body = await getResponse.json();
				assert.strictEqual(body.length, 1);
				testEnv.cars.push(body[0]);
			});

			it('Should make a GET request for an entity by it\'s id', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/${testEnv.cars[0].id}` +
					`?token=${testEnv.apps.app1.token}`);
				assert.strictEqual(getResponse.status, 200);

				const entity = await getResponse.json();
				assert.strictEqual(entity.id, testEnv.cars[0].id);
				assert.strictEqual(entity.name, 'name-test');
			});

			it(`Should make a SEARCH request for car with name 'name-test'`, async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car?token=${testEnv.apps.app1.token}`, {
					method: 'SEARCH',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({query: {name: `name-test`}}),
				});
				assert.strictEqual(getResponse.status, 200);

				const body = await getResponse.json();
				assert.strictEqual(body.length, 1);
			});

			it('Should make a SEARCH request to get the count of the results', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/count?token=${testEnv.apps.app1.token}`, {
					method: 'SEARCH',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({name: `name-test`}),
				});
				assert.strictEqual(getResponse.status, 200);

				const count = await getResponse.json();
				assert.strictEqual(count, 1);
			});

			it('Should make a PUT request to get the count of the results', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/${testEnv.cars[0].id}` +
					`?token=${testEnv.apps.app1.token}`, {
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({
						path: 'name',
						value: 'name-test-updated',
					}),
				});
				assert.strictEqual(getResponse.status, 200);

				const updates = await getResponse.json();
				assert.strictEqual(updates.length, 1);
			});

			it('Should make a PUT request with a sourceId', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/` +
					`car/${testEnv.cars[0].sourceId}/${testEnv.cars[0].id}` +
					`?token=${testEnv.apps.app1.token}`, {
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({
						path: 'name',
						value: 'name-test-updated2',
					}),
				});
				assert.strictEqual(getResponse.status, 200);

				const updates = await getResponse.json();
				assert.strictEqual(updates.length, 1);
			});

			// TODO: Update Many

			it('Should make a DELETE request for a single Id', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/${testEnv.cars[0].id}` +
					`?token=${testEnv.apps.app1.token}`, {
					method: 'delete',
				});
				assert.strictEqual(getResponse.status, 200);

				const isDeleted = await getResponse.json();
				assert.strictEqual(isDeleted, true);
			});

			// TODO: Delete Many

			it('Should make a DELETE request with no params (Delete all)', async () => {
				const getResponse = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car` +
					`?token=${testEnv.apps.app1.token}`, {
					method: 'delete',
				});
				assert.strictEqual(getResponse.status, 200);

				const isDeleted = await getResponse.json();
				assert.strictEqual(isDeleted, true);
			});
		});
	});
});
