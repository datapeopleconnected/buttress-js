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

		it('Should include the core schemas asked for by model or schema name, each once', async () => {
			const body = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/app/schema?core=users,user,activities`,
			}, testEnv.apps.app1.token);

			const core = body.filter((s) => s.core);
			assert.deepStrictEqual(core.map((s) => s.name), ['users', 'activities']);
			assert.deepStrictEqual(body.filter((s) => !s.core).map((s) => s.name), ['car', 'colours']);
		});

		it('Should refuse an unknown core schema name, naming it', async () => {
			const res = await fetch(`${ENDPOINT.REST}/api/v1/app/schema?core=users,widgets`, {
				headers: {Authorization: `Bearer ${testEnv.apps.app1.token}`},
			});

			assert.strictEqual(res.status, 400);
			assert.strictEqual((await res.json()).message, 'Unknown core schema: widgets');
		});

		it('Should refuse ?apiPath= naming another app than the token\'s, however it is given', async () => {
			const status = async (query) => {
				const res = await fetch(`${ENDPOINT.REST}/api/v1/app/schema${query}`, {
					headers: {Authorization: `Bearer ${testEnv.apps.app1.token}`},
				});
				return [res.status, (await res.json()).code];
			};
			const refused = 'apiPath_not_supported';

			assert.deepStrictEqual(await status('?apiPath=another-app'), [400, refused]);
			assert.deepStrictEqual(await status(`?apiPath=${testEnv.apps.app1.apiPath}&apiPath=another-app`), [400, refused]);
			assert.strictEqual((await status(`?apiPath=${testEnv.apps.app1.apiPath}`))[0], 200);
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

	describe('Bulk add', async () => {
		const carsUrl = () => `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`;

		const bulkAdd = async (entities, url = `${carsUrl()}/bulk/add`) => {
			const res = await fetch(url, {
				method: 'POST',
				headers: {'Content-Type': 'application/json', Authorization: `Bearer ${testEnv.apps.app1.token}`},
				body: JSON.stringify(entities),
			});
			return {status: res.status, body: await res.json()};
		};

		const countNamed = (name) => bjsReq({
			url: `${carsUrl()}/count`,
			method: 'SEARCH',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({query: {name}}),
		}, testEnv.apps.app1.token);

		it('Should refuse the whole batch when an entity reuses a stored id, and store none of it', async () => {
			const [existing] = await bjsReq({
				url: carsUrl(),
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name: 'bulk-add-existing'}),
			}, testEnv.apps.app1.token);

			const res = await bulkAdd([{name: 'bulk-add-before'}, {id: existing.id, name: 'bulk-add-dup'}, {name: 'bulk-add-after'}]);

			assert.strictEqual(res.status, 400);
			assert.match(res.body.message, /index 1/);
			assert.strictEqual(await countNamed('bulk-add-before'), 0);
		});

		it('Should refuse two entities with the same id', async () => {
			const id = '6ab000000000000000000001';

			const res = await bulkAdd([{id, name: 'bulk-add-twin'}, {id, name: 'bulk-add-twin'}]);

			assert.strictEqual(res.status, 400);
			assert.match(res.body.message, /index 1/);
			assert.strictEqual(await countNamed('bulk-add-twin'), 0);
		});

		it('Should name the index of an invalid entity', async () => {
			const res = await bulkAdd([{name: 'bulk-add-valid'}, {}]);

			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.message, 'car: Missing field: name at index 1');
			assert.strictEqual(await countNamed('bulk-add-valid'), 0);
		});

		it('Should refuse an entity that is not an object', async () => {
			const res = await bulkAdd([{name: 'bulk-add-before-nested'}, [{name: 'bulk-add-nested'}]]);

			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.message, 'car: Invalid entity at index 1, expected an object');
			assert.strictEqual(await countNamed('bulk-add-before-nested'), 0);
		});

		it('Should refuse two entities whose ids differ only in case', async () => {
			const res = await bulkAdd([
				{id: '6ab00000000000000000abcd', name: 'bulk-add-case'},
				{id: '6AB00000000000000000ABCD', name: 'bulk-add-case'},
			]);

			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.message, 'car: Duplicate id 6AB00000000000000000ABCD at index 1');
			assert.strictEqual(await countNamed('bulk-add-case'), 0);
		});

		it('Should refuse, and store none of, a batch whose id is taken while it is being stored', async () => {
			// Two batches sent at once both pass the duplicate check, and one then fails to insert its last entity.
			for (let round = 0; round < 5; round++) {
				const id = `6ac0000000000000000000${String(round).padStart(2, '0')}`;
				const name = (tag) => `bulk-add-race-${round}-${tag}`;
				const batch = (tag) => [...new Array(50).fill(0).map(() => ({name: name(tag)})), {id, name: name(tag)}];

				const results = await Promise.all([bulkAdd(batch('a')), bulkAdd(batch('b'))]);

				assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 400]);
				const refused = results.findIndex((r) => r.status === 400);
				assert.strictEqual(results[refused].body.message, `car: Duplicate id ${id} at index 50`);
				assert.strictEqual(await countNamed(name(refused === 0 ? 'a' : 'b')), 0);
				assert.strictEqual(await countNamed(name(refused === 0 ? 'b' : 'a')), 51);
			}
		});

		it('Should check an array sent to add-one as bulk/add checks it', async () => {
			const [existing] = await bjsReq({
				url: carsUrl(),
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name: 'add-one-array-existing'}),
			}, testEnv.apps.app1.token);

			const res = await bulkAdd([{name: 'add-one-array-before'}, {id: existing.id, name: 'add-one-array-dup'}], carsUrl());

			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.message, `car: Duplicate id ${existing.id} at index 1`);
			assert.strictEqual(await countNamed('add-one-array-before'), 0);
		});
	});

	describe('Search operators', async () => {
		const searchNames = async (query) => (await bjsReq({
			url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
			method: 'SEARCH',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({query}),
		}, testEnv.apps.app1.token)).map((car) => car.name);

		it('Should match $rex with case, and $rexi without', async () => {
			await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name: 'Rex-Case-Car'}),
			}, testEnv.apps.app1.token);

			assert.deepStrictEqual(await searchNames({name: {$rex: '^Rex-Case'}}), ['Rex-Case-Car']);
			assert.deepStrictEqual(await searchNames({name: {$rex: '^rex-case'}}), []);
			assert.deepStrictEqual(await searchNames({name: {$rexi: '^rex-case'}}), ['Rex-Case-Car']);
		});

		it('Should fail a search that MongoDB refuses while streaming, and keep serving requests', async () => {
			// MongoDB only rejects a non-array $in once the cursor runs, after the route has its stream.
			await assert.rejects(() => searchNames({name: {$in: 'Rex-Case-Car'}}), (err) => {
				assert.strictEqual(err.code, 500);
				assert.deepStrictEqual(err.body, { code: 'internal_error', message: 'Internal server error' });
				return true;
			});

			assert.deepStrictEqual(await searchNames({name: {$in: ['Rex-Case-Car']}}), ['Rex-Case-Car']);
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
					tags: {
						__type: 'array',
						__itemtype: 'string',
						__allowUpdate: true,
					},
					notes: {
						__type: 'array',
						__allowUpdate: true,
					},
					meta: {
						__type: 'object',
						__default: null,
						__allowUpdate: true,
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
			testEnv.spaceship = item;
		});

		it('Should refuse to add an entity with an invalid array item, naming it', async () => {
			const add = (engine) => bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/spaceship`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name: 'spaceship-invalid', engine}),
			}, testEnv.apps.app2.token);

			await assert.rejects(
				() => add([{position: 'bottom', items: 'lots'}]),
				(err) => err.code === 400 && err.message === 'spaceship: Invalid value: engine.0.items:lots[string]',
			);
			await assert.rejects(
				() => add([{position: 'bottom', items: 1}, {items: 2}]),
				(err) => err.code === 400 && err.message === 'spaceship: Missing field: engine.1.position',
			);
			await assert.rejects(
				() => add([{position: 'bottom', items: 1}, 'top']),
				(err) => err.code === 400 && err.message === 'spaceship: Invalid value: engine.1:top[string] [object]',
			);
		});

		const putSpaceship = (body) => bjsReq({
			url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/spaceship/${testEnv.spaceship.id}`,
			method: 'PUT',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(body),
		}, testEnv.apps.app2.token);

		const getSpaceship = () => bjsReq({
			url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/spaceship/${testEnv.spaceship.id}`,
		}, testEnv.apps.app2.token);

		it('Should refuse a null item in a typed array, and store nothing', async () => {
			const before = await getSpaceship();
			const refusals = [
				[{path: 'engine', value: null}, 'engine:null[null] [object]'],
				[{path: 'engine', value: [{position: 'left', items: 1}, null]}, 'engine.1:null[null] [object]'],
				[{path: 'tags', value: null}, 'tags:null[null] [string]'],
				[{path: 'tags', value: ['a', null]}, 'tags.1:null[null] [string]'],
			];
			for (const [body, invalid] of refusals) {
				await assert.rejects(
					() => putSpaceship(body),
					(err) => err.code === 400 && err.message === `spaceship: Update value is invalid: ${invalid}`,
				);
			}
			await assert.rejects(
				() => bjsReq({
					url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/spaceship`,
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({name: 'spaceship-null-tag', tags: ['a', null]}),
				}, testEnv.apps.app2.token),
				(err) => err.code === 400 && err.message === 'spaceship: Invalid value: tags.1:null[null] [string]',
			);

			const after = await getSpaceship();
			assert.deepStrictEqual([after.engine, after.tags], [before.engine, before.tags]);
		});

		it('Should remove only the item at the index, leaving the array\'s other nulls', async () => {
			await putSpaceship({path: 'notes', value: ['a', null, 'b', null]});

			const [{type, path, value}] = await putSpaceship({path: 'notes.0.__remove__', value: ''});
			assert.deepStrictEqual({type, path, value}, {type: 'vector-rm', path: 'notes', value: {numRemoved: 1, index: '0'}});

			const spaceship = await getSpaceship();
			assert.deepStrictEqual(spaceship.notes, [null, 'b', null]);

			// Later tests expect notes to start empty.
			await putSpaceship({path: 'notes', value: []});
		});

		it('Should replace a whole array of item schemas with a PUT of an array', async () => {
			const engine = [{position: 'left', items: 1}, {position: 'right', items: 3}];

			const [{type, path, value}] = await putSpaceship({path: 'engine', value: engine});
			assert.deepStrictEqual({type, path, value}, {type: 'scalar', path: 'engine', value: engine});

			const spaceship = await getSpaceship();
			assert.deepStrictEqual(spaceship.engine, engine);
		});

		it('Should still push one item to an array of item schemas', async () => {
			await putSpaceship({path: 'engine', value: {position: 'top', items: 5}});

			const spaceship = await getSpaceship();
			assert.deepStrictEqual(spaceship.engine.map((e) => e.position), ['left', 'right', 'top']);
		});

		it('Should check and convert a field of an array item', async () => {
			await assert.rejects(
				() => putSpaceship({path: 'engine.0.items', value: 'lots'}),
				(err) => err.code === 400 && err.message === 'spaceship: Update value is invalid: engine.0.items failed schema test',
			);

			await putSpaceship({path: 'engine.0.items', value: '4'});
			const spaceship = await getSpaceship();
			assert.strictEqual(spaceship.engine[0].items, 4);
		});

		it('Should refuse a whole-array write when an element is invalid, and leave the array as it was', async () => {
			await assert.rejects(
				() => putSpaceship({path: 'engine', value: [{position: 'left', items: 'lots'}]}),
				(err) => err.code === 400 && err.message.includes('engine.0.items:lots[string]'),
			);

			const spaceship = await getSpaceship();
			assert.strictEqual(spaceship.engine.length, 3);
		});

		it('Should replace a whole array of an item type with a PUT of an array', async () => {
			await putSpaceship({path: 'tags', value: ['z', 'a', 'b']});

			const spaceship = await getSpaceship();
			assert.deepStrictEqual(spaceship.tags, ['z', 'a', 'b']);
		});

		it('Should append several values to one property with a bulk update', async () => {
			const results = await bjsReq({
				url: `${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/spaceship/bulk/update`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify([
					{id: testEnv.spaceship.id, body: {path: 'tags', value: 'c'}},
					{id: testEnv.spaceship.id, body: {path: 'tags', value: 'd'}},
				]),
			}, testEnv.apps.app2.token);
			assert.deepStrictEqual(results.map((r) => r.results[0].type), ['vector-add', 'vector-add']);

			const spaceship = await getSpaceship();
			assert.deepStrictEqual(spaceship.tags, ['z', 'a', 'b', 'c', 'd']);
		});

		it('Should append a value to an array with no item type', async () => {
			await putSpaceship({path: 'notes', value: 'hello'});
			await putSpaceship({path: 'notes', value: {text: 'world'}});

			const spaceship = await getSpaceship();
			assert.deepStrictEqual(spaceship.notes, ['hello', {text: 'world'}]);
		});

		it('Should apply none of a request\'s updates when one of them can\'t be applied', async () => {
			const {name} = await getSpaceship();
			const refused = "Update can't be applied: Cannot create field 'x' in element {meta: null}";

			// Separate paths, written as one update document.
			await assert.rejects(
				() => putSpaceship([{path: 'name', value: 'renamed'}, {path: 'meta.x', value: 1}]),
				(err) => err.code === 400 && err.message === refused,
			);
			// Overlapping paths, worked out on the entity as read.
			await assert.rejects(
				() => putSpaceship([{path: 'name', value: 'renamed'}, {path: 'meta', value: null}, {path: 'meta.x', value: 1}]),
				(err) => err.code === 400 && err.message === refused,
			);

			assert.strictEqual((await getSpaceship()).name, name);
		});

		it('Should report a bulk update item that fails while being written, apply the rest, and count the refusals', async () => {
			const res = await fetch(`${ENDPOINT.REST}/${testEnv.apps.app2.apiPath}/api/v1/spaceship/bulk/update`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${testEnv.apps.app2.token}`,
					Origin: 'http://crag.example',
				},
				body: JSON.stringify([
					{id: testEnv.spaceship.id, body: {path: 'name', value: 'bulk-renamed'}},
					{id: testEnv.spaceship.id, body: {path: 'meta.x', value: 1}},
				]),
			});
			const results = await res.json();

			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.headers.get('x-bulk-refused'), '1');
			assert.match(res.headers.get('access-control-expose-headers'), /x-bulk-refused/);
			assert.strictEqual(results[0].results[0].value, 'bulk-renamed');
			assert.deepStrictEqual(results[1].validation, {
				status: 400,
				code: 'invalid_update',
				message: "Update can't be applied: Cannot create field 'x' in element {meta: null}",
			});
			assert.strictEqual((await getSpaceship()).name, 'bulk-renamed');
		});

		it('Should remove an array item without leaving a hole', async () => {
			const before = (await getSpaceship()).engine;

			await putSpaceship({path: 'engine.1.__remove__', value: ''});

			assert.deepStrictEqual((await getSpaceship()).engine, [before[0], ...before.slice(2)]);
		});

		it('Should apply an append and a remove to the same array in one request', async () => {
			await putSpaceship([{path: 'tags', value: 'e'}, {path: 'tags.0.__remove__', value: ''}]);

			assert.deepStrictEqual((await getSpaceship()).tags, ['a', 'b', 'c', 'd', 'e']);
		});
	});
});
