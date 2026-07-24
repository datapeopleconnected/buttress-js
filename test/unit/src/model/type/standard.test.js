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
import sinon from 'sinon';

import StandardModel from '../../../../../dist/model/type/standard.js';

const HEX_ID = '507f1f77bcf86cd799439011';

// A minimal-but-real fake adapter: `isValid` mirrors a Mongo ObjectId hex check, `new` wraps
// the value so tests can distinguish "converted" ids from plain strings.
function createAdapter() {
  return {
    ID: {
      isValid: (v) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v),
      new: (v) => ({ id: v !== undefined ? v : 'generated-id' }),
    },
    add: sinon.stub().resolves({ id: 'added' }),
    batchUpdateProcess: sinon.stub().callsFake(async (id, update) => ({ id, path: update.path })),
  };
}

const widgetSchema = {
  name: 'widget',
  type: 'collection',
  extends: [],
  properties: {
    name: { __type: 'string', __default: '', __allowUpdate: true },
    ownerId: { __type: 'id', __allowUpdate: true },
    age: { __type: 'number', __allowUpdate: true },
  },
};

function createModel(schemaData = widgetSchema, { app = null } = {}) {
  const nrp = { on: () => {}, emit: () => {} };
  const services = new Map([
    ['nrp', nrp],
    ['modelManager', {}],
  ]);
  const model = new StandardModel(schemaData, app, services);
  model.adapter = createAdapter();
  return model;
}

describe('model/type/StandardModel:constructor', () => {
  it('throws when nrp is missing from services', () => {
    const services = new Map([['modelManager', {}]]);
    assert.throws(() => new StandardModel(widgetSchema, null, services), /Unable to find nrp/);
  });

  it('throws when modelManager is missing from services', () => {
    const services = new Map([['nrp', { on: () => {} }]]);
    assert.throws(() => new StandardModel(widgetSchema, null, services), /Unable to find modelManager/);
  });

  it('is a core API model with an unprefixed collection name when there is no app', () => {
    const model = createModel();
    assert.strictEqual(model.isCoreAPI, true);
    assert.strictEqual(model.collectionName, 'widget');
  });

  it('prefixes the collection name with the app short id when scoped to an app', () => {
    const model = createModel(widgetSchema, { app: { id: '507f1f77bcf86cd799439099' } });
    assert.strictEqual(model.isCoreAPI, false);
    assert.ok(model.collectionName.endsWith('-widget'));
    assert.notStrictEqual(model.collectionName, 'widget');
  });
});

describe('model/type/StandardModel:createId/isValidId/convertStringToId', () => {
  it('delegates createId to the adapter', () => {
    const model = createModel();
    assert.deepStrictEqual(model.createId(HEX_ID), { id: HEX_ID });
  });

  it('delegates isValidId to the adapter', () => {
    const model = createModel();
    assert.strictEqual(model.isValidId(HEX_ID), true);
    assert.strictEqual(model.isValidId('not-an-id'), false);
  });

  it('converts a valid id string via the adapter', () => {
    const model = createModel();
    assert.deepStrictEqual(model.convertStringToId(HEX_ID), { id: HEX_ID });
  });

  it('leaves an invalid id string unconverted', () => {
    const model = createModel();
    assert.strictEqual(model.convertStringToId('not-an-id'), 'not-an-id');
  });
});

describe('model/type/StandardModel:parseQuery', () => {
  it('turns a direct value compare into $eq', () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ name: 'widget-1' }), { name: { $eq: 'widget-1' } });
  });

  it('passes through an already-prefixed mongo operator unchanged', () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ age: { $gt: 18 } }), { age: { $gt: 18 } });
  });

  it('renames $not to $ne', () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ age: { $not: 18 } }), { age: { $ne: 18 } });
  });

  it('renames date-range operators and converts the operand to a Date', () => {
    const model = createModel();
    const result = model.parseQuery({ createdAt: { $gtDate: '2025-01-01' } }, {}, { createdAt: { __type: 'date' } });
    assert.deepStrictEqual(result, { createdAt: { $gt: new Date('2025-01-01') } });
  });

  it('rewrites $rex/$rexi into a case-insensitive $regex', () => {
    const model = createModel();
    const result = model.parseQuery({ name: { $rex: '^wid' } });
    assert.deepStrictEqual(result, { name: { $regex: '^wid', $options: 'i' } });
  });

  it('recurses into $or/$and arrays', () => {
    const model = createModel();
    const result = model.parseQuery({ $or: [{ name: 'a' }, { name: 'b' }] });
    assert.deepStrictEqual(result, { $or: [{ name: { $eq: 'a' } }, { name: { $eq: 'b' } }] });
  });

  it('ignores the internal __crPath property', () => {
    const model = createModel();
    const result = model.parseQuery({ __crPath: 'ignored', name: 'a' });
    assert.deepStrictEqual(result, { name: { $eq: 'a' } });
  });

  it('converts a valid hex id string in a direct-compare query using the schema', () => {
    const model = createModel();
    const result = model.parseQuery({ ownerId: HEX_ID }, {}, model.flatSchemaData);
    assert.deepStrictEqual(result, { ownerId: { $eq: { id: HEX_ID } } });
  });

  it('leaves an invalid id operand unconverted rather than throwing', () => {
    const model = createModel();
    const result = model.parseQuery({ ownerId: { $eq: 'not-an-id' } }, {}, model.flatSchemaData);
    assert.deepStrictEqual(result, { ownerId: { $eq: 'not-an-id' } });
  });

  it('resolves an #env-style path operand against envFlat', () => {
    const model = createModel();
    const result = model.parseQuery({ name: { $eq: 'env.currentUserName' } }, { currentUserName: 'Alice' });
    assert.deepStrictEqual(result, { name: { $eq: 'Alice' } });
  });
});

describe('model/type/StandardModel:validate', () => {
  it('reports valid when all required properties are present', () => {
    const model = createModel();
    const result = model.validate({ name: 'widget-1' });
    assert.strictEqual(result.isValid, true);
  });

  it('wraps a single object into an array before validating', () => {
    const model = createModel();
    const result = model.validate({ name: 'widget-1' });
    assert.strictEqual(result.isValid, true);
  });

  it('returns the first invalid entry out of a batch', () => {
    const model = createModel({
      ...widgetSchema,
      properties: { ...widgetSchema.properties, age: { __type: 'number', __allowUpdate: true, __required: true } },
    });

    const result = model.validate([{ name: 'ok', age: 5 }, { name: 'missing-age' }]);
    assert.strictEqual(result.isValid, false);
  });
});

describe('model/type/StandardModel:__parseAddBody / add', () => {
  it('generates a new id when the body has none', () => {
    const model = createModel();
    const entity = model.__parseAddBody({ name: 'widget-1' }, {});
    assert.deepStrictEqual(entity.id, { id: 'generated-id' });
  });

  it('reuses the provided id when the body has one', () => {
    const model = createModel();
    const entity = model.__parseAddBody({ id: HEX_ID, name: 'widget-1' }, {});
    assert.deepStrictEqual(entity.id, { id: HEX_ID });
  });

  it('sanitizes the body down to schema-defined properties', () => {
    const model = createModel();
    const entity = model.__parseAddBody({ name: 'widget-1', notInSchema: 'drop-me' }, {});
    assert.strictEqual(entity.name, 'widget-1');
    assert.strictEqual('notInSchema' in entity, false);
  });

  it('stamps createdAt/updatedAt when the schema extends timestamps', () => {
    const model = createModel({ ...widgetSchema, extends: ['timestamps'] });
    const entity = model.__parseAddBody({ name: 'widget-1' }, {});
    assert.ok(entity.createdAt instanceof Date);
    assert.strictEqual(entity.updatedAt, null);
  });

  it('add() delegates to adapter.add with a body-parsing function', () => {
    const model = createModel();
    model.add({ name: 'widget-1' }, { extraInternal: true });

    assert.ok(model.adapter.add.calledOnce);
    const [body, parseFn] = model.adapter.add.firstCall.args;
    assert.deepStrictEqual(body, { name: 'widget-1' });
    const parsed = parseFn({ name: 'widget-1' });
    assert.strictEqual(parsed.extraInternal, true);
  });
});

describe('model/type/StandardModel:updateByPath', () => {
  it('runs each path update through adapter.batchUpdateProcess and collects the results in order', async () => {
    const model = createModel();

    const result = await model.updateByPath(
      [
        { path: 'name', value: 'new-name', contextPath: '^name$' },
        { path: 'age', value: 21, contextPath: '^age$' },
      ],
      HEX_ID,
    );

    assert.strictEqual(model.adapter.batchUpdateProcess.callCount, 2);
    assert.deepStrictEqual(
      result.map((r) => r.path),
      ['name', 'age'],
    );
  });

  it('wraps a single update object into an array', async () => {
    const model = createModel();

    const result = await model.updateByPath({ path: 'name', value: 'solo', contextPath: '^name$' }, HEX_ID);

    assert.strictEqual(model.adapter.batchUpdateProcess.callCount, 1);
    assert.strictEqual(result[0].path, 'name');
  });

  it('appends an updatedAt path update when the schema extends timestamps', async () => {
    // Mirrors src/schema/timestamps.json, which `extends: ['timestamps']` normally merges in
    // via buildCollections() before a schema ever reaches StandardModel.
    const model = createModel({
      ...widgetSchema,
      extends: ['timestamps'],
      properties: {
        ...widgetSchema.properties,
        createdAt: { __type: 'date', __default: 'now', __required: false, __allowUpdate: false },
        updatedAt: { __type: 'date', __required: false, __allowUpdate: true },
      },
    });

    await model.updateByPath({ path: 'name', value: 'new-name', contextPath: '^name$' }, HEX_ID);

    const paths = model.adapter.batchUpdateProcess.getCalls().map((c) => c.args[1].path);
    assert.deepStrictEqual(paths, ['name', 'updatedAt']);
  });
});

describe('model/type/StandardModel:simple adapter delegators', () => {
  const cases = [
    ['update', ['select', 'update'], ['select', 'update']],
    ['updateOne', ['query', 'update'], ['query', 'update']],
    ['updateById', ['id', 'query'], ['id', 'query']],
    ['rm', ['id'], ['id']],
    ['rmBulk', [['id-1', 'id-2']], [['id-1', 'id-2']]],
    ['rmAll', ['query'], ['query']],
    ['findById', ['id'], ['id']],
    ['findOne', ['query'], ['query', {}]],
    ['findAll', [], []],
    ['findByIds', [['id-1']], [['id-1']]],
    ['count', ['query'], ['query']],
    ['drop', [], []],
    ['isDuplicate', ['details'], ['details']],
  ];

  const adapterMethod = { findByIds: 'findAllById' };

  for (const [method, args, expectedArgs] of cases) {
    it(`${method}() delegates to adapter.${adapterMethod[method] || method}`, () => {
      const model = createModel();
      const targetMethod = adapterMethod[method] || method;
      model.adapter[targetMethod] = sinon.stub().returns('adapter-result');

      const result = model[method](...args);

      assert.strictEqual(result, 'adapter-result');
      assert.deepStrictEqual(model.adapter[targetMethod].firstCall.args, expectedArgs);
    });
  }

  it('find() forwards all query options to the adapter', () => {
    const model = createModel();
    model.adapter.find = sinon.stub().returns('stream');

    const result = model.find('query', 'excludes', 10, 0, 'sort', true);

    assert.strictEqual(result, 'stream');
    assert.deepStrictEqual(model.adapter.find.firstCall.args, ['query', 'excludes', 10, 0, 'sort', true]);
  });

  it('exists() forwards id and extra to the adapter', () => {
    const model = createModel();
    model.adapter.exists = sinon.stub().returns(true);

    const result = model.exists('id-1', null, { foo: 'bar' });

    assert.strictEqual(result, true);
    assert.deepStrictEqual(model.adapter.exists.firstCall.args, ['id-1', { foo: 'bar' }]);
  });
});
