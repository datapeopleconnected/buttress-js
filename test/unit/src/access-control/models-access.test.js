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
import { createSchemaModel, newId } from '../../../schema-model.js';

async function drain(stream) {
  const items = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (item) => items.push(item));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return items;
}

// A real schema model, so policies' queries go through the real parseQuery, over rows in memory
const schema = { name: 'notes', properties: { tag: { __type: 'string' }, when: { __type: 'date' } } };
const rowsTagged = (...tags) => tags.map((tag) => ({ id: newId(), tag }));
const policies = (...queries) => ({ policyConfigs: queries.map((query) => ({ appId: 'app-1', query })) });

describe('access-control/models-access:find', () => {
  it('streams and merges results from every policy config when all succeed', async () => {
    const { model } = createSchemaModel(schema, rowsTagged('one', 'one', 'two', 'two', 'three'));

    // An empty raw query means `mergeQueryFiltersWithAccessControl` returns each policy config's own query unchanged
    const items = await drain(await ACM.find(model, { query: {} }, policies({ tag: 'one' }, { tag: 'two' })));

    assert.deepStrictEqual(items.map((item) => item.tag).sort(), ['one', 'one', 'two', 'two']);
  });

  it('merges the results of a model whose find is async, as a federated model is', async () => {
    const { model } = createSchemaModel(schema, rowsTagged('one', 'two'));
    const find = model.find.bind(model);
    model.find = async (...args) => find(...args);

    const items = await drain(await ACM.find(model, { query: {} }, policies({ tag: 'one' }, { tag: 'two' })));

    assert.deepStrictEqual(items.map((item) => item.tag).sort(), ['one', 'two']);
  });

  it('rejects instead of silently returning a partial stream when one policy config fails to parse', async () => {
    const { model } = createSchemaModel(schema, rowsTagged('one'));

    await assert.rejects(
      () => ACM.find(model, { query: {} }, policies({ tag: 'one' }, { when: 'not a date' })),
      (err) => err.status === 400 && err.code === 'invalid_value' && err.details.path === 'when',
    );
  });

  it('does not start any datastore find() call when a later policy config fails to parse', async () => {
    const { model, datastore } = createSchemaModel(schema, rowsTagged('one'));

    await assert.rejects(() => ACM.find(model, { query: {} }, policies({ tag: 'one' }, { when: 'not a date' })));

    assert.deepStrictEqual(datastore.calls, []);
  });

  it("fails the stream with the find's error", async () => {
    const err = new Error('$in needs an array');
    const { model, datastore } = createSchemaModel(schema);
    let found;
    datastore.find = () => {
      found = new Readable({ objectMode: true, read() {} });
      return found;
    };

    const stream = await ACM.find(model, { query: {} }, policies({ tag: 'one' }, { tag: 'two' }));
    const drained = drain(stream);
    found.destroy(err);

    await assert.rejects(drained, (thrown) => thrown === err);
  });
});

// Several grants are read in one find (BUG-17): an entity comes once, the request's paging holds across them, and it
// keeps the properties of the grants whose query reads it
describe('access-control/models-access:find through several grants', () => {
  const people = { name: 'people', properties: {
    tag: { __type: 'string' }, name: { __type: 'string' }, email: { __type: 'string' },
  } };
  const person = (tag, n) => ({ id: newId(), tag, name: `name-${n}`, email: `email-${n}` });
  const grant = (query, keys) => ({ appId: 'app-1', query, projection: keys ? Object.fromEntries(keys.map((k) => [k, 1])) : null });

  it('reads an entity two grants reach once', async () => {
    const { model, datastore } = createSchemaModel(schema, rowsTagged('one', 'two'));
    const items = await drain(await ACM.find(model, { query: {} }, policies({ tag: 'one' }, { tag: { $in: ['one', 'two'] } })));

    assert.deepStrictEqual(items.map((item) => item.tag).sort(), ['one', 'two']);
    assert.strictEqual(datastore.calls.filter(([call]) => call === 'find').length, 1);
  });

  it("holds the request's limit, skip and sort across the grants", async () => {
    const { model } = createSchemaModel(schema, rowsTagged('e', 'a', 'd', 'b', 'c'));
    const ac = policies({ tag: { $in: ['a', 'b', 'c'] } }, { tag: { $in: ['c', 'd', 'e'] } });

    const items = await drain(await ACM.find(model, { query: {}, sort: { tag: 1 }, skip: 1, limit: 3 }, ac));

    assert.deepStrictEqual(items.map((item) => item.tag), ['b', 'c', 'd']);
  });

  it('gives each entity the properties of the grants that read it', async () => {
    const rows = [person('one', 1), person('two', 2), person('both', 3)];
    const { model } = createSchemaModel(people, rows);
    const ac = { policyConfigs: [grant({ tag: { $in: ['one', 'both'] } }, ['name']), grant({ tag: { $in: ['two', 'both'] } }, ['email'])] };

    const items = await drain(await ACM.find(model, { query: {}, sort: { name: 1 } }, ac));

    assert.deepStrictEqual(items, [
      { id: rows[0].id, name: 'name-1' },
      { id: rows[1].id, email: 'email-2' },
      { id: rows[2].id, name: 'name-3', email: 'email-3' },
    ]);
  });

  it("reads only the grants' properties and the fields their queries test", async () => {
    const rows = [person('one', 1), person('two', 2)];
    const { model, datastore } = createSchemaModel(people, rows);
    const projects = [];
    const find = datastore.find.bind(datastore);
    datastore.find = (...args) => {
      projects.push(args[5]);
      return find(...args);
    };
    const ac = { policyConfigs: [grant({ tag: 'one' }, ['name']), grant({ $or: [{ tag: 'two' }, { email: 'x' }] }, ['name'])] };

    const items = await drain(await ACM.find(model, { query: {}, sort: { name: 1 } }, ac));

    assert.deepStrictEqual(projects, [{ name: 1, tag: 1, email: 1 }]);
    assert.deepStrictEqual(items, [{ id: rows[0].id, name: 'name-1' }, { id: rows[1].id, name: 'name-2' }]);
  });

  it('reads a property once, not also a path within it', async () => {
    const addressed = { name: 'people', properties: {
      tag: { __type: 'string' }, address: { city: { __type: 'string' }, street: { __type: 'string' } },
    } };
    const { model, datastore } = createSchemaModel(addressed, [{ id: newId(), tag: 'one', address: { city: 'x' } }]);
    const projects = [];
    const find = datastore.find.bind(datastore);
    datastore.find = (...args) => {
      projects.push(args[5]);
      return find(...args);
    };
    const ac = { policyConfigs: [grant({ 'address.city': 'x' }, ['address']), grant({ tag: 'one' }, ['tag'])] };

    await drain(await ACM.find(model, { query: {} }, ac));

    assert.deepStrictEqual(projects, [{ address: 1, tag: 1 }]);
  });

  it("reads what the request projects and the queries' fields when a grant reads every property", async () => {
    const { model, datastore } = createSchemaModel(people, [person('one', 1)]);
    const projects = [];
    const find = datastore.find.bind(datastore);
    datastore.find = (...args) => {
      projects.push(args[5]);
      return find(...args);
    };
    const ac = { policyConfigs: [grant({ tag: 'one' }, ['name']), grant({ email: 'x' })] };

    await drain(await ACM.find(model, { query: {}, project: { name: 1 } }, ac));
    await drain(await ACM.find(model, { query: {} }, ac));

    assert.deepStrictEqual(projects, [{ name: 1, tag: 1, email: 1 }, false]);
  });

  it("gives every property, within the request's projection, of an entity a grant reads whole", async () => {
    const rows = [person('one', 1), person('two', 2)];
    const { model } = createSchemaModel(people, rows);
    const ac = { policyConfigs: [grant({ tag: 'one' }, ['name']), grant({ tag: 'two' })] };

    const whole = await drain(await ACM.find(model, { query: {}, sort: { name: 1 } }, ac));
    assert.deepStrictEqual(whole, [{ id: rows[0].id, name: 'name-1' }, rows[1]]);

    const projected = await drain(await ACM.find(model, { query: {}, sort: { name: 1 }, project: { email: 1, name: 1 } }, ac));
    assert.deepStrictEqual(projected, [
      { id: rows[0].id, name: 'name-1' },
      { id: rows[1].id, name: 'name-2', email: 'email-2' },
    ]);
  });
});

describe('access-control/models-access:count', () => {
  it('counts an entity two grants reach once, whether or not the count is the actual one', async () => {
    const { model } = createSchemaModel(schema, rowsTagged('one', 'two', 'three'));
    const ac = policies({ tag: 'one' }, { tag: { $in: ['one', 'two'] } });

    assert.strictEqual(await ACM.count(model, { query: {} }, ac), 2);
    assert.strictEqual(await ACM.count(model, { query: {} }, ac, true), 2);
  });
});

// A strict schema checks the paths of the client's query, at the route; a policy's query naming a path the schema
// doesn't have reads nothing, rather than refusing the client's request with a path it didn't send
describe('access-control/models-access: a strict schema', () => {
  const strict = { name: 'notes', strict: true, properties: { tag: { __type: 'string' } } };

  it("reads nothing through a policy query on a path the schema doesn't have", async () => {
    const { model } = createSchemaModel(strict, rowsTagged('one'));

    assert.deepStrictEqual(await drain(await ACM.find(model, { query: {} }, policies({ owner: 'alice' }))), []);
    const both = await drain(await ACM.find(model, { query: {} }, policies({ owner: 'alice' }, { tag: 'one' })));
    assert.deepStrictEqual(both.map((item) => item.tag), ['one']);
    assert.strictEqual(await ACM.count(model, { query: {} }, policies({ owner: 'alice' })), 0);
    assert.strictEqual(ACM.canCreate(policies({ owner: 'alice' }), { tag: 'one' }, model), false);
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
  const { model: crates } = createSchemaModel({ name: 'crate', properties: {} });
  const config = (query) => ({ appId: 'app-1', verbs: ['POST'], query, projection: null, policies: ['p'] });

  it('lets any entity be created when the policies reach every entity', () => {
    assert.strictEqual(ACM.canCreate({ policyConfigs: [] }, { teamId: 'T9' }, crates), true);
    assert.strictEqual(ACM.canCreate({ policyConfigs: [config({})] }, { teamId: 'T9' }, crates), true);
  });

  it("reads the entity as REST reads it, a bare value included", () => {
    const { model } = createSchemaModel({ name: 'crate', properties: { teamId: { __type: 'string' } } });
    const ac = { policyConfigs: [config({ teamId: 'T1' })] };

    assert.strictEqual(ACM.canCreate(ac, { teamId: 'T1' }, model), true);
    assert.strictEqual(ACM.canCreate(ac, { teamId: 't1' }, model), false);
  });

  it("lets an entity be created only when a policy config's query reads it", () => {
    const ac = { policyConfigs: [config({ teamId: { $eq: 'T1' } }), config({ ownerId: { $eq: 'U1' } })] };

    assert.strictEqual(ACM.canCreate(ac, { teamId: 'T1', ownerId: 'U9' }, crates), true);
    assert.strictEqual(ACM.canCreate(ac, { teamId: 'T9', ownerId: 'U1' }, crates), true);
    assert.strictEqual(ACM.canCreate(ac, { teamId: 'T9', ownerId: 'U9' }, crates), false);
  });
});
