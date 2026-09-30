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
import { Readable } from 'node:stream';

import * as ACM from '../../../../dist/access-control/models-access.js';

function readableOf(items) {
  const stream = new Readable({ objectMode: true, read() {} });
  process.nextTick(() => {
    items.forEach((item) => stream.push(item));
    stream.push(null);
  });
  return stream;
}

async function drain(stream) {
  const items = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (item) => items.push(item));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return items;
}

describe('access-control/models-access:find', () => {
  it('streams and merges results from every policy config when all succeed', async () => {
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => query,
      find: (query) => readableOf([{ id: `${query.tag}-a` }, { id: `${query.tag}-b` }]),
    };
    const ac = {
      policyConfigs: [{ appId: 'app-1', query: { tag: 'one' } }, { appId: 'app-1', query: { tag: 'two' } }],
    };

    // An empty raw query means `mergeQueryFiltersWithAccessControl` returns each policy config's
    // own query unchanged (see filter.ts:359), so the mock's flat `query.tag` reads are meaningful.
    const stream = await ACM.find(model, { query: {} }, ac);
    const items = await drain(stream);

    assert.strictEqual(items.length, 4);
  });

  it('merges the results of a model whose find is async, as a federated model is', async () => {
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => query,
      find: async (query) => readableOf([{ id: `${query.tag}-a` }]),
    };
    const ac = {
      policyConfigs: [{ appId: 'app-1', query: { tag: 'one' } }, { appId: 'app-1', query: { tag: 'two' } }],
    };

    const items = await drain(await ACM.find(model, { query: {} }, ac));

    assert.deepStrictEqual(items.map((item) => item.id).sort(), ['one-a', 'two-a']);
  });

  it('rejects instead of silently returning a partial stream when one policy config fails to parse', async () => {
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => {
        if (query.shouldFail) throw new TypeError("Cannot read properties of undefined (reading '__type')");
        return query;
      },
      find: (query) => readableOf([{ id: `${query.tag}-a` }]),
    };
    const ac = {
      policyConfigs: [
        { appId: 'app-1', query: { tag: 'one' } },
        { appId: 'app-1', query: { tag: 'two', shouldFail: true } },
      ],
    };

    await assert.rejects(
      () => ACM.find(model, { query: {} }, ac),
      /Cannot read properties of undefined/,
    );
  });

  it('does not start any datastore find() call when a later policy config fails to parse', async () => {
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => {
        if (query.shouldFail) throw new Error('bad policy query');
        return query;
      },
      find: () => {
        assert.fail('find() should not be called when a sibling policy config fails to parse');
      },
    };
    const ac = {
      policyConfigs: [
        { appId: 'app-1', query: { tag: 'one' } },
        { appId: 'app-1', query: { shouldFail: true } },
      ],
    };

    await assert.rejects(() => ACM.find(model, { query: {} }, ac));
  });

  it("fails the merged stream with a policy's find error, and stops the other finds", async () => {
    const err = new Error('$in needs an array');
    const streams = {};
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => query,
      find: (query) => {
        streams[query.tag] = new Readable({ objectMode: true, read() {} });
        return streams[query.tag];
      },
    };
    const ac = {
      policyConfigs: [{ appId: 'app-1', query: { tag: 'one' } }, { appId: 'app-1', query: { tag: 'two' } }],
    };

    const stream = await ACM.find(model, { query: {} }, ac);
    const drained = drain(stream);
    streams.two.destroy(err);

    await assert.rejects(drained, (thrown) => thrown === err);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(streams.one.destroyed, "the other policy's find should be destroyed");
  });
});

describe('access-control/models-access:reachesEveryEntity', () => {
  it('is true when there are no policy configs, as for a system token', () => {
    assert.strictEqual(ACM.reachesEveryEntity({ policyConfigs: [] }), true);
  });

  it('is true when any policy config has no query, as a built %FULL_ACCESS% query has none', () => {
    assert.strictEqual(ACM.reachesEveryEntity({ policyConfigs: [{ query: { owner: 'alice' } }, { query: {} }] }), true);
    assert.strictEqual(ACM.reachesEveryEntity({ policyConfigs: [{ query: null }] }), true);
  });

  it('is true for a config that only restricts fields', () => {
    assert.strictEqual(ACM.reachesEveryEntity({ policyConfigs: [{ query: {}, projection: { keys: ['name'] } }] }), true);
  });

  it('is false when every policy config has a query', () => {
    const policyConfigs = [{ query: { owner: 'alice' } }, { query: { shared: { $eq: true } } }];
    assert.strictEqual(ACM.reachesEveryEntity({ policyConfigs }), false);
  });
});

describe('access-control/models-access:combineQueriesWithAc projection', () => {
  const project = async (clientProject, policyProjection) => {
    const policyConfig = { appId: 'app-1', query: null, projection: policyProjection };
    const combined = await ACM.combineQueriesWithAc({ query: {}, project: clientProject }, policyConfig);
    return combined.project;
  };

  it('gives only the properties both the request and the policy name', async () => {
    assert.deepStrictEqual(await project({ name: 1, salary: 1 }, { name: 1, email: 1 }), { name: 1 });
    assert.deepStrictEqual(await project({ 'address.street': 1 }, { address: 1 }), { 'address.street': 1 });
    assert.deepStrictEqual(await project({ address: 1 }, { 'address.street': 1 }), { 'address.street': 1 });
  });

  it("gives the policy's properties when the request names none of them, or none at all", async () => {
    for (const clientProject of [{ salary: 1, ssn: 1 }, { salary: 0 }, {}, null, false, undefined]) {
      assert.deepStrictEqual(await project(clientProject, { name: 1 }), { name: 1 }, JSON.stringify(clientProject));
    }
  });

  it("keeps the request's projection when the policy doesn't limit properties", async () => {
    assert.deepStrictEqual(await project({ salary: 1 }, null), { salary: 1 });
  });
});

describe('access-control/models-access:canCreate', () => {
  const config = (query) => ({ appId: 'app-1', verbs: ['POST'], query, projection: null, policies: ['p'] });

  it('lets any entity be created when the policies reach every entity', () => {
    assert.strictEqual(ACM.canCreate({ policyConfigs: [] }, { teamId: 'T9' }), true);
    assert.strictEqual(ACM.canCreate({ policyConfigs: [config({})] }, { teamId: 'T9' }), true);
  });

  it("lets an entity be created only when a policy config's query reads it", () => {
    const ac = { policyConfigs: [config({ teamId: { $eq: 'T1' } }), config({ ownerId: { $eq: 'U1' } })] };

    assert.strictEqual(ACM.canCreate(ac, { teamId: 'T1', ownerId: 'U9' }), true);
    assert.strictEqual(ACM.canCreate(ac, { teamId: 'T9', ownerId: 'U1' }), true);
    assert.strictEqual(ACM.canCreate(ac, { teamId: 'T9', ownerId: 'U9' }), false);
  });
});
