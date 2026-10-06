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

// The #env values of a list in a policy config's own query, as a request is checked against them
describe('Policy query env lists', async () => {
	const scope = 'Policy query env lists setup';
	const env = { app: null, users: {} };
	let REST_PROCESS = null;

	const notesUrl = () => `${ENDPOINT.REST}/${env.app.apiPath}/api/v1/note`;
	const readNotes = async (user) => (await bjsReq({ url: notesUrl(), method: 'GET' }, env.users[user].tokens[0].value))
		.map((note) => note.text).sort();

	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, scope);

		env.app = await runStep('create app', async () =>
			createApp(ENDPOINT.REST, 'Test Policy Query Env', 'test-policy-query-env')
		, scope);
		await runStep('allow policy properties', async () => updatePolicyPropertyList(ENDPOINT.REST, {
			queryEnvCase: ['list', 'unset'],
		}, env.app.token), scope);
		await runStep('add the note schema', async () => updateSchema(ENDPOINT.REST, [{
			name: 'note',
			type: 'collection',
			properties: { text: { __type: 'string', __default: null, __required: true, __allowUpdate: true } },
		}], env.app.token), scope);

		await runStep('create users', async () => {
			for (const queryEnvCase of ['list', 'unset']) {
				env.users[queryEnvCase] = await createPolicyUser(ENDPOINT.REST, env.app, `policy-query-env-${queryEnvCase}`, {
					queryEnvCase,
				});
			}
		}, scope);
		await runStep('add notes', async () => bjsReqPost(notesUrl(), [
			{ text: env.users.list.id }, { text: 'b' }, { text: 'c' },
		], env.app.token), scope);

		await runStep('create policies', async () => {
			const policy = (queryEnvCase, query) => ({
				name: `policy-query-env-${queryEnvCase}`,
				version: '1',
				selection: { queryEnvCase: { '@eq': queryEnvCase } },
				env: { second: 'b' },
				config: [{ verbs: ['GET', 'POST'], schema: ['note'], query }],
			});
			await createPolicy(ENDPOINT.REST, policy('list', { text: { '@in': ['#env.user.id', '#env.second'] } }), env.app.token);
			// The second item names an env value that isn't set
			await createPolicy(ENDPOINT.REST, policy('unset', { text: { '@nin': ['#env.second', '#env.third'] } }), env.app.token);
		}, scope);
	});

	after(async function () {
		if (env.app?.id) await deleteApp(ENDPOINT.REST, env.app.id);
		await REST_PROCESS.clean();
	});

	// The list's items were compared as their text, '#env.user.id', so the policy read no note
	it("Should read the notes a list in the config's query names by its #env values", async () => {
		assert.deepStrictEqual(await readNotes('list'), [env.users.list.id, 'b'].sort());
	});

	it("Should let a token add a note its config's list names, and refuse one it doesn't", async () => {
		const [added] = await bjsReqPost(notesUrl(), [{ text: 'b' }], env.users.list.tokens[0].value);
		assert.strictEqual(added.text, 'b');
		await assert.rejects(
			bjsReqPost(notesUrl(), [{ text: 'c' }], env.users.list.tokens[0].value),
			(err) => err instanceof BJSReqError && err.code === 403,
		);
	});

	// As a value that isn't set does; dropping the item instead would have read every note but b
	it("Should grant nothing through a config whose list names an #env value that isn't set", async () => {
		await assert.rejects(
			bjsReq({ url: notesUrl(), method: 'GET' }, env.users.unset.tokens[0].value),
			(err) => err instanceof BJSReqError && err.code === 403 && err.body?.code === 'access_denied',
		);
	});
});
