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

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';

import { ObjectId } from 'bson';
import { MongoClient } from 'mongodb';

import MongodbAdapter, { applyUpdateOps, mergeUpdateOps } from '../../../../../dist/datastore/adapters/mongodb.js';
import { Datastore } from '../../../../../dist/datastore/index.js';
import IOStats from '../../../../../dist/helpers/io-stats.js';
import StandardModel from '../../../../../dist/model/type/standard.js';
import { isObjectId } from '../../../../../dist/datastore/adapters/object-id.js';

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

// A StandardModel on a real MongodbAdapter whose collection records the update document of each write. It holds one
// stored entity for updates that have to read it first.
function createModel(schema = organisationSchema, stored = {}) {
  const services = new Map([
    ['nrp', { on: () => {}, emit: () => {} }],
    ['modelManager', {}],
  ]);
  const model = new StandardModel(structuredClone(schema), null, services);

  const ops = [];
  const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
  adapter.collection = {
    findOne: async () => ({ _id: new ObjectId(ID), ...structuredClone(stored) }),
    updateOne: async (_filter, update) => {
      ops.push(update);
      return { matchedCount: 1 };
    },
  };
  model.adapter = adapter;
  // As StandardModel.initAdapter does, so the adapter converts the schema's id properties on the way in.
  adapter.updateSchema(model.schemaData);

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

// A null item of a typed array used to become an item of defaults (item schema) or a stored null (item type).
describe('datastore/adapters/MongodbAdapter: null items in typed arrays', () => {
  for (const [label, body, invalidValue] of [
    ['push to an item-schema array', { path: 'contacts', value: null }, 'contacts:null[null] [object]'],
    ['path.N set on an item-schema array', { path: 'contacts.1', value: null }, 'contacts.1:null[null] [object]'],
    ['whole item-schema array', { path: 'contacts', value: [{ name: 'A' }, null] }, 'contacts.1:null[null] [object]'],
    ['push to an item-type array', { path: 'tags', value: null }, 'tags:null[null] [string]'],
    ['path.N set on an item-type array', { path: 'tags.0', value: null }, 'tags.0:null[null] [string]'],
    ['whole item-type array', { path: 'tags', value: ['a', null] }, 'tags.1:null[null] [string]'],
  ]) {
    it(`refuses a null item in a ${label}, writing nothing`, async () => {
      const { model, ops } = createModel();

      const { validation } = await update(model, body);

      assert.strictEqual(validation.isValid, false);
      assert.strictEqual(validation.invalidValue, invalidValue);
      assert.deepStrictEqual(ops, []);
    });
  }

  it('still takes null as an item of an array with no item type', async () => {
    const { model, ops } = createModel();

    const { validation } = await update(model, { path: 'notes', value: null });

    assert.strictEqual(validation.isValid, true);
    assert.strictEqual(ops.length, 1);
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
  it('applies each append to the same property, in order, in one write', async () => {
    const { model, ops } = createModel(organisationSchema, { tags: ['z'] });

    await update(model, [
      { path: 'tags', value: 'a' },
      { path: 'tags', value: 'b' },
      { path: 'contacts', value: { name: 'Alice' } },
      { path: 'contacts', value: { name: 'Bob' } },
    ]);

    assert.deepStrictEqual(ops, [
      {
        $set: {
          tags: ['z', 'a', 'b'],
          contacts: [
            { name: 'Alice', qty: 0, address: { street: null } },
            { name: 'Bob', qty: 0, address: { street: null } },
          ],
        },
      },
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

  it("removes only the item at the index from an array inside an item, leaving that array's other nulls", async () => {
    const stored = { people: [{ qty: 1, phones: [{ number: '1' }, null, { number: '3' }] }] };
    const { model, ops } = createModel(peopleSchema, stored);

    await update(model, { path: 'people.0.phones.0.__remove__', value: '' });

    assert.deepStrictEqual(ops, [{ $set: { people: [{ qty: 1, phones: [null, { number: '3' }] }] } }]);
  });

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

describe('datastore/adapters/MongodbAdapter: one request, one write', () => {
  it('writes updates to separate paths as one update document, without reading first', async () => {
    const { model, ops } = createModel();
    model.adapter.collection.findOne = async () => assert.fail('should not read the entity');

    await update(model, [
      { path: 'tags', value: 'a' },
      { path: 'contacts.0.name', value: 'Alice' },
      { path: 'contacts.1', value: { name: 'Bob' } },
    ]);

    assert.deepStrictEqual(ops, [
      {
        $push: { tags: 'a' },
        $set: { 'contacts.0.name': 'Alice', 'contacts.1': { name: 'Bob', qty: 0, address: { street: null } } },
      },
    ]);
  });

  it('removes an item in one write, leaving no hole', async () => {
    const { model, ops } = createModel(organisationSchema, { tags: ['a', 'b', 'c'] });

    const { results } = await update(model, { path: 'tags.1.__remove__', value: '' });

    assert.deepStrictEqual(ops, [{ $set: { tags: ['a', 'c'] } }]);
    assert.deepStrictEqual(results, [{ type: 'vector-rm', path: 'tags', value: { numRemoved: 1, index: '1' } }]);
  });

  it("removes only the item at the index, leaving the array's other nulls", async () => {
    const { model, ops } = createModel(organisationSchema, { notes: ['a', null, 'b', null] });

    const { results } = await update(model, { path: 'notes.0.__remove__', value: '' });

    assert.deepStrictEqual(ops, [{ $set: { notes: [null, 'b', null] } }]);
    assert.deepStrictEqual(results, [{ type: 'vector-rm', path: 'notes', value: { numRemoved: 1, index: '0' } }]);
  });

  it('removes items one after another, a null item included, and nothing for an index past the end', async () => {
    const { model, ops } = createModel(organisationSchema, { notes: ['a', null, 'b'] });

    await update(model, [
      { path: 'notes.0.__remove__', value: '' },
      { path: 'notes.0.__remove__', value: '' },
      { path: 'notes.5.__remove__', value: '' },
    ]);

    assert.deepStrictEqual(ops, [{ $set: { notes: ['b'] } }]);
  });

  it('only writes the fields it read if they have not changed since, and tries again if they have', async () => {
    const { model } = createModel(organisationSchema, { tags: ['a', 'b'] });
    const filters = [];
    let changes = 2;
    model.adapter.collection.updateOne = async (filter) => {
      filters.push(filter);
      return { matchedCount: changes-- > 0 ? 0 : 1 };
    };

    await update(model, [{ path: 'tags.0.__remove__', value: '' }]);

    assert.strictEqual(filters.length, 3);
    assert.deepStrictEqual(filters[0].tags, ['a', 'b']);
  });

  it('gives up with a 409 if the entity keeps changing', async () => {
    const { model } = createModel(organisationSchema, { tags: ['a', 'b'] });
    model.adapter.collection.updateOne = async () => ({ matchedCount: 0 });

    await assert.rejects(
      () => update(model, [{ path: 'tags.0.__remove__', value: '' }]),
      (err) => err.status === 409,
    );
  });

  it('writes nothing when one of the updates cannot be applied to the entity', async () => {
    const { model, ops } = createModel(organisationSchema, { tags: 'not-an-array' });

    await assert.rejects(
      () =>
        update(model, [
          { path: 'contacts', value: { name: 'Alice' } },
          { path: 'tags.0.__remove__', value: '' },
        ]),
      (err) => err.status === 400 && err.message === "Update can't be applied: Cannot remove an item from a non-array value",
    );
    assert.deepStrictEqual(ops, []);
  });

  it("refuses with a 400 an update Mongo can't apply to the stored data, rather than a 500", async () => {
    const { model } = createModel();
    model.adapter.collection.updateOne = async () => {
      throw Object.assign(new Error('write failed'), {
        code: 28,
        errmsg: "Plan executor error during update :: caused by :: Cannot create field 'x' in element {meta: null}",
      });
    };

    await assert.rejects(
      () => update(model, { path: 'tags', value: 'a' }),
      (err) => err.status === 400 && err.message === "Update can't be applied: Cannot create field 'x' in element {meta: null}",
    );
  });
});

describe('datastore/adapters/MongodbAdapter:mergeUpdateOps', () => {
  it('merges operations on separate paths into one update document', () => {
    assert.deepStrictEqual(mergeUpdateOps([{ $set: { a: 1 } }, { $push: { b: 2 } }, { $set: { 'c.d': 3 } }]), {
      $set: { a: 1, 'c.d': 3 },
      $push: { b: 2 },
    });
  });

  it('cannot merge operations on the same path, or on a path and one inside it', () => {
    assert.strictEqual(mergeUpdateOps([{ $push: { tags: 'a' } }, { $push: { tags: 'b' } }]), null);
    assert.strictEqual(mergeUpdateOps([{ $set: { meta: null } }, { $set: { 'meta.x': 1 } }]), null);
    assert.strictEqual(mergeUpdateOps([{ $unset: { 'tags.1': null } }, { $pull: { tags: null } }]), null);
  });
});

describe('datastore/adapters/MongodbAdapter:applyUpdateOps', () => {
  const apply = (doc, ops) => {
    applyUpdateOps(doc, ops);
    return doc;
  };
  const refusal = (doc, ops) => {
    try {
      applyUpdateOps(doc, ops);
    } catch (err) {
      return [err.status, err.message];
    }
    return null;
  };

  it('sets a field, creating the documents on its way', () => {
    assert.deepStrictEqual(apply({}, [{ $set: { 'a.b.c': 1 } }]), { a: { b: { c: 1 } } });
  });

  it('sets an array element by index, padding with null past the end', () => {
    assert.deepStrictEqual(apply({ tags: ['a'] }, [{ $set: { 'tags.2': 'c' } }]), { tags: ['a', null, 'c'] });
  });

  it('pushes onto an array, creating it when missing', () => {
    assert.deepStrictEqual(apply({ tags: ['a'] }, [{ $push: { tags: 'b' } }, { $push: { other: 1 } }]), {
      tags: ['a', 'b'],
      other: [1],
    });
  });

  it('increments a number, setting it when missing', () => {
    assert.deepStrictEqual(apply({ n: 1 }, [{ $inc: { n: 2 } }, { $inc: { m: 3 } }]), { n: 3, m: 3 });
  });

  it('removes an array element the way $unset then $pull does', () => {
    assert.deepStrictEqual(apply({ tags: ['a', 'b', 'c'] }, [{ $unset: { 'tags.1': null } }, { $pull: { tags: null } }]), {
      tags: ['a', 'c'],
    });
  });

  it('applies operations in order', () => {
    assert.deepStrictEqual(apply({ meta: { x: 1 } }, [{ $set: { meta: null } }, { $set: { meta: { y: 2 } } }]), {
      meta: { y: 2 },
    });
  });

  it("refuses what Mongo refuses, in Mongo's words", () => {
    assert.deepStrictEqual(refusal({ meta: null }, [{ $set: { 'meta.x': 1 } }]), [
      400,
      "Update can't be applied: Cannot create field 'x' in element {meta: null}",
    ]);
    assert.deepStrictEqual(refusal({ tags: 'x' }, [{ $push: { tags: 1 } }]), [
      400,
      "Update can't be applied: The field 'tags' must be an array but is of type string",
    ]);
    assert.deepStrictEqual(refusal({ n: 's' }, [{ $inc: { n: 1 } }]), [
      400,
      "Update can't be applied: Cannot apply $inc to a value of non-numeric type",
    ]);
    assert.deepStrictEqual(refusal({ tags: ['a'] }, [{ $set: { 'tags.x': 1 } }]), [
      400,
      "Update can't be applied: Cannot create field 'x' in element {tags: [\"a\"]}",
    ]);
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

describe('datastore/adapters/MongodbAdapter:findStoredIds', () => {
  function createAdapter(storedIds) {
    const queries = [];
    const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
    adapter.collection = {
      namespace: 'test.organisation',
      find: (query, options) => {
        queries.push({ query, options });
        const wanted = query._id.$in.map((id) => id.toString());
        return { toArray: async () => storedIds.filter((id) => wanted.includes(id)).map((id) => ({ _id: new ObjectId(id) })) };
      },
    };
    return { adapter, queries };
  }

  it('gives the ids of those given that are stored, in one query', async () => {
    const { adapter, queries } = createAdapter([ID]);

    const stored = await adapter.findStoredIds([ID.toUpperCase(), '507f1f77bcf86cd799439012']);

    assert.deepStrictEqual(stored, [ID]);
    assert.strictEqual(queries.length, 1);
    assert.deepStrictEqual(queries[0].options, { projection: { _id: 1 } });
  });

  it('ignores an id that cannot be stored, and does not query for none', async () => {
    const { adapter, queries } = createAdapter([ID]);

    assert.deepStrictEqual(await adapter.findStoredIds(['abc']), []);
    assert.deepStrictEqual(await adapter.findStoredIds([]), []);
    assert.strictEqual(queries.length, 0);
  });
});

describe('datastore/adapters/MongodbAdapter:add when the insert fails part way', () => {
  const IDS = ['6ab000000000000000000001', '6ab000000000000000000002', '6ab000000000000000000003'];

  // An ordered insert stops at the document it can't write, with the documents before it written.
  function createAdapter(error) {
    const deletes = [];
    const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
    adapter.collection = {
      namespace: 'test.organisation',
      bulkWrite: async () => {
        throw error;
      },
      deleteMany: async (query) => {
        deletes.push(query);
        return { deletedCount: query._id.$in.length };
      },
    };
    return { adapter, deletes };
  }
  const writeError = (index, code) =>
    Object.assign(new Error('write failed'), { code, writeErrors: [{ index, code, errmsg: 'write failed' }] });
  const add = (adapter) => adapter.add(IDS.map((id, idx) => ({ id, name: `n${idx}` })), (item) => ({ ...item }));

  it('removes the entities written before a reused id, and reports the id and its index', async () => {
    const { adapter, deletes } = createAdapter(writeError(2, 11000));

    await assert.rejects(add(adapter), (err) => {
      assert.strictEqual(err.name, 'DuplicateIdError');
      assert.strictEqual(err.index, 2);
      assert.strictEqual(err.id, IDS[2]);
      return true;
    });
    assert.deepStrictEqual(
      deletes.map((query) => query._id.$in.map(String)),
      [IDS.slice(0, 2)],
    );
  });

  it('removes the entities written before any other write error, and gives that error', async () => {
    const error = writeError(1, 2);
    const { adapter, deletes } = createAdapter(error);

    await assert.rejects(add(adapter), (err) => err === error);
    assert.deepStrictEqual(
      deletes.map((query) => query._id.$in.map(String)),
      [IDS.slice(0, 1)],
    );
  });

  it('removes nothing when the first entity fails, or when it is not known what was written', async () => {
    const first = createAdapter(writeError(0, 11000));
    await assert.rejects(add(first.adapter), (err) => err.name === 'DuplicateIdError' && err.index === 0);
    assert.deepStrictEqual(first.deletes, []);

    const error = new Error('connection lost');
    const unknown = createAdapter(error);
    await assert.rejects(add(unknown.adapter), (err) => err === error);
    assert.deepStrictEqual(unknown.deletes, []);
  });
});

describe('datastore/adapters/MongodbAdapter: exists', () => {
  const APP_ID = '507f1f77bcf86cd799439099';

  // An adapter for a schema with an id property, whose collection records the filter of each count
  function createAdapter() {
    const filters = [];
    const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
    adapter.collection = {
      namespace: 'test.shares',
      countDocuments: async (filter) => {
        filters.push(filter);
        return 1;
      },
    };
    adapter.updateSchema({ name: 'share', type: 'collection', properties: { _appId: { __type: 'id' } } });
    return { adapter, filters };
  }

  it('converts the id properties of the extra filter, as it does the id', async () => {
    const { adapter, filters } = createAdapter();

    assert.strictEqual(await adapter.exists(ID, { _appId: APP_ID }), true);

    const [filter] = filters;
    assert(isObjectId(filter._id) && filter._id.toHexString() === ID);
    assert(isObjectId(filter._appId) && filter._appId.toHexString() === APP_ID);
  });

  it('converts an extra filter given with operators', async () => {
    const { adapter, filters } = createAdapter();

    await adapter.exists(ID, { _appId: { $in: [APP_ID] } });

    const [filter] = filters;
    assert(isObjectId(filter._appId.$in[0]) && filter._appId.$in[0].toHexString() === APP_ID);
  });

  it('gives false for an invalid id without counting', async () => {
    const { adapter, filters } = createAdapter();

    assert.strictEqual(await adapter.exists('not-an-id', { _appId: APP_ID }), false);
    assert.deepStrictEqual(filters, []);
  });
});

describe('datastore/adapters/mongodb:findById', () => {
  const adapterWith = (stored) => {
    const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
    adapter.collection = { findOne: async (query) => (stored && query._id.toHexString() === ID ? { _id: new ObjectId(ID), name: 'x' } : null) };
    return adapter;
  };

  it('resolves to the entity with that id', async () => {
    assert.strictEqual((await adapterWith(true).findById(ID)).name, 'x');
  });

  it("resolves to null for an id with no entity, or one that isn't an id, for the caller to answer as not found", async () => {
    assert.strictEqual(await adapterWith(false).findById(ID), null);
    assert.strictEqual(await adapterWith(true).findById('not-an-id'), null);
  });
});

// A property with __unique has a unique index, built when the model starts; a write that breaks it is refused (D-25)
describe('datastore/adapters/MongodbAdapter: unique properties', () => {
  const schema = {
    name: 'crate',
    type: 'collection',
    properties: {
      code: { __type: 'string', __default: null, __unique: true },
      ownerId: { __type: 'id', __default: null, __unique: true },
      meta: { serial: { __type: 'number', __default: null, __unique: true } },
      label: { __type: 'string', __default: null },
      items: { __type: 'array', __schema: { sku: { __type: 'string', __unique: true } } },
    },
  };
  const createAdapter = (createIndex) => {
    const adapter = new MongodbAdapter(new URL('mongodb://localhost/test'), {});
    adapter.collection = { createIndex };
    return adapter;
  };

  it('builds a unique index for each, of the values of its type, leaving out array item properties', async () => {
    const built = [];
    await createAdapter(async (keys, options) => built.push([keys, options])).updateSchema(schema);

    assert.deepStrictEqual(built, [
      [{ code: 1 }, { unique: true, name: 'unique_code', partialFilterExpression: { code: { $type: 'string' } } }],
      [{ ownerId: 1 }, { unique: true, name: 'unique_ownerId', partialFilterExpression: { ownerId: { $type: 'objectId' } } }],
      [{ 'meta.serial': 1 }, { unique: true, name: 'unique_meta.serial', partialFilterExpression: { 'meta.serial': { $type: 'number' } } }],
    ]);
  });

  it('carries on without an index it can not build, as when stored values already repeat', async () => {
    let calls = 0;
    await createAdapter(async () => {
      calls++;
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    }).updateSchema(schema);

    assert.strictEqual(calls, 3);
  });

  it('refuses a write that repeats a unique value with 400 duplicate, naming the property', async () => {
    const adapter = createAdapter(async () => {});
    const duplicate = Object.assign(new Error('E11000 duplicate key error collection: test.crates index: unique_code dup key: { code: "a" }'), {
      code: 11000,
      errmsg: 'E11000 duplicate key error collection: test.crates index: unique_code dup key: { code: "a" }',
    });

    await assert.rejects(() => adapter._write(async () => { throw duplicate; }), {
      status: 400,
      code: 'duplicate',
      details: { path: 'code' },
    });
    const refused = await adapter._undoFailedAdd({ writeErrors: [{ index: 0, code: 11000, errmsg: duplicate.errmsg }] }, [{ _id: new ObjectId(ID) }]);
    assert.strictEqual(refused.status, 400);
    assert.deepStrictEqual(refused.details, { path: 'code' });
  });
});

describe('datastore/adapters/MongodbAdapter: connect', () => {
  // The client MongoClient.connect makes from what it's given, without connecting to anything
  let client;
  beforeEach(() => {
    sinon.stub(MongoClient, 'connect').callsFake(async (url, options) => (client = new MongoClient(url, options)));
  });
  afterEach(() => {
    sinon.restore();
    IOStats.disable();
  });

  // As each process makes its primary datastore from Config.datastore
  const connect = (connectionString, options) => new Datastore({ connectionString, options }).connect();

  it('applies the datastore options (BUTTRESS_DATASTORE_OPTIONS) to the client, on the named database', async () => {
    const db = await connect('mongodb://localhost:27017/buttress', 'appName=bjs&maxPoolSize=10&replicaSet=rs0&tls=true');

    assert.strictEqual(client.options.appName, 'bjs');
    assert.strictEqual(client.options.maxPoolSize, 10);
    assert.strictEqual(client.options.replicaSet, 'rs0');
    assert.strictEqual(client.options.tls, true);
    assert.strictEqual(db.databaseName, 'buttress');
  });

  it('keeps the value of an option the connection string sets too, as the driver refuses one given twice', async () => {
    await connect('mongodb://localhost:27017/buttress?maxPoolSize=5', 'appName=bjs&maxPoolSize=10');

    assert.strictEqual(client.options.maxPoolSize, 5);
    assert.strictEqual(client.options.appName, 'bjs');
  });

  it('keeps command monitoring on while I/O is counted', async () => {
    IOStats.enable();

    await connect('mongodb://localhost:27017/buttress', 'maxPoolSize=10');

    assert.strictEqual(client.options.monitorCommands, true);
    assert.strictEqual(client.options.maxPoolSize, 10);
  });
});
