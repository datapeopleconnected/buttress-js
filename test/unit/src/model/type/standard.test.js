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

// A query value is converted as a body's would be, through the same codecs (D-2)
describe('model/type/StandardModel:parseQuery values', () => {
  const flagSchema = {
    name: 'flag',
    type: 'collection',
    extends: [],
    properties: {
      on: { __type: 'boolean', __default: false, __allowUpdate: true },
      count: { __type: 'number', __default: 0, __allowUpdate: true },
      ref: { __type: 'uuid', __default: null, __allowUpdate: true },
      ownerId: { __type: 'id', __allowUpdate: true },
    },
  };
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('converts a boolean or number given as text, as a body would be', () => {
    const model = createModel(flagSchema);

    assert.deepStrictEqual(model.parseQuery({ on: 'yes' }), { on: { $eq: true } });
    assert.deepStrictEqual(model.parseQuery({ on: { $ne: '0' } }), { on: { $ne: false } });
    assert.deepStrictEqual(model.parseQuery({ count: { $gt: '5' } }), { count: { $gt: 5 } });
    assert.deepStrictEqual(model.parseQuery({ count: { $in: ['1', 2] } }), { count: { $in: [1, 2] } });
    assert.deepStrictEqual(model.parseQuery({ ref: UUID }), { ref: { $eq: UUID } });
  });

  it('leaves a null to match a property that has no value', () => {
    assert.deepStrictEqual(createModel(flagSchema).parseQuery({ on: null }), { on: { $eq: null } });
  });

  for (const [query, path, expected] of [
    [{ on: 'banana' }, 'on', 'boolean'],
    [{ count: { $lt: 'many' } }, 'count', 'number'],
    [{ ref: { $in: [UUID, 'not-a-uuid'] } }, 'ref', 'uuid'],
    // It matched every entity without an owner, as the value was dropped to null
    [{ ownerId: 'not-an-id' }, 'ownerId', 'id'],
  ]) {
    it(`refuses ${JSON.stringify(query)} with 400 invalid_value, rather than matching what it shouldn't`, () => {
      assert.throws(() => createModel(flagSchema).parseQuery(query), {
        status: 400,
        code: 'invalid_value',
        details: { path, expected },
      });
    });
  }
});

describe('model/type/StandardModel:parseQuery', () => {
  it('turns a direct value compare into $eq', () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ name: 'widget-1' }), { name: { $eq: 'widget-1' } });
  });

  it('turns a direct null compare into $eq null rather than dropping it', () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ name: null }), { name: { $eq: null } });
    assert.deepStrictEqual(model.parseQuery({ $and: [{ name: null }] }), { $and: [{ name: { $eq: null } }] });

    const contacts = { __type: 'array', __schema: { ownerId: { __type: 'id' } } };
    assert.deepStrictEqual(model.parseQuery({ contacts: null }, {}, { contacts }), { contacts: { $eq: null } });
  });

  it('passes through an already-prefixed mongo operator unchanged', () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ age: { $gt: 18 } }), { age: { $gt: 18 } });
  });

  // A parsed query is still a Buttress query; only the MongoDB adapter gives it MongoDB's names (toMongoQuery)
  it("keeps $not, which the MongoDB adapter gives as $ne", () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ age: { $not: 18 } }), { age: { $not: 18 } });
  });

  it('keeps the date-range operators, with the operand read as a Date', () => {
    const model = createModel();
    const result = model.parseQuery({ createdAt: { $gtDate: '2025-01-01' } }, {}, { createdAt: { __type: 'date' } });
    assert.deepStrictEqual(result, { createdAt: { $gtDate: new Date('2025-01-01') } });
  });

  it('keeps $rex and $rexi, and $inProp with the text it looks for', () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ name: { $rex: '^wid' } }), { name: { $rex: '^wid' } });
    assert.deepStrictEqual(model.parseQuery({ name: { $rexi: '^wid' } }), { name: { $rexi: '^wid' } });
    assert.deepStrictEqual(model.parseQuery({ name: { $inProp: 'a.b' } }), { name: { $inProp: 'a.b' } });
  });

  it("gives an operator's @ name as its $ name", () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ name: { '@rexi': '^wid', '@not': 'x' } }), { name: { $rexi: '^wid', $not: 'x' } });
  });

  it('gives the same query when it reads one it has already read', () => {
    const model = createModel();
    const once = model.parseQuery({ name: { $rexi: '^wid' }, createdAt: { $gtDate: '2025-01-01' } }, {}, { name: { __type: 'string' }, createdAt: { __type: 'date' } });
    assert.deepStrictEqual(model.parseQuery(once, {}, { name: { __type: 'string' }, createdAt: { __type: 'date' } }), once);
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

  it('resolves an #env-style path operand against envFlat', () => {
    const model = createModel();
    const result = model.parseQuery({ name: { $eq: 'env.currentUserName' } }, { currentUserName: 'Alice' });
    assert.deepStrictEqual(result, { name: { $eq: 'Alice' } });
  });
  // The MongoDB adapter escapes it, so it's matched as the text it is (toMongoQuery)
  it("keeps $inProp's text as it is", () => {
    const model = createModel();
    assert.deepStrictEqual(model.parseQuery({ name: { $inProp: 'a.b(c' } }), { name: { $inProp: 'a.b(c' } });
  });

  it('recurses into $nor arrays, as into $or and $and', () => {
    const model = createModel();
    const result = model.parseQuery({ $nor: [{ name: 'a' }, { age: { $gt: 3 } }] });
    assert.deepStrictEqual(result, { $nor: [{ name: { $eq: 'a' } }, { age: { $gt: 3 } }] });
  });

  it("takes an operator on an array of objects, whose operand isn't keyed by the items' properties", () => {
    const model = createModel();
    const lines = { __type: 'array', __schema: { ownerId: { __type: 'id' }, label: { __type: 'string' } } };
    assert.deepStrictEqual(model.parseQuery({ lines: { $in: ['x'] } }, {}, { lines }), { lines: { $in: ['x'] } });
  });

  it('refuses a date it cannot read, rather than matching every dated entity', () => {
    const model = createModel();
    assert.throws(
      () => model.parseQuery({ createdAt: { $gtDate: 'not a date' } }, {}, { createdAt: { __type: 'date' } }),
      (err) => err.status === 400 && err.code === 'invalid_value' && err.details.path === 'createdAt' && err.details.expected === 'date',
    );
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

describe('model/type/StandardModel: adding an entity with typed array items', () => {
  const schema = {
    name: 'organisation',
    type: 'collection',
    extends: [],
    properties: {
      contacts: {
        __type: 'array',
        __allowUpdate: true,
        __schema: {
          name: { __type: 'string', __default: null, __required: true, __allowUpdate: true },
          qty: { __type: 'number', __default: 0, __allowUpdate: true },
          phones: {
            __type: 'array',
            __allowUpdate: true,
            __schema: { number: { __type: 'string', __default: null, __allowUpdate: true } },
          },
        },
      },
      tags: { __type: 'array', __itemtype: 'string', __allowUpdate: true },
    },
  };

  const model = () => createModel(structuredClone(schema));

  it('keeps a typed array nested inside an item', () => {
    const entity = model().__parseAddBody({ contacts: [{ name: 'A', phones: [{ number: '123', extra: 1 }] }] }, {});

    assert.deepStrictEqual(entity.contacts, [{ name: 'A', qty: 0, phones: [{ number: '123' }] }]);
  });

  it('refuses an entity whose item has a value of the wrong type, naming it', () => {
    const result = model().validate({ contacts: [{ name: 'A' }, { name: 'B', qty: 'lots' }] });

    assert.strictEqual(result.isValid, false);
    assert.deepStrictEqual(result.invalid, ['contacts.1.qty:lots[string]']);
  });

  it('refuses an entity whose item is missing a required property, naming it', () => {
    const result = model().validate({ contacts: [{ qty: 1 }] });

    assert.strictEqual(result.isValid, false);
    assert.deepStrictEqual(result.missing, ['contacts.0.name']);
  });

  it('refuses an entity with an item that is not an object, naming it as an update does', () => {
    const result = model().validate({ contacts: [{ name: 'A' }, 'Bob', [{ name: 'C' }]] });

    assert.strictEqual(result.isValid, false);
    assert.deepStrictEqual(result.missing, []);
    assert.deepStrictEqual(result.invalid, ['contacts.1:Bob[string] [object]', 'contacts.2:[object Object][array] [object]']);
  });

  it('refuses an entity with a null item in a typed array, naming it', () => {
    const withNullContact = model().validate({ contacts: [{ name: 'A' }, null] });
    assert.strictEqual(withNullContact.isValid, false);
    assert.deepStrictEqual(withNullContact.missing, []);
    assert.deepStrictEqual(withNullContact.invalid, ['contacts.1:null[null] [object]']);

    const withNullTag = model().validate({ tags: ['a', null] });
    assert.strictEqual(withNullTag.isValid, false);
    assert.deepStrictEqual(withNullTag.invalid, ['tags.1:null[null] [string]']);
  });

  it('refuses an entity with an invalid item in a nested typed array', () => {
    const result = model().validate({ contacts: [{ name: 'A', phones: [{ number: true }] }] });

    assert.strictEqual(result.isValid, false);
    assert.deepStrictEqual(result.invalid, ['contacts.0.phones.0.number:true[boolean]']);
  });

  it('accepts an entity whose items are valid', () => {
    assert.strictEqual(model().validate({ contacts: [{ name: 'A', qty: 2, phones: [{ number: '1' }] }] }).isValid, true);
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

describe('model/type/StandardModel:updateByPath — vector-add with a whole-array value', () => {
  // Regression test for a bug found while designing an unrelated feature: updateByPath's
  // vector-add-with-array-value fallback (src/model/type/standard.ts) checked `body.value`
  // instead of `update.value`, so it never fired — `body` is the array of update descriptors by
  // this point, not the current one, and arrays have no `.value` property.
  const schemaWithArray = {
    ...widgetSchema,
    properties: { ...widgetSchema.properties, tags: { __type: 'array', __itemtype: 'string', __allowUpdate: true } },
  };

  it('downgrades a bare-array-path update to a scalar (whole-property) set when the value is an array', async () => {
    const model = createModel(schemaWithArray);

    await model.updateByPath({ path: 'tags', value: ['a', 'b', 'c'], contextPath: '^tags$' }, HEX_ID);

    const context = model.adapter.batchUpdateProcess.firstCall.args[2];
    assert.strictEqual(context.type, 'scalar');
  });

  it('leaves a bare-array-path update as vector-add when the value is a single item', async () => {
    const model = createModel(schemaWithArray);

    await model.updateByPath({ path: 'tags', value: 'a', contextPath: '^tags$' }, HEX_ID);

    const context = model.adapter.batchUpdateProcess.firstCall.args[2];
    assert.strictEqual(context.type, 'vector-add');
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
