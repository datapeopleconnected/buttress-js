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

import { createApp, updateSchema, ENDPOINT, bjsReq } from '../../helpers.js';
import { runStep } from '../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';

let REST_PROCESS = null;

const testEnv = {
	apps: {},
	cars: [],
};

// This suite of tests will run against the REST API
describe('Schema', async () => {
	before(async function() {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, 'Schema setup');

		testEnv.apps.app1 = await runStep('create app1', async () =>
			createApp(ENDPOINT.REST, 'Test Req App', 'test-req-app')
		, 'Schema setup');
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

			testEnv.apps.app1.schema = await updateSchema(ENDPOINT.REST, schema, testEnv.apps.app1.token);
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
			const body = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/app/schema`,
			}, testEnv.apps.app1.token);

			assert.strictEqual(body.length, 2);
			assert.strictEqual(body[0].name, 'car');
			assert.strictEqual(body[1].name, 'colours');
		});

		it('Should be able to fetch only the requested schema', async () => {
			const body = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/app/schema?only=colours`,
			}, testEnv.apps.app1.token);

			assert.strictEqual(body.length, 1);
			assert.strictEqual(body[0].name, 'colours');
		});
	});

	describe('Requests', async () => {
		describe('Methods', async () => {
			it('Should make a POST request to bulk add', async function() {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/add`,
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify(new Array(5000).fill(0).map(() => ({name: `name-${Math.floor(Math.random()*100)}`}))),
				}, testEnv.apps.app1.token);

				assert.strictEqual(body.length, 5000);
			});

			it('Should make a GET request without providing params (LIST)', async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				}, testEnv.apps.app1.token);

				assert.strictEqual(body.length, 5000);
			});

			it('Should make a POST request', async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({name: `name-test`}),
				}, testEnv.apps.app1.token);

				assert.strictEqual(body.length, 1);
				testEnv.cars.push(body[0]);
			});

			it('Should make a GET request for an entity by it\'s id', async () => {
				const entity = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/${testEnv.cars[0].id}`,
				}, testEnv.apps.app1.token);

				assert.strictEqual(entity.id, testEnv.cars[0].id);
				assert.strictEqual(entity.name, 'name-test');
			});

			it(`Should make a SEARCH request for car with name 'name-test'`, async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
					method: 'SEARCH',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({query: {name: `name-test`}}),
				}, testEnv.apps.app1.token);
				assert.strictEqual(body.length, 1);
			});

			it('Should make a SEARCH request to get the count of the results', async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/count`,
					method: 'SEARCH',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({name: `name-test`}),
				}, testEnv.apps.app1.token);
				assert.strictEqual(body, 1);
			});

			it('Should make a PUT request to get the count of the results', async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/${testEnv.cars[0].id}`,
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({
						path: 'name',
						value: 'name-test-updated',
					}),
				}, testEnv.apps.app1.token);

				assert.strictEqual(body.length, 1);
			});

			it('Should make a PUT request with a sourceId', async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/` +
						`car/${testEnv.cars[0].sourceId}/${testEnv.cars[0].id}`,
					method: 'PUT',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({
						path: 'name',
						value: 'name-test-updated2',
					}),
				}, testEnv.apps.app1.token);
				assert.strictEqual(body.length, 1);
			});

			// TODO: Update Many

			it('Should make a DELETE request for a single Id', async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/${testEnv.cars[0].id}`,
					method: 'DELETE',
				}, testEnv.apps.app1.token);
				assert.strictEqual(body, true);
			});

			// TODO: Delete Many

			it('Should make a DELETE request with no params (Delete all)', async () => {
				const body = await bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
					method: 'DELETE',
				}, testEnv.apps.app1.token);
				assert.strictEqual(body, true);
			});
		});
	});

	describe('Types', async () => {
		before(async function() {
			testEnv.apps.app2 = await runStep('create app2', async () =>
				createApp(ENDPOINT.REST, 'Test Types App', 'test-type-app')
			, 'Schema types setup');
		});

		it('Should update the types app schema', async () => {
			const schema = [{
				name: 'spaceship',
				type: 'collection',
				properties: {
					name: {
						__type: 'string',
						__default: null,
						__required: true,
						__allowUpdate: true,
					},
					engine: {
						__type: 'array',
						__allowUpdate: true,
						__schema: {
							position: {
								__type: 'string',
								__default: null,
								__required: true,
								__allowUpdate: true
							},
							items: {
								__type: 'number',
								__default: null,
								__required: true,
								__allowUpdate: true
							}
						}
					},
				},
			}];

			testEnv.apps.app2.schema = await updateSchema(ENDPOINT.REST, schema, testEnv.apps.app2.token);
			assert.strictEqual(testEnv.apps.app2.schema.length, 1);
			assert.strictEqual(testEnv.apps.app2.schema[0].name, 'spaceship');
			assert.strictEqual(typeof testEnv.apps.app2.schema[0].properties.id, 'object');
			assert.strictEqual(typeof testEnv.apps.app2.schema[0].properties.name, 'object');
			assert.strictEqual(typeof testEnv.apps.app2.schema[0].properties.engine, 'object');
			assert.strictEqual(typeof testEnv.apps.app2.schema[0].properties.sourceId, 'object');
		});

		it('Should make a POST request to add an item and check its types', async function() {
			this.timeout(5000);
			const [item] = await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/spaceship`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					name: 'spaceship-1',
					engine: [{
						position: 'bottom',
						items: 2,
					}],
				}),
			}, testEnv.apps.app2.token);
			assert.strictEqual(typeof item.name, 'string');
			assert.strictEqual(Array.isArray(item.engine), true);
			assert.strictEqual(typeof item.engine[0].position, 'string');
			assert.strictEqual(typeof item.engine[0].items, 'number');
		});
	});
});
