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
	deleteApp,
	BJSReqError,
	ENDPOINT,
} from '../../helpers.js';
import { runStep } from '../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';
import { PolicyExpiry } from '../../../dist/access-control/policy-expiry.js';

// A policy's limit and env values, as a request is checked against them
describe('Policy limit and env', async () => {
	const scope = 'Policy limit and env setup';
	const env = { app: null, users: {} };
	let REST_PROCESS = null;

	const policy = (name, overrides = {}) => ({
		name,
		version: '1',
		selection: { envCase: { '@eq': 'limit' } },
		config: [{ verbs: ['GET'], schema: ['note'], query: { access: '%FULL_ACCESS%' } }],
		...overrides,
	});
	const readNotes = async (user) => (await bjsReq({
		url: `${ENDPOINT.REST}/${env.app.apiPath}/api/v1/note`,
		method: 'GET',
	}, env.users[user].tokens[0].value)).map((note) => note.text).sort();
	// The policy properties of a user's token, as they're stored
	const storedProperties = async (user) => (await bjsReq({
		url: `${ENDPOINT.REST}/api/v1/user/${env.users[user].id}`,
		method: 'GET',
	}, env.app.token)).tokens.find((token) => token.value === env.users[user].tokens[0].value).policyProperties;

	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, scope);

		env.app = await runStep('create app', async () =>
			createApp(ENDPOINT.REST, 'Test Policy Env', 'test-policy-env')
		, scope);
		await runStep('allow policy properties', async () => updatePolicyPropertyList(ENDPOINT.REST, {
			envCase: ['limit', 'lookup', 'loop'],
			examAccess: [true],
			reportsAccess: [true],
			role: ['STAFF'],
		}, env.app.token), scope);
		await runStep('add the note schema', async () => updateSchema(ENDPOINT.REST, [{
			name: 'note',
			type: 'collection',
			properties: { text: { __type: 'string', __default: null, __required: true, __allowUpdate: true } },
		}], env.app.token), scope);
		await runStep('add notes', async () =>
			bjsReqPost(`${ENDPOINT.REST}/${env.app.apiPath}/api/v1/note`, [{ text: 'a' }, { text: 'b' }, { text: 'c' }], env.app.token)
		, scope);

		await runStep('create policies', async () => {
			// Looks up the notes whose text is either env value, which a list in the lookup's query names
			await createPolicy(ENDPOINT.REST, policy('policy-env-lookup', {
				selection: { envCase: { '@eq': 'lookup' } },
				env: {
					first: 'a',
					second: 'b',
					noteIds: {
						collection: 'note',
						type: 'array',
						query: { text: { '@in': ['#env.first', '#env.second'] } },
						output: { key: 'id', type: 'id' },
					},
				},
				config: [{ verbs: ['GET'], schema: ['note'], query: { id: { '@in': '#env.noteIds' } } }],
			}), env.app.token);

			// Its env values refer to each other, so the configs reading them grant nothing, and the last grants note c
			await createPolicy(ENDPOINT.REST, policy('policy-env-loop', {
				selection: { envCase: { '@eq': 'loop' } },
				env: { first: '#env.second', second: '#env.first' },
				config: [
					{ verbs: ['GET'], schema: ['note'], query: { text: '#env.first' } },
					{ verbs: ['GET'], schema: ['note'], query: { access: '%FULL_ACCESS%' }, condition: { '#env.first': { '@eq': 'a' } } },
					{ verbs: ['GET'], schema: ['note'], query: { text: 'c' } },
				],
			}), env.app.token);
		}, scope);

		await runStep('create users', async () => {
			for (const envCase of ['lookup', 'loop']) {
				env.users[envCase] = await createPolicyUser(ENDPOINT.REST, env.app, `policy-env-${envCase}`, { envCase });
			}
		}, scope);
	});

	after(async function () {
		if (env.app?.id) await deleteApp(ENDPOINT.REST, env.app.id);
		await REST_PROCESS.clean();
	});

	// SR-DPC-001 S8: a limit that isn't a date is refused by the policy schema's date type when it's saved, so only a
	// policy stored by an earlier release can have one, and that grants nothing
	it("Should refuse a policy whose limit isn't a date, when it's added or updated", async () => {
		await assert.rejects(
			createPolicy(ENDPOINT.REST, policy('policy-env-bad-limit', { limit: '2025-13-45' }), env.app.token),
			(err) => err instanceof BJSReqError && err.code === 400 && err.body?.code === 'invalid_value',
		);

		const limited = await createPolicy(ENDPOINT.REST, policy('policy-env-limited', {
			limit: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
		}), env.app.token);
		try {
			await assert.rejects(
				bjsReq({
					url: `${ENDPOINT.REST}/api/v1/policy/${limited.id}`,
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify([{ path: 'limit', value: 'next tuesday' }]),
				}, env.app.token),
				(err) => err instanceof BJSReqError && err.code === 400 && err.body?.code === 'invalid_update',
			);
		} finally {
			await bjsReq({ url: `${ENDPOINT.REST}/api/v1/policy/${limited.id}`, method: 'DELETE' }, env.app.token);
		}
	});

	// SR-DPC-001 D1: when a policy's limit passed, every property its selection named was taken off the one token whose
	// request had queued its removal, a property another policy selected the token by too, and the other tokens kept theirs
	it('Should remove a policy whose limit has passed, and from the tokens a transient one selected only the property named after it', async () => {
		const passed = new Date(Date.now() - 60 * 1000).toISOString();
		const staff = await createPolicy(ENDPOINT.REST, policy('policy-env-staff', {
			selection: { role: { '@eq': 'STAFF' } },
			config: [{ verbs: ['GET'], schema: ['note'], query: { text: 'a' } }],
		}), env.app.token);
		// A transient policy, which selects its tokens by the property named after it
		const exam = await createPolicy(ENDPOINT.REST, policy('examAccess', {
			selection: { examAccess: { '@eq': true } },
			limit: passed,
			transient: true,
		}), env.app.token);
		// Shaped like one, but not marked transient
		const reports = await createPolicy(ENDPOINT.REST, policy('reportsAccess', {
			selection: { reportsAccess: { '@eq': true } },
			limit: passed,
		}), env.app.token);
		const promo = await createPolicy(ENDPOINT.REST, policy('policy-env-promo', {
			selection: { role: { '@eq': 'STAFF' } },
			limit: passed,
		}), env.app.token);
		env.users.alice = await createPolicyUser(ENDPOINT.REST, env.app, 'policy-env-alice', {
			examAccess: true,
			reportsAccess: true,
			role: 'STAFF',
		});
		env.users.bob = await createPolicyUser(ENDPOINT.REST, env.app, 'policy-env-bob', { examAccess: true });

		try {
			await new PolicyExpiry().sweep();

			const policyIds = (await bjsReq({ url: `${ENDPOINT.REST}/api/v1/policy`, method: 'GET' }, env.app.token))
				.map((stored) => stored.id);
			assert.ok(policyIds.includes(staff.id), 'a policy with no limit stays');
			assert.ok([exam, reports, promo].every((p) => !policyIds.includes(p.id)), 'the policies whose limit passed go');

			assert.deepStrictEqual(await storedProperties('alice'), { reportsAccess: true, role: 'STAFF' });
			assert.deepStrictEqual(await storedProperties('bob'), {});
			assert.deepStrictEqual(await readNotes('alice'), ['a'], 'the staff policy still selects alice by role');
		} finally {
			await bjsReq({ url: `${ENDPOINT.REST}/api/v1/policy/${staff.id}`, method: 'DELETE' }, env.app.token);
		}
	});

	// SR-DPC-001 C11: the first #env reference in a list was left as its text, so the lookup found only note b
	it("Should read every #env reference in a list in an env lookup's query", async () => {
		assert.deepStrictEqual(await readNotes('lookup'), ['a', 'b']);
	});

	// SR-DPC-001 R1: an env value that referred back to itself was read until the stack overflowed, a 500
	it('Should grant nothing through configs reading an env value that refers back to itself, and the rest still', async () => {
		assert.deepStrictEqual(await readNotes('loop'), ['c']);
	});
});
