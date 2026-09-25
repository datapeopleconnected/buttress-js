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
