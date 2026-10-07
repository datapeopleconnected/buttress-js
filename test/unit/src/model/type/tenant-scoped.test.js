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
import { Readable } from 'stream';

import StandardModel from '../../../../../dist/model/type/standard.js';
import TenantScopedModel from '../../../../../dist/model/type/tenant-scoped.js';

// A core collection every app shares, whose rows name their app
const schema = {
  name: 'widgets',
  type: 'collection',
  properties: {
    name: { __type: 'string', __default: null, __allowUpdate: true },
    _appId: { __type: 'id', __required: true, __allowUpdate: false },
  },
};
const services = new Map([
  ['nrp', { on: async () => () => {} }],
  ['modelManager', {}],
]);

const APP = '6abd0000000000000000000a';
const OTHER_APP = '6abd0000000000000000000b';
const rows = [
  { id: '6abd00000000000000000001', name: 'ours', _appId: APP },
  { id: '6abd00000000000000000002', name: 'theirs', _appId: OTHER_APP },
];

// A query as the MongoDB adapter hands it to MongoDB: a top-level `id` becomes `_id`, the last one given winning
const stored = (query) =>
  Object.fromEntries(
    Object.entries(query).map(([key, value]) => {
      if (key === '$and' || key === '$or') return [key, value.map(stored)];
      return [key === 'id' ? '_id' : key, value];
    }),
  );

// Answers queries on the rows given, as a datastore would, and records the calls that reach it
const createAdapter = (data = rows) => {
  const calls = [];
  const matches = (row, query) =>
    Object.entries(query).every(([key, value]) => {
      if (key === '$and') return value.every((part) => matches(row, part));
      const field = key === '_id' ? 'id' : key;
      if (value && typeof value === 'object' && '$eq' in value) return row[field] === value.$eq;
      if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(row[field]);
      return row[field] === value;
    });
  const adapter = {
    calls,
    find: (query) => {
      calls.push(['find', query]);
      return Readable.from(data.filter((row) => matches(row, stored(query))));
    },
    findOne: async (query) => {
      calls.push(['findOne', query]);
      return data.find((row) => matches(row, stored(query))) ?? null;
    },
    findById: async (id) => {
      calls.push(['findById', id]);
      return data.find((row) => row.id === id) ?? null;
    },
    count: async (query) => {
      calls.push(['count', query]);
      return data.filter((row) => matches(row, stored(query))).length;
    },
    exists: async (id, extra) => {
      calls.push(['exists', id, extra]);
      return data.some((row) => matches(row, stored({ _id: id, ...extra })));
    },
    updateByPaths: async (id) => calls.push(['updateByPaths', id]),
    rm: async (id) => calls.push(['rm', id]),
    rmBulk: async (ids) => calls.push(['rmBulk', ids]),
    rmAll: async (query) => calls.push(['rmAll', query]),
    // Stores the row as the model builds it from the body and its internals
    add: async (body, parse) => {
      const row = parse(body);
      calls.push(['add', row]);
      return row;
    },
    ID: { new: (id) => id ?? '6abd00000000000000000099', isValid: (id) => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id) },
  };
  return adapter;
};

const createModel = () => {
  const model = new StandardModel(schema, null, services);
  model.adapter = createAdapter();
  return model;
};
// Another app's row is answered as one that doesn't exist; an id that can't be one, as invalid
const notFound = (id) => ({ status: 404, code: 'not_found', details: { schema: 'widget', id } });
const invalidId = { status: 400, code: 'invalid_id' };

const writes = (model) => model.adapter.calls.filter(([call]) => ['updateByPaths', 'rm', 'rmBulk', 'rmAll'].includes(call));

describe('model/type/TenantScopedModel', () => {
  describe("an app's", () => {
    const scoped = (model = createModel()) => new TenantScopedModel(model, APP);

    it('finds only its own rows, whatever the query', async () => {
      const found = await (await scoped().find({ name: { $eq: 'theirs' } })).toArray();

      assert.deepStrictEqual(found, []);
    });

    it('lists only its own rows', async () => {
      const found = await (await scoped().find({})).toArray();

      assert.deepStrictEqual(found.map((row) => row.name), ['ours']);
    });

    it('finds one of its own rows, and not another app\'s', async () => {
      const model = scoped();

      assert.strictEqual((await model.findOne({ name: 'ours' }))?.name, 'ours');
      assert.strictEqual(await model.findOne({ name: 'theirs' }), null);
    });

    it("finds its own row by id, and gives null for another app's", async () => {
      const model = scoped();

      assert.strictEqual((await model.findById(rows[0].id))?.name, 'ours');
      assert.strictEqual(await model.findById(rows[1].id), null);
    });

    it('counts only its own rows', async () => {
      assert.strictEqual(await scoped().count({}), 1);
    });

    it("says another app's row doesn't exist", async () => {
      const model = scoped();

      assert.deepStrictEqual([await model.exists(rows[0].id), await model.exists(rows[1].id)], [true, false]);
    });

    it("refuses to update another app's row, without writing", async () => {
      const model = createModel();

      await assert.rejects(() => scoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], rows[1].id),
        notFound(rows[1].id));
      await assert.rejects(() => scoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], 'not-an-id'),
        invalidId);
      assert.deepStrictEqual(writes(model), []);
    });

    it('updates its own row', async () => {
      const model = createModel();

      await scoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], rows[0].id);

      assert.deepStrictEqual(writes(model), [['updateByPaths', rows[0].id]]);
    });

    it("refuses to remove another app's row, without writing", async () => {
      const model = createModel();

      await assert.rejects(() => scoped(model).rm(rows[1].id), notFound(rows[1].id));
      assert.deepStrictEqual(writes(model), []);
    });

    it("removes only its own rows of those it's given", async () => {
      const model = createModel();

      await scoped(model).rmBulk([rows[0].id, rows[1].id]);

      assert.deepStrictEqual(writes(model), [['rmBulk', [rows[0].id]]]);
    });

    it("gives the model for one of its own rows, for the model's own methods", async () => {
      const model = createModel();

      assert.strictEqual(await scoped(model).owned(rows[0].id), model);
    });

    it("refuses the model for another app's row", async () => {
      await assert.rejects(() => scoped().owned(rows[1].id), notFound(rows[1].id));
      await assert.rejects(() => scoped().owned('not-an-id'), invalidId);
    });

    it("checks its own row exists, answering another app's as not found", async () => {
      const model = scoped();

      await model.assertExists(rows[0].id);
      await assert.rejects(() => model.assertExists(rows[1].id), notFound(rows[1].id));
      await assert.rejects(() => model.assertExists('not-an-id'), invalidId);
    });

    it("finds its own row by id or fails, answering another app's as not found", async () => {
      const model = scoped();

      assert.strictEqual((await model.findByIdOrFail(rows[0].id)).name, 'ours');
      await assert.rejects(() => model.findByIdOrFail(rows[1].id), notFound(rows[1].id));
      await assert.rejects(() => model.findByIdOrFail('6abd00000000000000000077'), notFound('6abd00000000000000000077'));
      await assert.rejects(() => model.findByIdOrFail('not-an-id'), invalidId);
    });

    it('adds a row for its own app, whatever app the caller names', async () => {
      const model = createModel();

      const row = await scoped(model).add({ name: 'new' }, { _appId: OTHER_APP });

      assert.deepStrictEqual([row.name, row._appId], ['new', APP]);
    });

    it("keeps the model's other internals when it adds a row", async () => {
      const model = createModel();

      const row = await scoped(model).add({ name: 'new', _appId: OTHER_APP }, { _tokenId: 'token-1' });

      assert.deepStrictEqual([row._appId, row._tokenId], [APP, 'token-1']);
    });

    it('removes all of its own rows, and no others', async () => {
      const model = createModel();

      await scoped(model).rmAll({});

      assert.deepStrictEqual(writes(model), [['rmAll', { _appId: APP }]]);
    });
  });

  describe('a system token\'s', () => {
    const unscoped = (model = createModel()) => new TenantScopedModel(model, null);

    it('finds every row', async () => {
      const found = await (await unscoped().find({})).toArray();

      assert.deepStrictEqual(found.map((row) => row.name), ['ours', 'theirs']);
    });

    it("gives the model for any app's row", async () => {
      const model = createModel();

      assert.strictEqual(await unscoped(model).owned(rows[1].id), model);
    });

    it("finds any app's row by id, or fails for one that doesn't exist", async () => {
      assert.strictEqual((await unscoped().findByIdOrFail(rows[1].id)).name, 'theirs');
      await assert.rejects(() => unscoped().findByIdOrFail('6abd00000000000000000077'), notFound('6abd00000000000000000077'));
    });

    it('adds a row for the app it names', async () => {
      const row = await unscoped().add({ name: 'new' }, { _appId: OTHER_APP });

      assert.strictEqual(row._appId, OTHER_APP);
    });

    it('refuses to add a row for no app', async () => {
      const model = createModel();

      await assert.rejects(() => unscoped(model).add({ name: 'new' }, {}), /the app it's for/);
      assert.deepStrictEqual(model.adapter.calls, []);
    });

    it("updates any app's row", async () => {
      const model = createModel();

      await unscoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], rows[1].id);

      assert.deepStrictEqual(writes(model), [['updateByPaths', rows[1].id]]);
    });
  });

  // An app is its own tenant, so the clause names `id`, as does the app asked for
  describe('the apps collection', () => {
    const apps = [
      { id: APP, name: 'ours' },
      { id: OTHER_APP, name: 'theirs' },
    ];
    const createAppModel = () => {
      const model = new StandardModel({ name: 'apps', type: 'collection', properties: {} }, null, services);
      model.adapter = createAdapter(apps);
      return model;
    };
    const scoped = (model = createAppModel()) => new TenantScopedModel(model, APP, 'id');
    const appNotFound = (id) => ({ status: 404, code: 'not_found', details: { schema: 'app', id } });

    it('adds no app through the scoped model', async () => {
      await assert.rejects(() => scoped().add({ name: 'new' }, {}), /an app/);
    });

    it('is scoped by the app\'s own id', async () => {
      const model = createAppModel();

      await (await scoped(model).find({})).toArray();

      assert.deepStrictEqual(model.adapter.calls, [['find', { id: APP }]]);
    });

    it("finds the app's own row by id, and gives null for another app's", async () => {
      const model = scoped();

      assert.strictEqual((await model.findById(APP))?.name, 'ours');
      assert.strictEqual(await model.findById(OTHER_APP), null);
    });

    it("finds the app's own row by id or fails, answering another app's as not found", async () => {
      const model = scoped();

      assert.strictEqual((await model.findByIdOrFail(APP)).name, 'ours');
      await assert.rejects(() => model.findByIdOrFail(OTHER_APP), appNotFound(OTHER_APP));
    });

    it("says another app doesn't exist", async () => {
      const model = scoped();

      assert.deepStrictEqual([await model.exists(APP), await model.exists(OTHER_APP)], [true, false]);
      assert.strictEqual(await model.exists('not-an-id'), false);
    });

    it("checks the app's own row exists, answering another app's as not found", async () => {
      const model = scoped();

      await model.assertExists(APP);
      await assert.rejects(() => model.assertExists(OTHER_APP), appNotFound(OTHER_APP));
    });

    it("gives the model for the app's own row, and refuses it for another app's", async () => {
      const model = createAppModel();

      assert.strictEqual(await scoped(model).owned(APP), model);
      await assert.rejects(() => scoped(model).owned(OTHER_APP), appNotFound(OTHER_APP));
    });

    it("refuses to update or remove another app, without writing", async () => {
      const model = createAppModel();

      await assert.rejects(() => scoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], OTHER_APP),
        appNotFound(OTHER_APP));
      await assert.rejects(() => scoped(model).rm(OTHER_APP), appNotFound(OTHER_APP));
      assert.deepStrictEqual(writes(model), []);
    });

    it('updates and removes its own app', async () => {
      const model = createAppModel();

      await scoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], APP);
      await scoped(model).rm(APP);

      assert.deepStrictEqual(writes(model), [['updateByPaths', APP], ['rm', APP]]);
    });
  });
});
