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

import {
	createApp,
	createPolicy,
	createPolicyUser,
	updatePolicyPropertyList,
	updateSchema,
	bjsReq,
	bjsReqPost,
	registerDataSharing,
	ENDPOINT,
} from '../../helpers.js';
import { runStep } from '../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';

// A car whose properties are held by several sources: the garage's own listing, and three partners' engine, gearbox
// and registration details, each stored under the car's id. A read of the garage's cars asks every source once; each
// source's part of the car comes back as its own row, tagged with the source. D-36 decides they're to be merged into
// one object on the id; until that's done, the client merges them.
describe('Data sharing: a car held in parts by several sources', async () => {
	const scope = 'Car parts setup';
	const env = { apps: {}, car: null, mechanic: null };
	let REST_PROCESS = null;

	const property = (type) => ({ __type: type, __default: null, __required: false, __allowUpdate: true });
	const partners = {
		engines: { fuel: property('string'), power: property('number') },
		gearboxes: { gearbox: property('string'), gears: property('number') },
		registrations: { plate: property('string') },
	};
	const parts = {
		garage: { price: 15000 },
		engines: { fuel: 'petrol', power: 150 },
		gearboxes: { gearbox: 'manual', gears: 6 },
		registrations: { plate: 'AB12 CDE' },
	};
	const everyProperty = Object.values(parts).flatMap((part) => Object.keys(part));

	// An agreement letting `remote` reach the registering app's data
	const agreement = (name, remote, token) => ({
		name,
		remoteApp: { endpoint: ENDPOINT.REST, ws: ENDPOINT.SOCK, apiPath: remote.apiPath, token },
		policyConfig: [{ verbs: ['%ALL%'], schema: ['%ALL%'], query: { access: '%FULL_ACCESS%' } }],
	});

	// The garage's rows for the car, by the app each came from, with the car's values they hold
	const rowsOfTheCar = async (token) => {
		const cars = await bjsReq({ url: `${ENDPOINT.REST}/${env.apps.garage.apiPath}/api/v1/car`, method: 'GET' }, token);
		const rows = cars.filter((car) => car.id === env.car);
		const appOf = (sourceId) => Object.keys(env.apps).find((name) => env.apps[name].id === sourceId);
		return rows.map((row) => ({
			source: appOf(row.sourceId),
			values: Object.fromEntries(everyProperty.filter((key) => row[key] !== null && row[key] !== undefined).map((key) => [key, row[key]])),
		})).sort((a, b) => a.source.localeCompare(b.source));
	};

	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, scope);

		env.apps.garage = await runStep('create the garage', () =>
			createApp(ENDPOINT.REST, 'Car Parts Garage', 'car-parts-garage', { role: ['MECHANIC'] })
		, scope);

		for (const [name, properties] of Object.entries(partners)) {
			env.apps[name] = await runStep(`create ${name}`, () =>
				createApp(ENDPOINT.REST, `Car Parts ${name}`, `car-parts-${name}`)
			, scope);
			await runStep(`add ${name}'s car schema`, () =>
				updateSchema(ENDPOINT.REST, [{ name: 'car', type: 'collection', properties }], env.apps[name].token)
			, scope);

			// The partner shares its cars with the garage, and the garage takes them up
			const offered = await runStep(`${name} shares its cars with the garage`, () =>
				registerDataSharing(ENDPOINT.REST, agreement(`${name}-to-garage`, env.apps.garage, null), env.apps[name].token)
			, scope);
			await runStep(`the garage takes up ${name}'s cars`, () =>
				registerDataSharing(
					ENDPOINT.REST,
					agreement(`garage-to-${name}`, env.apps[name], offered.registrationToken),
					env.apps.garage.token,
				)
			, scope);
		}

		await runStep("add the garage's car schema, with the partners' cars", async () => {
			await updateSchema(ENDPOINT.REST, [{
				name: 'car',
				type: 'collection',
				properties: { price: property('number') },
				remotes: Object.keys(partners).map((name) => ({ name: `garage-to-${name}`, schema: 'car' })),
			}], env.apps.garage.token);
			// Give Buttress time to create the routes
			await new Promise((resolve) => setTimeout(resolve, 500));
		}, scope);

		// The garage lists the car, and each partner stores its part under the car's id
		await runStep('store the parts of the car', async () => {
			const [car] = await bjsReqPost(`${ENDPOINT.REST}/${env.apps.garage.apiPath}/api/v1/car`, parts.garage, env.apps.garage.token);
			env.car = car.id;
			for (const name of Object.keys(partners)) {
				await bjsReqPost(`${ENDPOINT.REST}/${env.apps[name].apiPath}/api/v1/car`, { id: env.car, ...parts[name] }, env.apps[name].token);
			}
		}, scope);

		// A mechanic reads engines of petrol cars, and the price and plate of every car
		await runStep('create a mechanic with two policies', async () => {
			const config = (query, keys) => [{ verbs: ['GET'], schema: ['car'], query, projection: { keys } }];
			await createPolicy(ENDPOINT.REST, {
				name: 'car-parts-engine-bay',
				version: '1',
				selection: { role: { '@eq': 'MECHANIC' } },
				config: config({ fuel: { '@eq': 'petrol' } }, ['fuel', 'power']),
			}, env.apps.garage.token);
			await createPolicy(ENDPOINT.REST, {
				name: 'car-parts-front-desk',
				version: '1',
				selection: { role: { '@eq': 'MECHANIC' } },
				config: config({ access: '%FULL_ACCESS%' }, ['price', 'plate']),
			}, env.apps.garage.token);
			env.mechanic = await createPolicyUser(ENDPOINT.REST, env.apps.garage, 'car-parts-mechanic', { role: 'MECHANIC' });
		}, scope);
	});

	after(async function () {
		await REST_PROCESS.clean();
	});

	it("Should give each source's part of the car as its own row, with the car's id", async function () {
		this.timeout(20000);

		assert.deepStrictEqual(await rowsOfTheCar(env.apps.garage.token), [
			{ source: 'engines', values: parts.engines },
			{ source: 'garage', values: parts.garage },
			{ source: 'gearboxes', values: parts.gearboxes },
			{ source: 'registrations', values: parts.registrations },
		]);
	});

	it("Should give a token with several policies each source's part once, with the properties of the policies that read it", async function () {
		this.timeout(20000);

		// The engine is read by both policies, the rest by the front desk's; neither reads the gearbox
		assert.deepStrictEqual(await rowsOfTheCar(env.mechanic.tokens[0].value), [
			{ source: 'engines', values: parts.engines },
			{ source: 'garage', values: parts.garage },
			{ source: 'gearboxes', values: {} },
			{ source: 'registrations', values: parts.registrations },
		]);
	});

	// D-36: the parts are merged into one object on the car's id, each property from the source that holds it
	it.skip('Should give the car as one object, merged from its parts on its id (D-36)', async function () {
		this.timeout(20000);

		const cars = await bjsReq({ url: `${ENDPOINT.REST}/${env.apps.garage.apiPath}/api/v1/car`, method: 'GET' }, env.apps.garage.token);
		const rows = cars.filter((car) => car.id === env.car);

		assert.strictEqual(rows.length, 1);
		for (const [key, value] of Object.entries(Object.assign({}, ...Object.values(parts)))) {
			assert.strictEqual(rows[0][key], value, key);
		}
	});
});
