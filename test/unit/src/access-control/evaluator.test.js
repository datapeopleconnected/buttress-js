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

import { describe, it } from 'mocha';
import assert from 'assert';

import { evaluate, mergeGrants } from '../../../../dist/access-control/evaluator.js';
import { PolicyError } from '../../../../dist/access-control/index.js';

const userSchema = {
  name: 'user',
  type: 'collection',
  properties: { name: { __type: 'string' }, email: { __type: 'string' } },
};

const env = { date: { now: '2025-06-01T00:00:00.000Z' }, ipAddress: null, user: { id: 'u1' }, appId: 'app1' };
const context = (overrides = {}) => ({
  schemaName: 'user',
  schema: userSchema,
  isCoreSchema: false,
  verb: 'GET',
  appId: 'app1',
  env,
  now: new Date('2025-06-01T00:00:00.000Z'),
  ...overrides,
});
const policy = (name, config, overrides = {}) => ({
  id: `id-${name}`,
  name,
  priority: 0,
  env: null,
  limit: null,
  config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null, ...config }],
  ...overrides,
});
const refusal = (status, code, message) => (err) => {
  assert.ok(err instanceof PolicyError, String(err));
  assert.strictEqual(err.status, status);
  assert.strictEqual(err.code, code);
  assert.match(err.message, message);
  return true;
};

describe('access-control/evaluator:evaluate', () => {
  it('refuses a token with no policies, or only ones whose limit has passed', async () => {
    await assert.rejects(evaluate([], context()), refusal(403, 'access_denied', /does not have any policy associated/));
    const expired = policy('old', {}, { limit: '2025-05-01T00:00:00.000Z' });
    await assert.rejects(evaluate([expired], context()), refusal(403, 'access_denied', /any policy associated/));
  });

  it('refuses when no config is for the verb and schema', async () => {
    await assert.rejects(
      evaluate([policy('poster', { verbs: ['POST'] })], context()),
      refusal(403, 'access_denied', /does not have any policy rules matching the request verb GET and schema user/),
    );
  });

  it("refuses with 404 when the app has no schema by the name, once a config is for it", async () => {
    await assert.rejects(
      evaluate([policy('p', {})], context({ schema: null })),
      refusal(404, 'unknown_schema', /does not exist in the app/),
    );
  });

  it('refuses when no config left has a condition that holds', async () => {
    await assert.rejects(
      evaluate([policy('p', { condition: { '#env.appId': { '@eq': 'other-app' } } })], context()),
      refusal(403, 'access_denied', /condition is not fulfilled to access user/),
    );
  });

  it('refuses when no config left has a query whose env values are set', async () => {
    await assert.rejects(
      evaluate([policy('p', { query: { owner: { '@eq': '#env.user.nickname' } } })], context()),
      refusal(403, 'access_denied', /query can not be applied to user/),
    );
  });

  it('grants each config left, its query read with the env and its access keys dropped, in priority order', async () => {
    const grants = await evaluate(
      [
        policy('second', { query: { owner: { '@eq': '#env.user.id' } }, projection: { keys: ['name'] } }, { priority: 2 }),
        policy('first', { query: { access: '%FULL_ACCESS%' } }, { priority: 1 }),
        policy('expired', {}, { limit: new Date('2025-05-01T00:00:00.000Z') }),
      ],
      context(),
    );

    assert.deepStrictEqual(
      grants.map(({ policies, query, projection }) => ({ policies, query, projection })),
      [
        { policies: ['first#0'], query: {}, projection: null },
        { policies: ['second#0'], query: { owner: { $eq: 'u1' } }, projection: ['name'] },
      ],
    );
  });

  it("drops a config whose query can't be built, keeping the others", async () => {
    const grants = await evaluate(
      [policy('nickname', { query: { owner: '#env.user.nickname' } }), policy('id', { query: { owner: '#env.user.id' } })],
      context(),
    );
    assert.deepStrictEqual(grants.map((grant) => grant.query), [{ owner: 'u1' }]);
  });

  it("reads the policy's and the config's env", async () => {
    const [grant] = await evaluate(
      [policy('p', { query: { team: { '@eq': '#env.team' } }, env: { team: 'red' } }, { env: { team: 'blue' } })],
      context(),
    );
    assert.deepStrictEqual(grant.query, { team: { $eq: 'red' } });
  });

  it('takes a projection with no keys as no restriction', async () => {
    const [grant] = await evaluate([policy('p', { projection: { keys: [] } })], context());
    assert.strictEqual(grant.projection, null);
  });
});

describe('access-control/evaluator:mergeGrants', () => {
  const grant = (name, query, projection = null) => ({ policies: [name], appId: 'app1', config: {}, query, projection });
  const shape = (grants) => grants.map(({ policies, query, projection }) => ({ policies, query, projection }));

  it("ORs the queries of grants that don't restrict properties", () => {
    assert.deepStrictEqual(shape(mergeGrants([grant('a', { a: 1 }), grant('b', { b: 2 })])), [
      { policies: ['a', 'b'], query: { $or: [{ a: 1 }, { b: 2 }] }, projection: null },
    ]);
  });

  it('reads every entity when one of them does', () => {
    assert.deepStrictEqual(shape(mergeGrants([grant('a', { a: 1 }), grant('b', {})])), [
      { policies: ['a', 'b'], query: {}, projection: null },
    ]);
  });

  it('unions the properties of grants with the same query', () => {
    assert.deepStrictEqual(shape(mergeGrants([grant('a', { a: 1 }, ['name']), grant('b', { a: 1 }, ['email', 'name'])])), [
      { policies: ['a', 'b'], query: { a: 1 }, projection: ['name', 'email'] },
    ]);
  });

  it('gives every property when one of the grants with the same query does (BUG-17)', () => {
    assert.deepStrictEqual(shape(mergeGrants([grant('a', { a: 1 }, ['name']), grant('b', { a: 1 })])), [
      { policies: ['a', 'b'], query: { a: 1 }, projection: null },
    ]);
  });

  it('keeps apart grants with other queries that restrict properties', () => {
    assert.deepStrictEqual(shape(mergeGrants([grant('a', { a: 1 }, ['name']), grant('b', { b: 2 }), grant('c', { c: 3 }, ['email'])])), [
      { policies: ['a'], query: { a: 1 }, projection: ['name'] },
      { policies: ['b'], query: { b: 2 }, projection: null },
      { policies: ['c'], query: { c: 3 }, projection: ['email'] },
    ]);
  });

  it('merges a same-query grant into the unrestricted grants it then joins', () => {
    assert.deepStrictEqual(shape(mergeGrants([grant('a', { a: 1 }), grant('b', { b: 2 }, ['name']), grant('c', { b: 2 })])), [
      { policies: ['a', 'b', 'c'], query: { $or: [{ a: 1 }, { b: 2 }] }, projection: null },
    ]);
  });
});
