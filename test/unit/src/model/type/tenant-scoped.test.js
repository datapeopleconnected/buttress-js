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

// Answers queries on the rows above, as a datastore would, and records the calls that reach it
const createAdapter = () => {
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
      return Readable.from(rows.filter((row) => matches(row, query)));
    },
    findOne: async (query) => {
      calls.push(['findOne', query]);
      return rows.find((row) => matches(row, query)) ?? null;
    },
    findById: async (id) => {
      calls.push(['findById', id]);
      return rows.find((row) => row.id === id) ?? null;
    },
    count: async (query) => {
      calls.push(['count', query]);
      return rows.filter((row) => matches(row, query)).length;
    },
    exists: async (id, extra) => {
      calls.push(['exists', id, extra]);
      return rows.some((row) => row.id === id && matches(row, extra));
    },
    updateByPaths: async (id) => calls.push(['updateByPaths', id]),
    rm: async (id) => calls.push(['rm', id]),
    rmBulk: async (ids) => calls.push(['rmBulk', ids]),
    rmAll: async (query) => calls.push(['rmAll', query]),
  };
  return adapter;
};

const createModel = () => {
  const model = new StandardModel(schema, null, services);
  model.adapter = createAdapter();
  return model;
};
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

      await assert.rejects(() => scoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], rows[1].id), {
        code: 400,
        message: 'invalid_id',
      });
      assert.deepStrictEqual(writes(model), []);
    });

    it('updates its own row', async () => {
      const model = createModel();

      await scoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], rows[0].id);

      assert.deepStrictEqual(writes(model), [['updateByPaths', rows[0].id]]);
    });

    it("refuses to remove another app's row, without writing", async () => {
      const model = createModel();

      await assert.rejects(() => scoped(model).rm(rows[1].id), { code: 400, message: 'invalid_id' });
      assert.deepStrictEqual(writes(model), []);
    });

    it("removes only its own rows of those it's given", async () => {
      const model = createModel();

      await scoped(model).rmBulk([rows[0].id, rows[1].id]);

      assert.deepStrictEqual(writes(model), [['rmBulk', [rows[0].id]]]);
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

    it("updates any app's row", async () => {
      const model = createModel();

      await unscoped(model).updateByPath([{ path: 'name', value: 'x', contextPath: '^name$' }], rows[1].id);

      assert.deepStrictEqual(writes(model), [['updateByPaths', rows[1].id]]);
    });
  });

  describe('the apps collection', () => {
    it('is scoped by the app\'s own id', async () => {
      const model = new StandardModel({ name: 'apps', type: 'collection', properties: {} }, null, services);
      model.adapter = createAdapter();

      await (await new TenantScopedModel(model, APP, 'id').find({})).toArray();

      assert.deepStrictEqual(model.adapter.calls, [['find', { id: APP }]]);
    });
  });
});
