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

import { invalidEntityError, sanitizeSchemaObject, validateSchemaObject } from '../../../../dist/model/shared.js';
import { createSchemaModel } from '../../../schema-model.js';

// What a create checks a body for, and what it then stores: the route validates the body, and the model stores what
// sanitizing it gives
const schema = (properties) => ({ name: 'crate', type: 'collection', properties });
const check = (properties, body) => {
  const { isValid, issues, missing, invalid } = validateSchemaObject(schema(properties), body);
  return { isValid, issues, missing, invalid };
};
const stored = (properties, body) => sanitizeSchemaObject(schema(properties), body);
const valid = { isValid: true, issues: [], missing: [], invalid: [] };

const ID = /^[0-9a-f]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('model/shared: creating an entity', () => {
  describe('values', () => {
    const properties = {
      done: { __type: 'boolean' },
      weight: { __type: 'number' },
      label: { __type: 'string' },
      at: { __type: 'date' },
      owner: { __type: 'id' },
    };
    const body = () => ({ done: 'yes', weight: '1.5', label: 5, at: '2020-01-01T00:00:00.000Z', owner: '507f1f77bcf86cd799439011' });

    it('reads each value as its type', () => {
      assert.deepStrictEqual(check(properties, body()), valid);
      assert.deepStrictEqual(stored(properties, body()), {
        done: true,
        weight: 1.5,
        label: '5',
        at: new Date('2020-01-01T00:00:00.000Z'),
        owner: '507f1f77bcf86cd799439011',
      });
    });

    it('keeps only the fields the schema defines, and none starting with _', () => {
      const result = stored({ label: { __type: 'string' } }, { label: 'a', _secret: 1, extra: 2, source: 's' });

      assert.deepStrictEqual(result, { label: 'a' });
    });

    it('never stores a top-level source, though one is checked', () => {
      const properties = { source: { __type: 'number', __default: 0 }, label: { __type: 'string' } };

      assert.deepStrictEqual(stored(properties, { source: 1, label: 'a' }), { label: 'a' });
      assert.strictEqual(check(properties, { source: 'x', label: 'a' }).isValid, false);
    });

    it('keeps everything beneath an object property, _ keys included', () => {
      const result = stored({ meta: { __type: 'object', __default: null } }, { meta: { _x: 1, a: { b: 2 } } });

      assert.deepStrictEqual(result, { meta: { _x: 1, a: { b: 2 } } });
    });

    it('takes null as no value, even for a required property', () => {
      const properties = { label: { __type: 'string', __required: true }, weight: { __type: 'number' } };

      assert.deepStrictEqual(check(properties, { label: null, weight: null }), valid);
      assert.deepStrictEqual(stored(properties, { label: null, weight: null }), { label: null, weight: null });
    });
  });

  describe('defaults', () => {
    it("gives a missing value its type's default, or its own", () => {
      const properties = {
        weight: { __type: 'number' },
        done: { __type: 'boolean' },
        owner: { __type: 'id' },
        ref: { __type: 'uuid' },
        meta: { __type: 'object' },
        tags: { __type: 'array' },
        colour: { __type: 'string', __default: 'red' },
        size: { __type: 'number', __default: '3' },
        opened: { __type: 'date', __default: null },
      };

      assert.deepStrictEqual(check(properties, {}), valid);
      assert.deepStrictEqual(stored(properties, {}), {
        weight: 0,
        done: false,
        owner: null,
        ref: null,
        meta: {},
        tags: [],
        colour: 'red',
        size: 3,
        opened: null,
      });
    });

    it('generates the defaults that are made new for each entity', () => {
      const properties = {
        key: { __type: 'id', __default: 'new' },
        ref: { __type: 'uuid', __default: 'new' },
        secret: { __type: 'string', __default: 'randomString' },
        at: { __type: 'date' },
      };
      const before = Date.now();
      const result = stored(properties, {});

      assert.match(result.key, ID);
      assert.match(result.ref, UUID);
      assert.match(result.secret, /^[A-Za-z0-9=]{36}$/);
      assert(result.at instanceof Date && result.at.getTime() >= before);
    });

    it("refuses a missing value whose default isn't of its type", () => {
      const result = check({ weight: { __type: 'number', __default: 'heavy' } }, {});

      assert.deepStrictEqual(result.issues, [{ path: 'weight', code: 'type', expected: 'number', received: 'string' }]);
      assert.deepStrictEqual(result.invalid, ['weight:heavy[string]']);
    });

    it('refuses a missing required property that has no default', () => {
      const result = check({ label: { __type: 'string', __required: true }, other: { __type: 'number' } }, {});

      assert.deepStrictEqual(result, {
        isValid: false,
        issues: [{ path: 'label', code: 'required' }],
        missing: ['label'],
        invalid: [],
      });
    });

    it('takes a missing required property that has a default', () => {
      assert.deepStrictEqual(check({ label: { __type: 'string', __required: true, __default: 'x' } }, {}), valid);
    });

    // The docs: `__required` "fails validation if the property is missing and has no default"
    it("takes a missing string that isn't required, whether or not it has an __enum", () => {
      const properties = {
        label: { __type: 'string' },
        colour: { __type: 'string', __enum: ['red', 'blue'] },
        weight: { __type: 'number', __default: 1 },
      };

      assert.deepStrictEqual(check(properties, {}), valid);
      assert.deepStrictEqual(stored(properties, {}), { label: undefined, colour: undefined, weight: 1 });
    });

    it('generates a default that is given as its own value, at any depth, without changing the body', () => {
      const properties = {
        key: { __type: 'id', __default: 'new' },
        git: { ref: { __type: 'uuid', __default: 'new' } },
        lines: { __type: 'array', __schema: { secret: { __type: 'string', __default: 'randomString' } } },
      };
      const body = { key: 'new', git: { ref: 'new' }, lines: [{ secret: 'randomString' }] };
      const given = structuredClone(body);

      assert.deepStrictEqual(check(properties, body), valid);
      assert.deepStrictEqual(body, given);

      const result = stored(properties, body);
      assert.match(result.key, ID);
      assert.match(result.git.ref, UUID);
      assert.match(result.lines[0].secret, /^[A-Za-z0-9=]{36}$/);
      assert.deepStrictEqual(body, given);
    });
  });

  describe('objects', () => {
    const properties = {
      git: {
        url: { __type: 'string', __required: true },
        branch: { __type: 'string', __default: 'main' },
      },
    };

    it("keeps a nested object's own properties only", () => {
      assert.deepStrictEqual(stored(properties, { git: { url: 'u', other: 1 } }), { git: { url: 'u', branch: 'main' } });
    });

    it("checks a nested object's properties at their full path", () => {
      const result = check(properties, { git: {} });

      assert.deepStrictEqual(result.issues, [{ path: 'git.url', code: 'required' }]);
      assert.deepStrictEqual(result.missing, ['git.url']);
    });

    it("gives a nested object that's null its properties' defaults", () => {
      const properties = { git: { branch: { __type: 'string', __default: 'main' } } };

      assert.deepStrictEqual(check(properties, { git: null }), valid);
      assert.deepStrictEqual(stored(properties, { git: null }), { git: { branch: 'main' } });
    });

    it("refuses a nested object that isn't one", () => {
      const properties = { git: { branch: { __type: 'string', __default: 'main' } } };

      for (const [given, type] of [['x', 'string'], [[1], 'array'], [3, 'number']]) {
        const result = check(properties, { git: given });
        assert.deepStrictEqual(result.issues, [{ path: 'git', code: 'type', expected: 'object', received: type }]);
        assert.deepStrictEqual(result.invalid, [`git:${given}[${typeof given}]`]);
      }
    });

    it('stores an empty object given for an object property as it is', () => {
      const result = stored({ meta: { __type: 'object', __default: null } }, { meta: {} });

      assert.deepStrictEqual(result, { meta: {} });
    });

    it("refuses an object property's value that isn't an object", () => {
      const result = check({ meta: { __type: 'object', __default: null } }, { meta: 's' });

      assert.deepStrictEqual(result.issues, [{ path: 'meta', code: 'type', expected: 'object', received: 'string' }]);
    });
  });

  describe('arrays of items with a __schema', () => {
    const properties = {
      lines: {
        __type: 'array',
        __schema: {
          sku: { __type: 'string', __required: true },
          qty: { __type: 'number' },
          size: { width: { __type: 'number', __default: 1 } },
        },
      },
    };

    it("reads each item through the item schema, keeping only the item's own properties", () => {
      const body = { lines: [{ sku: 'a', qty: '2', extra: 1, source: 's' }, { sku: 'b', size: { width: '4' } }] };

      assert.deepStrictEqual(check(properties, body), valid);
      assert.deepStrictEqual(stored(properties, body), {
        lines: [
          { sku: 'a', qty: 2, size: { width: 1 } },
          { sku: 'b', qty: 0, size: { width: 4 } },
        ],
      });
    });

    it('refuses each item that is wrong, at its index', () => {
      const result = check(properties, { lines: [{ sku: 'a', qty: 'lots' }, {}, 3, null] });

      assert.deepStrictEqual(result, {
        isValid: false,
        issues: [
          { path: 'lines.0.qty', code: 'type', expected: 'number', received: 'string' },
          { path: 'lines.1.sku', code: 'required' },
          { path: 'lines.2', code: 'type', expected: 'object', received: 'number' },
          { path: 'lines.3', code: 'type', expected: 'object', received: 'null' },
        ],
        missing: ['lines.1.sku'],
        invalid: ['lines.0.qty:lots[string]', 'lines.2:3[number] [object]', 'lines.3:null[null] [object]'],
      });
    });

    it('reads arrays of items within items', () => {
      const properties = {
        boxes: { __type: 'array', __schema: { lines: { __type: 'array', __schema: { qty: { __type: 'number', __default: 1 } } } } },
      };

      assert.deepStrictEqual(stored(properties, { boxes: [{ lines: [{ qty: '5' }, {}] }, {}] }), {
        boxes: [{ lines: [{ qty: 5 }, { qty: 1 }] }, { lines: [] }],
      });
    });

    it('stores an array that is missing as empty', () => {
      assert.deepStrictEqual(stored(properties, {}), { lines: [] });
    });

    it('takes null as no items', () => {
      assert.deepStrictEqual(check(properties, { lines: null }), valid);
      assert.deepStrictEqual(stored(properties, { lines: null }), { lines: [] });
    });

    it('stores an array that is within a nested object', () => {
      const properties = {
        order: { lines: { __type: 'array', __schema: { sku: { __type: 'string', __default: 'z' } } }, total: { __type: 'number' } },
      };

      assert.deepStrictEqual(check(properties, { order: { lines: [{}], total: '3' } }), valid);
      assert.deepStrictEqual(stored(properties, { order: { lines: [{}], total: '3' } }), {
        order: { lines: [{ sku: 'z' }], total: 3 },
      });
    });

    it("gives an array that is missing its __default, read through the item schema", () => {
      const properties = {
        lines: { __type: 'array', __default: [{ qty: '2' }], __schema: { qty: { __type: 'number' }, sku: { __type: 'string', __default: 'z' } } },
      };

      assert.deepStrictEqual(check(properties, {}), valid);
      assert.deepStrictEqual(stored(properties, {}), { lines: [{ qty: 2, sku: 'z' }] });
    });
  });

  describe('arrays with an __itemtype', () => {
    const properties = { counts: { __type: 'array', __itemtype: 'number' } };

    it('reads each item as the item type', () => {
      assert.deepStrictEqual(check(properties, { counts: [3, '4'] }), valid);
      assert.deepStrictEqual(stored(properties, { counts: [3, '4'] }), { counts: [3, 4] });
    });

    it('reads each item as the item type within a nested object', () => {
      assert.deepStrictEqual(stored({ box: { counts: properties.counts } }, { box: { counts: ['1'] } }), {
        box: { counts: [1] },
      });
    });

    it('refuses an item that is not of the item type, or null', () => {
      assert.deepStrictEqual(check(properties, { counts: [3, 'x', null] }), {
        isValid: false,
        issues: [
          { path: 'counts.1', code: 'type', expected: 'number', received: 'string' },
          { path: 'counts.2', code: 'type', expected: 'number', received: 'null' },
        ],
        missing: [],
        invalid: ['counts.1:x[string] [number]', 'counts.2:null[null] [number]'],
      });
    });

    it('refuses a value that is not a list', () => {
      const result = check(properties, { counts: 5 });

      assert.deepStrictEqual(result.issues, [{ path: 'counts', code: 'type', expected: 'array', received: 'number' }]);
    });
  });

  it('lists the problems in the order of the schema', () => {
    const properties = {
      label: { __type: 'string', __required: true },
      colour: { __type: 'string', __enum: ['red', 'blue'], __default: 'red' },
      git: { url: { __type: 'string', __required: true } },
      counts: { __type: 'array', __itemtype: 'number' },
    };
    const result = check(properties, { colour: 'green', counts: ['x'] });

    assert.deepStrictEqual(result.issues, [
      { path: 'label', code: 'required' },
      { path: 'colour', code: 'enum', expected: ['red', 'blue'], received: 'string' },
      { path: 'git.url', code: 'required' },
      { path: 'counts.0', code: 'type', expected: 'number', received: 'string' },
    ]);

    const err = invalidEntityError('crate', validateSchemaObject(schema(properties), { colour: 'green', counts: ['x'] }));
    assert.strictEqual(err.message, 'crate: Missing field: label');
  });

  it("stores a new id for an entity given its id's 'new' default", async () => {
    const { model, datastore } = createSchemaModel({ name: 'crate', properties: { label: { __type: 'string' } } });
    await model.add({ id: 'new', label: 'a' });

    assert.strictEqual(datastore.rows.length, 1);
    assert.match(datastore.rows[0].id, ID);
    assert.strictEqual(datastore.rows[0].label, 'a');
  });
});
