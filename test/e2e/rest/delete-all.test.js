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
import { setTimeout as sleep } from 'node:timers/promises';

import {
  createApp,
  updateSchema,
  bjsReq,
  createPolicy,
  createPolicyUser,
  extractPolicyPropertyListFromPolicies,
  ENDPOINT,
} from '../../helpers.js';
import { runStep } from '../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';

let REST_PROCESS = null;

const testEnv = {
  app: null,
  user: null,
};

// Two policies for the same token, so a note either of them selects may be deleted.
const policies = [{
  name: 'own-notes',
  version: 1,
  selection: {role: {'@eq': 'user'}},
  config: [{verbs: ['GET', 'SEARCH', 'DELETE'], schema: ['note'], query: {owner: {'@eq': 'alice'}}}],
}, {
  name: 'shared-notes',
  version: 1,
  selection: {role: {'@eq': 'user'}},
  config: [{verbs: ['GET', 'SEARCH', 'DELETE'], schema: ['note'], query: {shared: {'@eq': 'yes'}}}],
}];

const schema = [{
  name: 'note',
  type: 'collection',
  properties: {
    owner: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true,
    },
    shared: {
      __type: 'string',
      __default: 'no',
      __required: false,
      __allowUpdate: true,
    },
  },
}];

const notes = [
  {owner: 'alice', shared: 'no'},
  {owner: 'bob', shared: 'no'},
  {owner: 'bob', shared: 'no'},
  {owner: 'bob', shared: 'yes'},
];

const noteRequest = (method, token, body) => bjsReq({
  url: `${ENDPOINT.REST}/${testEnv.app.apiPath}/api/v1/note`,
  method,
  headers: {'Content-Type': 'application/json'},
  body: body ? JSON.stringify(body) : undefined,
}, token);

const summarise = (list) => list.map((note) => `${note.owner}:${note.shared}`).sort();

const expectEventually = async (assertionFn, attempts = 40, intervalMs = 150) => {
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    try {
      await assertionFn();
      return;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(intervalMs);
    }
  }

  throw lastError;
};

describe('Delete all', async () => {
  before(async function() {
    this.timeout(60000);

    await runStep('init REST process', async () => {
      REST_PROCESS = new BootstrapRest();
      await REST_PROCESS.init();
    }, 'Delete all setup');

    testEnv.app = await runStep('create app', async () =>
      createApp(ENDPOINT.REST, 'Delete All App', 'test-delete-all-app', extractPolicyPropertyListFromPolicies(policies))
    , 'Delete all setup');
    await runStep('update app schema', async () => updateSchema(ENDPOINT.REST, schema, testEnv.app.token)
    , 'Delete all setup');

    await runStep('create policies', async () => {
      for (const policy of policies) await createPolicy(ENDPOINT.REST, policy, testEnv.app.token);
    }, 'Delete all setup');

    testEnv.user = await runStep('create user', async () =>
      createPolicyUser(ENDPOINT.REST, testEnv.app, 'deleteAllUser', {role: 'user'})
    , 'Delete all setup');

    await runStep('seed notes', async () => noteRequest('POST', testEnv.app.token, notes), 'Delete all setup');
  });

  after(async function() {
    await REST_PROCESS.clean();
  });

  it('Should only delete the notes the user\'s policies allow', async function() {
    const userToken = testEnv.user.tokens[0].value;

    await expectEventually(async () => {
      assert.deepStrictEqual(summarise(await noteRequest('GET', userToken)), ['alice:no', 'bob:yes']);
    });

    assert.strictEqual(await noteRequest('DELETE', userToken), true);

    assert.deepStrictEqual(summarise(await noteRequest('GET', testEnv.app.token)), ['bob:no', 'bob:no']);
    assert.deepStrictEqual(await noteRequest('GET', userToken), []);
  });

  it('Should delete nothing when the user\'s policies allow none of the notes', async function() {
    const userToken = testEnv.user.tokens[0].value;

    assert.strictEqual(await noteRequest('DELETE', userToken), true);

    assert.deepStrictEqual(summarise(await noteRequest('GET', testEnv.app.token)), ['bob:no', 'bob:no']);
  });

  it('Should delete every note with an app token, whose policy gives full access', async function() {
    assert.strictEqual(await noteRequest('DELETE', testEnv.app.token), true);

    assert.deepStrictEqual(await noteRequest('GET', testEnv.app.token), []);
  });
});
