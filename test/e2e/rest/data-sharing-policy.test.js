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

import { createApp, updateSchema, bjsReq, bjsReqPost, registerDataSharing, ENDPOINT } from '../../helpers.js';
import { runStep } from '../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';

// The policy config an agreement gives its partner: what the partner can do with the app's data
describe('Data sharing: an agreement\'s policy', async () => {
	const scope = 'Agreement policy setup';
	const env = { apps: {}, agreements: {} };
	let REST_PROCESS = null;

	const carSchema = {
		name: 'car',
		type: 'collection',
		properties: {
			name: { __type: 'string', __default: null, __required: true, __allowUpdate: true },
		},
	};

	// An agreement letting the app at `apiPath` reach the registering app's data through `policyConfig`
	const agreement = (name, apiPath, policyConfig, token = null) => ({
		name,
		remoteApp: { endpoint: ENDPOINT.REST, ws: ENDPOINT.SOCK, apiPath, token },
		policyConfig,
	});
	const fullAccess = [{ verbs: ['%ALL%'], schema: ['%ALL%'], query: { access: '%FULL_ACCESS%' } }];

	// A refusal with `status` and `code`, whose issues name `path` when it's given
	const refusedWith = (status, code, path) => (err) =>
		err.code === status && err.body.code === code && (!path || err.body.details.issues.some((issue) => issue.path === path));

	before(async function() {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, scope);

		env.apps.sharer = await runStep('create sharer', async () => createApp(ENDPOINT.REST, 'Policy Sharer', 'dsp-sharer'), scope);
		await runStep('sharer schema', async () => updateSchema(ENDPOINT.REST, [carSchema], env.apps.sharer.token), scope);
		for (const name of ['A red car', 'A blue car']) {
			await runStep(`sharer car ${name}`, async () =>
				bjsReqPost(`${ENDPOINT.REST}/${env.apps.sharer.apiPath}/api/v1/car`, { name }, env.apps.sharer.token), scope);
		}

		env.apps.partner = await runStep('create partner', async () => createApp(ENDPOINT.REST, 'Policy Partner', 'dsp-partner'), scope);
	});

	after(async () => {
		await REST_PROCESS.clean();
	});

	// SR-DPC-001 S21: verbs or a schema given as text were stored as they were, and matched by their substrings, so
	// `cars-and-vans` granted `car` too
	describe('Adding an agreement', async () => {
		it('Should refuse a policy config whose verbs are text', async () => {
			const config = [{ verbs: 'GET,PUT', schema: ['car'], query: { access: '%FULL_ACCESS%' } }];

			await assert.rejects(
				registerDataSharing(ENDPOINT.REST, agreement('verbs-as-text', env.apps.partner.apiPath, config), env.apps.sharer.token),
				refusedWith(400, 'invalid_policy', 'policyConfig.0.verbs'),
			);
		});

		it('Should refuse a policy config whose schema is text', async () => {
			const config = [{ verbs: ['GET'], schema: 'cars-and-vans', query: { access: '%FULL_ACCESS%' } }];

			await assert.rejects(
				registerDataSharing(ENDPOINT.REST, agreement('schema-as-text', env.apps.partner.apiPath, config), env.apps.sharer.token),
				refusedWith(400, 'invalid_policy', 'policyConfig.0.schema'),
			);
		});

		it('Should keep no agreement, or policy, for a policy config it refused', async () => {
			const names = (await bjsReq({ url: `${ENDPOINT.REST}/api/v1/app-data-sharing`, method: 'GET' }, env.apps.sharer.token))
				.map((ds) => ds.name);
			const policies = (await bjsReq({ url: `${ENDPOINT.REST}/api/v1/policy`, method: 'GET' }, env.apps.sharer.token))
				.map((policy) => policy.name);

			assert.deepStrictEqual(names.filter((name) => name.endsWith('-as-text')), []);
			assert.deepStrictEqual(policies.filter((name) => name.endsWith('-as-text')), []);
		});

		it('Should add an agreement whose policy config lists its verbs and schema', async () => {
			const ds = await registerDataSharing(ENDPOINT.REST,
				agreement('sharer-to-partner', env.apps.partner.apiPath, fullAccess), env.apps.sharer.token);

			assert.strictEqual(ds.name, 'sharer-to-partner');
			env.agreements.sharer = ds;
		});
	});

	// SR-DPC-001 C1: the route wrote the body to a field the agreement doesn't have and answered true, so the partner
	// kept the access it had
	describe('Changing an agreement\'s policy', async () => {
		const updatePolicy = (ds, body, app = env.apps.sharer) => bjsReq({
			url: `${ENDPOINT.REST}/api/v1/app-data-sharing/${ds.id}/policy`,
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}, app.token);
		// The names of the sharer's cars that the partner reads through its agreement
		const sharerCarsReadByPartner = async () => (await bjsReq({
			url: `${ENDPOINT.REST}/${env.apps.partner.apiPath}/api/v1/car`,
			method: 'GET',
		}, env.apps.partner.token)).filter((car) => car.sourceId === env.apps.sharer.id).map((car) => car.name).sort();
		const onlyRed = [{ verbs: ['GET', 'QUERY'], schema: ['car'], query: { name: { '@eq': 'A red car' } } }];

		before(async function() {
			this.timeout(20000);

			env.agreements.partner = await runStep('pair the partner', async () => registerDataSharing(ENDPOINT.REST,
				agreement('partner-to-sharer', env.apps.sharer.apiPath, fullAccess, env.agreements.sharer.registrationToken),
				env.apps.partner.token), scope);
			assert.strictEqual(env.agreements.partner.active, true);

			await runStep('partner schema', async () => updateSchema(ENDPOINT.REST, [{
				name: 'car',
				type: 'collection',
				remotes: [{ name: 'partner-to-sharer', schema: 'car' }],
			}], env.apps.partner.token), scope);
			// Time to create the routes
			await new Promise((r) => setTimeout(r, 500));
		});

		it('Should let the partner read the sharer\'s cars to begin with', async () => {
			assert.deepStrictEqual(await sharerCarsReadByPartner(), ['A blue car', 'A red car']);
		});

		it('Should narrow what the partner reads to the new policy', async () => {
			assert.strictEqual(await updatePolicy(env.agreements.sharer, onlyRed), true);

			assert.deepStrictEqual(await sharerCarsReadByPartner(), ['A red car']);
		});

		it('Should keep the sharer\'s policy with the agreement\'s name and selection, holding the new config', async () => {
			const [policy] = (await bjsReq({ url: `${ENDPOINT.REST}/api/v1/policy`, method: 'GET' }, env.apps.sharer.token))
				.filter((p) => p.name === 'Data Sharing Policy - sharer-to-partner');

			assert.deepStrictEqual(policy.config.map((c) => [c.verbs, c.schema, c.query]), [
				[['GET', 'QUERY'], ['car'], { name: { '@eq': 'A red car' } }],
			]);
			assert.deepStrictEqual(policy.selection['#tokenType'], { '@eq': 'DATA_SHARING' });
		});

		it('Should widen what the partner reads again', async () => {
			assert.strictEqual(await updatePolicy(env.agreements.sharer, fullAccess), true);

			assert.deepStrictEqual(await sharerCarsReadByPartner(), ['A blue car', 'A red car']);
		});

		it('Should refuse a policy that isn\'t a list of configs, leaving the partner\'s access as it was', async () => {
			for (const [body, path] of [
				[{ car: ['READ'] }, 'config'],
				[[{ verbs: 'GET,PUT', schema: ['car'], query: { access: '%FULL_ACCESS%' } }], 'config.0.verbs'],
				[[{ verbs: ['GET'], schema: 'cars-and-vans', query: { access: '%FULL_ACCESS%' } }], 'config.0.schema'],
			]) {
				await assert.rejects(updatePolicy(env.agreements.sharer, body), refusedWith(400, 'invalid_policy', path), JSON.stringify(body));
			}

			assert.deepStrictEqual(await sharerCarsReadByPartner(), ['A blue car', 'A red car']);
		});

		it('Should refuse to change the policy of another app\'s agreement', async () => {
			await assert.rejects(
				updatePolicy(env.agreements.sharer, onlyRed, env.apps.partner),
				refusedWith(404, 'not_found'),
			);
		});

		it('Should refuse to change an agreement whose policy has been removed', async () => {
			const ds = await registerDataSharing(ENDPOINT.REST,
				agreement('sharer-unpaired', env.apps.partner.apiPath, fullAccess), env.apps.sharer.token);
			const [policy] = (await bjsReq({ url: `${ENDPOINT.REST}/api/v1/policy`, method: 'GET' }, env.apps.sharer.token))
				.filter((p) => p.name === 'Data Sharing Policy - sharer-unpaired');
			await bjsReq({ url: `${ENDPOINT.REST}/api/v1/policy/${policy.id}`, method: 'DELETE' }, env.apps.sharer.token);

			await assert.rejects(updatePolicy(ds, onlyRed), (err) =>
				refusedWith(404, 'not_found')(err) && err.body.details.schema === 'policy');
		});
	});
});
