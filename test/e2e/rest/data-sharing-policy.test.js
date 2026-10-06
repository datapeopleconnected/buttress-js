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
});
