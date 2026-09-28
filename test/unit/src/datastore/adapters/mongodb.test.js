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

import MongodbAdapter from '../../../../../dist/datastore/adapters/mongodb.js';
import StandardModel from '../../../../../dist/model/type/standard.js';

const ID = '507f1f77bcf86cd799439011';

const organisationSchema = {
  name: 'organisation',
  type: 'collection',
  extends: [],
  properties: {
    contacts: {
      __type: 'array',
      __allowUpdate: true,
      __schema: {
        name: { __type: 'string', __default: null, __allowUpdate: true },
        qty: { __type: 'number', __default: 0, __allowUpdate: true },
        address: {
          street: { __type: 'string', __default: null, __allowUpdate: true },
        },
      },
    },
    tags: { __type: 'array', __itemtype: 'string', __allowUpdate: true },
    notes: { __type: 'array', __allowUpdate: true },
  },
};

// A StandardModel on a real MongodbAdapter whose collection records the update of each bulkWrite op.
function createModel(schema = organisationSchema) {
  const services = new Map([
    ['nrp', { on: () => {}, emit: () => {} }],
    ['modelManager', {}],
  ]);
  const model = new StandardModel(structuredClone(schema), null, services);

  const ops = [];
  const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
  adapter.collection = {
    bulkWrite: async (batch) => {
      ops.push(...batch.map((op) => op.updateOne.update));
      return { ok: 1 };
    },
  };
  model.adapter = adapter;

  return { model, ops };
}

// The same steps as the update-one route: validate the body, then apply it.
async function update(model, body) {
  const { validation, body: validated } = model.validateUpdate(body);
  if (!validation.isValid) return { validation };

  return { validation, results: await model.updateByPath(validated, ID) };
}

describe('datastore/adapters/MongodbAdapter: whole-array writes to typed arrays', () => {
  it('replaces an item-schema array with each element cleaned against the item schema', async () => {
    const { model, ops } = createModel();

    const { validation, results } = await update(model, {
      path: 'contacts',
      value: [{ name: 'Alice', qty: 2, address: { street: 'A St' }, notInSchema: true }, { name: 'Bob' }],
    });

    const expected = [
      { name: 'Alice', qty: 2, address: { street: 'A St' } },
      { name: 'Bob', qty: 0, address: { street: null } },
    ];
    assert.strictEqual(validation.isValid, true);
    assert.deepStrictEqual(ops, [{ $set: { contacts: expected } }]);
    assert.deepStrictEqual(results, [{ type: 'scalar', path: 'contacts', value: expected }]);
  });

  it('replaces an item-schema array with an empty array', async () => {
    const { model, ops } = createModel();

    await update(model, { path: 'contacts', value: [] });

    assert.deepStrictEqual(ops, [{ $set: { contacts: [] } }]);
  });

  it('refuses the write when an element fails the item schema, naming the element', async () => {
    const { model, ops } = createModel();

    const { validation } = await update(model, {
      path: 'contacts',
      value: [{ name: 'Alice' }, { name: 'Bob', qty: 'lots' }],
    });

    assert.strictEqual(validation.isValid, false);
    assert.strictEqual(validation.invalidValue, 'contacts.1.qty:lots[string]');
    assert.deepStrictEqual(ops, []);
  });

  it('refuses an element that is not an object, so an array of arrays is not stored as defaults', async () => {
    const { model, ops } = createModel();

    const { validation } = await update(model, { path: 'contacts', value: [[{ name: 'Alice' }]] });

    assert.strictEqual(validation.isValid, false);
    assert.strictEqual(validation.invalidValue, 'contacts.0:[object Object][array] [object]');
    assert.deepStrictEqual(ops, []);
  });

  it('replaces an item-type array, converting each element to the item type', async () => {
    const { model, ops } = createModel();

    const { validation, results } = await update(model, { path: 'tags', value: ['z', 'a', 5] });

    assert.strictEqual(validation.isValid, true);
    assert.deepStrictEqual(ops, [{ $set: { tags: ['z', 'a', '5'] } }]);
    assert.deepStrictEqual(results, [{ type: 'scalar', path: 'tags', value: ['z', 'a', '5'] }]);
  });

  it('refuses the write when an element is not of the item type, naming the element', async () => {
    const { model, ops } = createModel();

    const { validation } = await update(model, { path: 'tags', value: ['z', { not: 'a string' }] });

    assert.strictEqual(validation.isValid, false);
    assert.strictEqual(validation.invalidValue, 'tags.1:[object Object][object] [string]');
    assert.deepStrictEqual(ops, []);
  });
});

describe('datastore/adapters/MongodbAdapter: single-item writes to typed arrays', () => {
  it('pushes one item cleaned against the item schema', async () => {
    const { model, ops } = createModel();

    const { results } = await update(model, { path: 'contacts', value: { name: 'Carol', notInSchema: true } });

    const expected = { name: 'Carol', qty: 0, address: { street: null } };
    assert.deepStrictEqual(ops, [{ $push: { contacts: expected } }]);
    assert.deepStrictEqual(results, [{ type: 'vector-add', path: 'contacts', value: expected }]);
  });

  it('refuses a push that fails the item schema', async () => {
    const { model, ops } = createModel();

    const { validation } = await update(model, { path: 'contacts', value: { name: 'Carol', qty: 'lots' } });

    assert.strictEqual(validation.invalidValue, 'contacts.qty:lots[string]');
    assert.deepStrictEqual(ops, []);
  });

  it('pushes one item of the item type', async () => {
    const { model, ops } = createModel();

    await update(model, { path: 'tags', value: 'c' });

    assert.deepStrictEqual(ops, [{ $push: { tags: 'c' } }]);
  });

  it('sets one item (path.N) cleaned against the item schema', async () => {
    const { model, ops } = createModel();

    const { results } = await update(model, { path: 'contacts.1', value: { name: 'Bob', notInSchema: true } });

    const expected = { name: 'Bob', qty: 0, address: { street: null } };
    assert.deepStrictEqual(ops, [{ $set: { 'contacts.1': expected } }]);
    assert.deepStrictEqual(results, [{ type: 'scalar', path: 'contacts.1', value: expected }]);
  });

  it('refuses a path.N set that fails the item schema', async () => {
    const { model, ops } = createModel();

    const { validation } = await update(model, { path: 'contacts.1', value: { name: 'Bob', qty: 'lots' } });

    assert.strictEqual(validation.isValid, false);
    assert.strictEqual(validation.invalidValue, 'contacts.1.qty:lots[string]');
    assert.deepStrictEqual(ops, []);
  });

  it('refuses a path.N set on an item-type array when the value is not of the item type', async () => {
    const { model, ops } = createModel();

    const { validation } = await update(model, { path: 'tags.0', value: { not: 'a string' } });

    assert.strictEqual(validation.isValid, false);
    assert.strictEqual(validation.invalidValue, 'tags.0:[object Object][object] [string]');
    assert.deepStrictEqual(ops, []);
  });

  it('sets one item (path.N) of an item-type array', async () => {
    const { model, ops } = createModel();

    await update(model, { path: 'tags.0', value: 'x' });

    assert.deepStrictEqual(ops, [{ $set: { 'tags.0': 'x' } }]);
  });
});

describe('datastore/adapters/MongodbAdapter: plain arrays', () => {
  it('appends one value to an array with no item type', async () => {
    const { model, ops } = createModel();

    const { validation, results } = await update(model, { path: 'notes', value: 'hello' });

    assert.strictEqual(validation.isValid, true);
    assert.deepStrictEqual(ops, [{ $push: { notes: 'hello' } }]);
    assert.deepStrictEqual(results, [{ type: 'vector-add', path: 'notes', value: 'hello' }]);
  });

  it('appends an object to an array with no item type as it is', async () => {
    const { model, ops } = createModel();

    await update(model, { path: 'notes', value: { text: 'hello', pinned: true } });

    assert.deepStrictEqual(ops, [{ $push: { notes: { text: 'hello', pinned: true } } }]);
  });

  it('replaces an array with no item type when the value is an array', async () => {
    const { model, ops } = createModel();

    await update(model, { path: 'notes', value: ['a', 'b'] });

    assert.deepStrictEqual(ops, [{ $set: { notes: ['a', 'b'] } }]);
  });
});

describe('datastore/adapters/MongodbAdapter: several appends in one request', () => {
  it('applies each append to the same property, in order', async () => {
    const { model, ops } = createModel();

    await update(model, [
      { path: 'tags', value: 'a' },
      { path: 'tags', value: 'b' },
      { path: 'contacts', value: { name: 'Alice' } },
      { path: 'contacts', value: { name: 'Bob' } },
    ]);

    assert.deepStrictEqual(ops, [
      { $push: { tags: 'a' } },
      { $push: { tags: 'b' } },
      { $push: { contacts: { name: 'Alice', qty: 0, address: { street: null } } } },
      { $push: { contacts: { name: 'Bob', qty: 0, address: { street: null } } } },
    ]);
  });
});

describe('datastore/adapters/MongodbAdapter: object properties of array items', () => {
  const notesSchema = {
    name: 'organisation',
    type: 'collection',
    extends: [],
    properties: {
      notes: {
        __type: 'array',
        __allowUpdate: true,
        __schema: {
          text: { __type: 'string', __default: null, __allowUpdate: true },
          meta: { __type: 'object', __default: null, __allowUpdate: true },
        },
      },
    },
  };

  const note = { text: 'hello', meta: { pinned: true } };

  it('keeps an object property of a pushed item', async () => {
    const { model, ops } = createModel(notesSchema);

    await update(model, { path: 'notes', value: note });

    assert.deepStrictEqual(ops, [{ $push: { notes: note } }]);
  });

  it('keeps an object property of an item set by path.N', async () => {
    const { model, ops } = createModel(notesSchema);

    await update(model, { path: 'notes.0', value: note });

    assert.deepStrictEqual(ops, [{ $set: { 'notes.0': note } }]);
  });

  it('keeps object properties when the whole array is replaced', async () => {
    const { model, ops } = createModel(notesSchema);

    await update(model, { path: 'notes', value: [note, { text: 'bare' }] });

    assert.deepStrictEqual(ops, [{ $set: { notes: [note, { text: 'bare', meta: null }] } }]);
  });
});

describe('datastore/adapters/MongodbAdapter: fields inside array items', () => {
  const peopleSchema = {
    name: 'organisation',
    type: 'collection',
    extends: [],
    properties: {
      people: {
        __type: 'array',
        __allowUpdate: true,
        __schema: {
          qty: { __type: 'number', __default: 0, __allowUpdate: true },
          ownerId: { __type: 'id', __default: null, __allowUpdate: true },
          address: { street: { __type: 'string', __default: null, __allowUpdate: true } },
          phones: {
            __type: 'array',
            __allowUpdate: true,
            __schema: { number: { __type: 'string', __default: null, __allowUpdate: true } },
          },
        },
      },
      matrix: { __type: 'array', __itemtype: 'array', __allowUpdate: true },
    },
  };

  const setOf = async (path, value) => {
    const { model, ops } = createModel(peopleSchema);
    const { validation } = await update(model, { path, value });
    return { validation, op: ops[0] };
  };

  it('refuses a value of the wrong type for a field of an item', async () => {
    const { validation, op } = await setOf('people.0.qty', 'lots');

    assert.strictEqual(validation.isValid, false);
    assert.strictEqual(validation.invalidValue, 'people.0.qty failed schema test');
    assert.strictEqual(op, undefined);
  });

  it("converts a field of an item to the field's type", async () => {
    assert.deepStrictEqual((await setOf('people.0.qty', '5')).op, { $set: { 'people.0.qty': 5 } });
    assert.deepStrictEqual((await setOf('people.0.address.street', 12)).op, { $set: { 'people.0.address.street': '12' } });

    const { op } = await setOf('people.0.ownerId', ID);
    assert.strictEqual(op.$set['people.0.ownerId'].constructor.name, 'ObjectId');
    assert.strictEqual(op.$set['people.0.ownerId'].toString(), ID);
  });

  it('increments a field of an item only by a number', async () => {
    assert.strictEqual((await setOf('people.0.qty.__increment__', 'lots')).validation.isValid, false);
    assert.deepStrictEqual((await setOf('people.0.qty.__increment__', 2)).op, { $inc: { 'people.0.qty': 2 } });
  });

  it('treats a typed array inside an item like any other typed array', async () => {
    assert.deepStrictEqual((await setOf('people.0.phones', { number: 5 })).op, {
      $push: { 'people.0.phones': { number: '5' } },
    });
    assert.deepStrictEqual((await setOf('people.0.phones', [{ number: 5 }])).op, {
      $set: { 'people.0.phones': [{ number: '5' }] },
    });
    assert.deepStrictEqual((await setOf('people.0.phones.1.number', 7)).op, { $set: { 'people.0.phones.1.number': '7' } });
    assert.strictEqual((await setOf('people.0.phones', 'x')).validation.isValid, false);
  });

  it('leaves an element of an array inside an array item-type array as it is', async () => {
    assert.deepStrictEqual((await setOf('matrix.0.1', 'x')).op, { $set: { 'matrix.0.1': 'x' } });
  });
});

describe('datastore/adapters/MongodbAdapter:isDuplicate', () => {
  function createAdapter(storedIds) {
    const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
    adapter.collection = {
      namespace: 'test.organisation',
      countDocuments: async (query) => (storedIds.includes(query._id.toString()) ? 1 : 0),
    };
    return adapter;
  }

  it('is a duplicate when an entity with the same id is stored', async () => {
    assert.strictEqual(await createAdapter([ID]).isDuplicate({ id: ID, name: 'a' }), true);
  });

  it('is not a duplicate when the id is new, or there is no id', async () => {
    const adapter = createAdapter([ID]);
    assert.strictEqual(await adapter.isDuplicate({ id: '507f1f77bcf86cd799439012' }), false);
    assert.strictEqual(await adapter.isDuplicate({ name: 'a' }), false);
  });
});
