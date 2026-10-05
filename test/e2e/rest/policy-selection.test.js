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

// Which tokens a policy's selection gives the policy to (D-35): every key must hold, the token must have each key it
// names, values compare exactly (D-32), and @and/@or take lists of selections
describe('Policy selection', async () => {
	const scope = 'Policy selection setup';
	const env = { app: null, users: {} };
	let REST_PROCESS = null;

	const readNotes = (user) => bjsReq({
		url: `${ENDPOINT.REST}/${env.app.apiPath}/api/v1/note`,
		method: 'GET',
	}, env.users[user].tokens[0].value);
	const refused = (err) => err instanceof BJSReqError && err.code === 403;
	const policy = (name, selection) => ({
		name,
		version: '1',
		selection,
		config: [{ verbs: ['GET'], schema: ['note'], query: { access: '%FULL_ACCESS%' } }],
	});

	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, scope);

		env.app = await runStep('create app', async () =>
			createApp(ENDPOINT.REST, 'Test Policy Selection', 'test-policy-selection')
		, scope);
		await runStep('allow policy properties', async () => updatePolicyPropertyList(ENDPOINT.REST, {
			role: ['ADMIN', 'admin', 'EDITOR', 'VIEWER'],
			team: ['RED', 'BLUE'],
			grade: [1, 2],
		}, env.app.token), scope);
		await runStep('add the note schema', async () => updateSchema(ENDPOINT.REST, [{
			name: 'note',
			type: 'collection',
			properties: { text: { __type: 'string', __default: null, __required: true, __allowUpdate: true } },
		}], env.app.token), scope);
		await runStep('add a note', async () =>
			bjsReqPost(`${ENDPOINT.REST}/${env.app.apiPath}/api/v1/note`, { text: 'a note' }, env.app.token)
		, scope);

		await runStep('create policies', async () => {
			await createPolicy(ENDPOINT.REST, policy('red-admins', { role: { '@eq': 'ADMIN' }, team: { '@eq': 'RED' } }), env.app.token);
			await createPolicy(ENDPOINT.REST, policy('editors-or-blue-grade-2', {
				'@or': [{ role: { '@eq': 'EDITOR' } }, { '@and': [{ team: { '@eq': 'BLUE' } }, { grade: { '@eq': 2 } }] }],
			}), env.app.token);
		}, scope);

		await runStep('create users', async () => {
			const users = {
				redAdmin: { role: 'ADMIN', team: 'RED' },
				admin: { role: 'ADMIN' },
				blueAdmin: { role: 'ADMIN', team: 'BLUE' },
				lowerRedAdmin: { role: 'admin', team: 'RED' },
				editor: { role: 'EDITOR' },
				blueGrade2: { team: 'BLUE', grade: 2 },
				blueGrade1: { team: 'BLUE', grade: 1 },
				viewer: { role: 'VIEWER', team: 'RED' },
			};
			for (const [key, properties] of Object.entries(users)) {
				env.users[key] = await createPolicyUser(ENDPOINT.REST, env.app, `policy-selection-${key}`, properties);
			}
		}, scope);
	});

	after(async function () {
		if (env.app?.id) await deleteApp(ENDPOINT.REST, env.app.id);
		await REST_PROCESS.clean();
	});

	it('Should give a policy to a token that matches every key of its selection', async () => {
		assert.strictEqual((await readNotes('redAdmin')).length, 1);
	});

	it("Shouldn't give a policy to a token that lacks one of its selection's keys, or fails one", async () => {
		await assert.rejects(readNotes('admin'), refused);
		await assert.rejects(readNotes('blueAdmin'), refused);
	});

	it('Should compare a selection exactly, not ignoring case', async () => {
		await assert.rejects(readNotes('lowerRedAdmin'), refused);
	});

	it('Should give a policy through any branch of @or, every branch of an @and needed', async () => {
		assert.strictEqual((await readNotes('editor')).length, 1);
		assert.strictEqual((await readNotes('blueGrade2')).length, 1);
		await assert.rejects(readNotes('blueGrade1'), refused);
		await assert.rejects(readNotes('viewer'), refused);
	});

	it('Should refuse a selection naming a property the app does not list within @or, or an @or with no selections', async () => {
		for (const selection of [
			{ '@or': [{ role: { '@eq': 'ADMIN' } }, { level: { '@eq': 1 } }] },
			{ '@or': [{ role: { '@eq': 'OWNER' } }] },
			{ '@or': [] },
			{ '@and': { role: { '@eq': 'ADMIN' } } },
		]) {
			await assert.rejects(
				createPolicy(ENDPOINT.REST, policy('policy-selection-bad', selection), env.app.token),
				(err) => err instanceof BJSReqError && err.code === 400 && err.body?.code === 'invalid_policy_selection',
				JSON.stringify(selection),
			);
		}
	});

	it("Should refuse a token's policy property listed in another case (D-34)", async () => {
		await assert.rejects(
			createPolicyUser(ENDPOINT.REST, env.app, 'policy-selection-viewer-lower', { role: 'viewer' }),
			(err) => err instanceof BJSReqError && err.code === 400,
		);
	});
});
