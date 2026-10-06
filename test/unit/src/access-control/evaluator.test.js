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

import { dependsOnToken, evaluate, mergeGrants } from '../../../../dist/access-control/evaluator.js';
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

  // SR-DPC-001 S8: a policy stored with a limit that isn't a date granted access for ever
  it("grants nothing through a policy whose limit isn't a date, keeping the others", async () => {
    const mistyped = policy('mistyped', {}, { limit: '2025-13-45' });
    await assert.rejects(evaluate([mistyped], context()), refusal(403, 'access_denied', /any policy associated/));

    const grants = await evaluate([mistyped, policy('fine', {}, { limit: '2025-07-01T00:00:00.000Z' })], context());
    assert.deepStrictEqual(grants.map((grant) => grant.policies), [['fine#0']]);
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

  it("grants through a token's other policies when one's condition has an operator nothing knows", async () => {
    const broken = policy('broken', { condition: { '#env.appId': { '@like': 'app1' } } });
    const grants = await evaluate([broken, policy('fine', {})], context());

    assert.deepStrictEqual(grants.map((grant) => grant.policies), [['fine#0']]);
  });

  it("grants nothing through a config whose query names an operator nothing knows, rather than failing the request", async () => {
    const broken = policy('broken', { query: { name: { '@foo': 'x' } } });
    const grants = await evaluate([broken, policy('fine', {})], context());

    assert.deepStrictEqual(grants.map((grant) => grant.policies), [['fine#0']]);
  });

  it("grants nothing through a config whose query has a logical operator without a list of queries", async () => {
    for (const query of [{ '@or': { name: 'a' } }, { '@or': [] }, { '@and': ['x'] }]) {
      const grants = await evaluate([policy('broken', { query }), policy('fine', { query: { name: 'b' } })], context());
      assert.deepStrictEqual(grants.map((grant) => grant.policies), [['fine#0']], JSON.stringify(query));
    }
    await assert.rejects(
      evaluate([policy('broken', { query: { '@or': {} } })], context()),
      refusal(403, 'access_denied', /query can not be applied to user/),
    );
  });

  // SR-DPC-001 R1: an env value that referred back to itself overflowed the stack, failing the request
  it('grants nothing through a config whose query or condition reads an env value that refers back to itself', async () => {
    const loop = { a: '#env.b', b: '#env.a' };
    const grants = await evaluate(
      [
        policy('query-loop', { query: { name: '#env.a' } }, { env: loop }),
        policy('condition-loop', { condition: { '#env.a': { '@eq': 'x' } } }, { env: loop }),
        policy('fine', { query: { name: 'b' } }),
      ],
      context(),
    );
    assert.deepStrictEqual(grants.map((grant) => grant.policies), [['fine#0']]);

    await assert.rejects(
      evaluate([policy('query-loop', { query: { name: '#env.a' } }, { env: loop })], context()),
      refusal(403, 'access_denied', /query can not be applied to user/),
    );
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

describe('access-control/evaluator:evaluate for realtime', () => {
  it('grants each config that lets the token read the schema, whatever the verb, when asked about reads', async () => {
    const grants = await evaluate(
      [policy('searcher', { verbs: ['SEARCH'] }), policy('poster', { verbs: ['POST'] })],
      context({ verb: 'PUT', reads: true }),
    );
    assert.deepStrictEqual(grants.map((grant) => grant.policies), [['searcher#0']]);
  });

  it("doesn't check the schema when it's left out, as an activity comes from a write to it", async () => {
    const { schema: _schema, ...withoutSchema } = context();
    assert.strictEqual((await evaluate([policy('p', {})], withoutSchema)).length, 1);
  });

  it('applies a config with no condition, as one whose condition is null', async () => {
    const withoutCondition = { ...policy('p', {}), config: [{ verbs: ['GET'], schema: ['user'], query: {} }] };
    assert.strictEqual((await evaluate([withoutCondition], context())).length, 1);
  });
});

// Whether a config is read differently for each token, so realtime evaluates it for each connected token
describe('access-control/evaluator:dependsOnToken', () => {
  const depends = (policyEnv, config) =>
    dependsOnToken({ env: policyEnv }, { verbs: ['GET'], schema: ['car'], query: {}, condition: null, env: null, ...config });

  it("is true for a query or condition that refers to the token's user", () => {
    assert.strictEqual(depends(null, { query: { owner: { '@eq': '#env.user.id' } } }), true);
    assert.strictEqual(depends(null, { query: { $or: [{ owner: { '@in': ['#env.user.id'] } }] } }), true);
    assert.strictEqual(depends(null, { condition: { '#env.user.role': { '@eq': 'admin' } } }), true);
    assert.strictEqual(depends(null, { condition: { '@or': [{ '#env.appId': { '@eq': '#env.user.appId' } }] } }), true);
  });

  it("is true for an env value that refers to the user, the config's env read over the policy's", () => {
    assert.strictEqual(depends({ userId: '#env.user.id' }, { query: { owner: { '@eq': '#env.userId' } } }), true);
    assert.strictEqual(depends({ userId: 'static' }, { env: { userId: '#env.user.id' }, query: { owner: '#env.userId' } }), true);
    assert.strictEqual(depends({ userId: '#env.user.id' }, { env: { userId: 'static' }, query: { owner: '#env.userId' } }), false);
    assert.strictEqual(depends({ a: '#env.b', b: '#env.user.id' }, { query: { owner: '#env.a' } }), true);
  });

  it('is true for an env lookup whose query refers to the user', () => {
    const companies = { collection: 'company', query: { ownerId: { '@eq': '#env.user.id' } }, output: { key: 'id', type: 'id' }, type: 'array' };
    assert.strictEqual(depends({ companies }, { query: { companyId: { '@in': '#env.companies' } } }), true);
  });

  it('is false for references to the app, the date, static env values, or none', () => {
    assert.strictEqual(depends(null, { query: { app: '#env.appId' }, condition: { '#env.date.now': { '@gtDate': '2025-01-01' } } }), false);
    assert.strictEqual(depends({ team: 'red' }, { query: { team: '#env.team' } }), false);
    assert.strictEqual(depends(null, { query: { access: '%FULL_ACCESS%' } }), false);
    // A name that starts with "user" isn't the user
    assert.strictEqual(depends({ userType: 'staff' }, { query: { type: '#env.userType' } }), false);
  });

  it("is false for an env value that refers to the user but isn't used", () => {
    assert.strictEqual(depends({ userId: '#env.user.id' }, { query: { access: '%FULL_ACCESS%' } }), false);
  });

  it('follows an env that defines the user itself, and env values that refer to each other', () => {
    assert.strictEqual(depends({ user: { id: 'static' } }, { query: { owner: '#env.user.id' } }), false);
    assert.strictEqual(depends({ a: '#env.b', b: '#env.a' }, { query: { owner: '#env.a' } }), false);
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
