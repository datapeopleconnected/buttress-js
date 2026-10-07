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

import {
  invalidEntityError,
  invalidUpdateError,
  sanitizeSchemaObject,
  validateSchemaObject,
  validateUpdate,
} from '../../../../dist/model/shared.js';
import { resolveUpdatePath } from '../../../../dist/model/update-paths.js';
import { getFlattenedSchema } from '../../../../dist/helpers/index.js';

// Validation adds its own context to each update
const pathsAndValues = (body) => body.map(({ path, value }) => ({ path, value }));

const schema = (core) => ({
  name: 'thing',
  type: 'collection',
  core,
  properties: { priority: { __type: 'number', __allowUpdate: true } },
});

describe('model/shared:validateUpdate', () => {
  for (const core of [true, false]) {
    describe(core ? 'on a core schema' : 'on an app schema', () => {
      const validate = validateUpdate(schema(core));

      it('takes a single update', () => {
        const { validation, body } = validate({ path: 'priority', value: 1 });

        assert.strictEqual(validation.isValid, true);
        assert.deepStrictEqual(pathsAndValues(body), [{ path: 'priority', value: 1 }]);
      });

      it('takes an array of updates', () => {
        const { validation, body } = validate([{ path: 'priority', value: 1 }]);

        assert.strictEqual(validation.isValid, true);
        assert.deepStrictEqual(pathsAndValues(body), [{ path: 'priority', value: 1 }]);
      });

      for (const [label, update] of [
        ['no body', undefined],
        ['an empty object', {}],
        ['a null item', [null]],
        ['a string item', ['priority']],
      ]) {
        it(`reports ${label} as an update missing its path`, () => {
          const { validation } = validate(update);

          assert.strictEqual(validation.isValid, false);
          assert.strictEqual(validation.missingRequired, 'path');
        });
      }
    });
  }
});

describe('model/shared:validateUpdate paths', () => {
  const HEX_ID = '5f0000000000000000000000';
  const thing = {
      name: 'thing',
      type: 'collection',
      properties: {
        owner: { __type: 'object', __allowUpdate: true },
        ownerId: { __type: 'id', __allowUpdate: false },
        meta: { __type: 'object', __allowUpdate: true },
        isAdmin: { __type: 'boolean', __allowUpdate: false },
        datastore: {
          connectionString: { __type: 'string', __allowUpdate: false },
          name: { __type: 'string', __allowUpdate: true },
        },
        specification: { env: { __type: 'string', __allowUpdate: true } },
        'a+b': { __type: 'string', __allowUpdate: true },
      },
    };
  const validate = validateUpdate(thing);
  const flat = getFlattenedSchema(thing);
  // The property the path writes to
  const accepts = (path, value) => {
    const { validation, body } = validate({ path, value });
    assert.strictEqual(validation.isValid, true, `refused ${path}`);
    return resolveUpdatePath(flat, body[0].path).property;
  };
  const refuses = (path, value) => {
    const { validation } = validate({ path, value });
    assert.strictEqual(validation.isValid, false, `accepted ${path}`);
    assert.strictEqual(validation.isPathValid, false, `${path} was refused for its value, not its path`);
  };

  it('says a property that does not allow updates is immutable', () => {
    assert.deepStrictEqual(validate({ path: 'ownerId', value: HEX_ID }).validation.issues, [
      { path: 'ownerId', code: 'immutable' },
    ]);
  });

  it('refuses a property that does not allow updates, even when its name contains an object property', () => {
    refuses('ownerId', HEX_ID);
    refuses('isAdminmeta', true);
    refuses('xmetax', 'x');
  });

  it('refuses a path that only matches a property name as a regular expression would', () => {
    refuses('specification_env', 'x');
    refuses('aab', 'x');
  });

  it('takes a path beneath an object property that declares no properties', () => {
    assert.strictEqual(accepts('owner.name', 'x'), 'owner');
    assert.strictEqual(accepts('meta.a.b', 1), 'meta');
  });

  it('refuses a path that is not a declared property, or an update operation beneath an object property', () => {
    refuses('datastore.connectionString', 'mongodb://example.com');
    refuses('datastore.other', 'x');
    refuses('owner.__remove__', 'x');
    refuses('owner.', 'x');
  });

  it('still takes the declared paths', () => {
    assert.strictEqual(accepts('owner', { name: 'x' }), 'owner');
    assert.strictEqual(accepts('datastore.name', 'x'), 'datastore.name');
    assert.strictEqual(accepts('specification.env', 'x'), 'specification.env');
    assert.strictEqual(accepts('a+b', 'x'), 'a+b');
  });
});

describe('model/shared:validateUpdate paths beneath a typed object', () => {
  const validate = validateUpdate({
    name: 'thing',
    type: 'collection',
    properties: { meta: { __type: 'object', __default: {}, __allowUpdate: true } },
  });

  it('takes a path whose names contain "remove", which is only an update operation as __remove__', () => {
    for (const path of ['meta.removeMe', 'meta.remover.x']) {
      assert.deepStrictEqual(validate([{ path, value: 1 }]).validation, { isValid: true }, path);
    }
  });
});

// Bodies and updates convert values through the same codecs (D-2)
describe('model/shared: values converted as the schema types them', () => {
  const flags = {
    name: 'flag',
    type: 'collection',
    properties: {
      on: { __type: 'boolean', __default: false, __allowUpdate: true },
      ref: { __type: 'uuid', __default: null, __allowUpdate: true },
    },
  };
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

  for (const [given, stored] of [
    ['yes', true],
    ['no', false],
    ['1', true],
    [0, false],
  ]) {
    it(`takes ${JSON.stringify(given)} as ${stored} in a body and in an update`, () => {
      const body = { on: given };
      assert.strictEqual(validateSchemaObject(flags, body).isValid, true);

      const { validation, body: updates } = validateUpdate(flags)({ path: 'on', value: given });
      assert.strictEqual(validation.isValid, true);
      assert.strictEqual(updates[0].value, stored);
    });
  }

  for (const [path, given] of [
    ['on', 'banana'],
    ['on', 2],
    ['ref', 'not-a-uuid'],
  ]) {
    it(`refuses ${JSON.stringify(given)} for ${path} in a body and in an update`, () => {
      const created = validateSchemaObject(flags, { [path]: given });
      assert.strictEqual(created.isValid, false);
      assert.strictEqual(created.invalid.length, 1);

      const { validation } = validateUpdate(flags)({ path, value: given });
      assert.strictEqual(validation.isValid, false);
      assert.strictEqual(validation.isValueValid, false);
    });
  }

  it('takes a uuid in its usual form', () => {
    assert.strictEqual(validateSchemaObject(flags, { ref: UUID }).isValid, true);
  });
});

// An item an update writes to an array with an item __schema is the item a create would store (SR-DPC-001 D2)
describe('model/shared: array items an update writes', () => {
  const REF = '507f1f77bcf86cd799439011';
  const logbook = {
    name: 'logbook',
    type: 'collection',
    properties: {
      entries: {
        __type: 'array',
        __allowUpdate: true,
        __schema: {
          at: { __type: 'date', __default: null, __allowUpdate: true },
          count: { __type: 'number', __default: 0, __allowUpdate: true },
          ref: { __type: 'id', __default: null, __allowUpdate: true },
          note: { __type: 'string', __default: 'none', __allowUpdate: true },
          _secret: { __type: 'string', __default: 'server', __allowUpdate: true },
          parts: {
            __type: 'array',
            __allowUpdate: true,
            __schema: { qty: { __type: 'number', __default: 1, __allowUpdate: true } },
          },
        },
      },
    },
  };
  const given = () => ({ at: '2026-01-02T03:04:05.000Z', count: '7', ref: REF, _secret: 'client', extra: 'x' });
  const stored = { at: new Date('2026-01-02T03:04:05.000Z'), count: 7, ref: REF, note: 'none', _secret: 'server', parts: [] };
  const validate = validateUpdate(logbook);

  const valuesOf = (body) => {
    const { validation, body: updates } = validate(body);
    assert.strictEqual(validation.isValid, true);
    return updates.map((update) => update.value);
  };

  it('stores the item a create would, for the same item', () => {
    assert.deepStrictEqual(sanitizeSchemaObject(logbook, { entries: [given()] }).entries, [stored]);
  });

  it('pushes one item as it is stored: values as their types, defaults, no unknown or _ fields', () => {
    assert.deepStrictEqual(valuesOf({ path: 'entries', value: given() }), [stored]);
  });

  it('sets one item by its index as it is stored', () => {
    assert.deepStrictEqual(valuesOf({ path: 'entries.0', value: given() }), [stored]);
  });

  it('replaces the whole array with each item as it is stored', () => {
    assert.deepStrictEqual(valuesOf({ path: 'entries', value: [given(), {}] }), [
      [stored, { at: null, count: 0, ref: null, note: 'none', _secret: 'server', parts: [] }],
    ]);
  });

  it('reads each of a request\'s updates, as a bulk update item gives them', () => {
    assert.deepStrictEqual(
      valuesOf([
        { path: 'entries', value: given() },
        { path: 'entries.1', value: given() },
      ]),
      [stored, stored],
    );
  });

  it('reads an item of an array inside an item through its own item schema', () => {
    assert.deepStrictEqual(valuesOf({ path: 'entries.0.parts', value: { qty: '3', _x: 1, extra: 1 } }), [{ qty: 3 }]);
    assert.deepStrictEqual(valuesOf({ path: 'entries.0.parts.2', value: {} }), [{ qty: 1 }]);
  });

  it("replaces the update's value, leaving the item it was given as it was", () => {
    const item = given();
    const update = { path: 'entries', value: item };
    validate(update);
    assert.deepStrictEqual(update.value, stored);
    assert.deepStrictEqual(item, given());
  });
});

// Every problem with a body or an update is listed, as {path, code, expected?, received?}
describe('model/shared: validation issues', () => {
  const crate = {
    name: 'crate',
    type: 'collection',
    properties: {
      label: { __type: 'string', __required: true, __allowUpdate: true },
      colour: { __type: 'string', __enum: ['red', 'blue'], __default: null, __allowUpdate: true },
      weight: { __type: 'number', __default: 0, __allowUpdate: true },
      tags: { __type: 'array', __itemtype: 'string', __default: [], __allowUpdate: true },
      items: {
        __type: 'array',
        __allowUpdate: true,
        __schema: { sku: { __type: 'string', __required: true, __allowUpdate: true } },
      },
    },
  };

  it('lists every problem with a body', () => {
    const validation = validateSchemaObject(crate, {
      colour: 'green',
      weight: 'heavy',
      tags: ['a', null],
      items: [{ sku: 'x' }, {}, 'loose'],
    });

    assert.strictEqual(validation.isValid, false);
    assert.deepStrictEqual(
      validation.issues.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: 'colour', code: 'enum', expected: ['red', 'blue'], received: 'string' },
        { path: 'items.1.sku', code: 'required' },
        { path: 'items.2', code: 'type', expected: 'object', received: 'string' },
        { path: 'label', code: 'required' },
        { path: 'tags.1', code: 'type', expected: 'string', received: 'null' },
        { path: 'weight', code: 'type', expected: 'number', received: 'string' },
      ],
    );
  });

  it('lists every refused update of a request', () => {
    const { validation } = validateUpdate(crate)([
      { path: 'weight', value: 'heavy' },
      { path: 'colour', value: 'green' },
      { path: 'label', value: 'fine' },
      { path: 'nothing', value: 1 },
      { value: 1 },
    ]);

    assert.strictEqual(validation.isValid, false);
    assert.deepStrictEqual(validation.issues, [
      { path: 'weight', code: 'type', expected: 'number', received: 'string' },
      { path: 'colour', code: 'enum', expected: ['red', 'blue'], received: 'string' },
      { path: 'nothing', code: 'unknown_path' },
      { path: '', code: 'required', expected: 'path' },
    ]);
  });
});

describe('model/shared: validation errors', () => {
  const crate = {
    name: 'crate',
    type: 'collection',
    properties: {
      label: { __type: 'string', __required: true, __allowUpdate: true },
      weight: { __type: 'number', __default: 0, __allowUpdate: true },
    },
  };

  it("refuses a body with its first problem's code, listing every issue", () => {
    const err = invalidEntityError('crate', validateSchemaObject(crate, { weight: 'heavy' }), 2);

    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.code, 'missing_field');
    assert.strictEqual(err.message, 'crate: Missing field: label at index 2');
    assert.deepStrictEqual(err.details, {
      schema: 'crate',
      path: 'label',
      index: 2,
      issues: [
        { path: 'label', code: 'required' },
        { path: 'weight', code: 'type', expected: 'number', received: 'string' },
      ],
    });
  });

  it('refuses updates as invalid_update, listing every issue', () => {
    const { validation } = validateUpdate(crate)([{ path: 'weight', value: 'heavy' }, { path: 'nothing', value: 1 }]);
    const err = invalidUpdateError('crate', validation);

    assert.strictEqual(err.code, 'invalid_update');
    assert.deepStrictEqual(err.details, {
      schema: 'crate',
      issues: [
        { path: 'weight', code: 'type', expected: 'number', received: 'string' },
        { path: 'nothing', code: 'unknown_path' },
      ],
    });
  });
});

// A schema can refuse fields it doesn't define on create (D-3); others drop them
describe('model/shared: strict schemas', () => {
  const crate = (strict) => ({
    name: 'crate',
    type: 'collection',
    ...(strict ? { strict: true } : {}),
    properties: {
      label: { __type: 'string', __default: null, __allowUpdate: true },
      meta: { __type: 'object', __default: null, __allowUpdate: true },
      git: { url: { __type: 'string', __default: null, __allowUpdate: true } },
      items: {
        __type: 'array',
        __allowUpdate: true,
        __schema: { sku: { __type: 'string', __default: null, __allowUpdate: true } },
      },
    },
  });
  const body = () => ({
    id: '507f1f77bcf86cd799439011',
    sourceId: 'app-1',
    _internal: 1,
    label: 'a',
    meta: { anything: { goes: true } },
    git: { url: 'u', branch: 'b' },
    items: [{ sku: 'x', colour: 'red' }],
    extra: 1,
  });

  it('refuses each field it does not define, anywhere in the body', () => {
    const validation = validateSchemaObject(crate(true), body());

    assert.strictEqual(validation.isValid, false);
    assert.deepStrictEqual(validation.issues, [
      { path: 'git.branch', code: 'unknown_path' },
      { path: 'items.0.colour', code: 'unknown_path' },
      { path: 'extra', code: 'unknown_path' },
    ]);
  });

  it('refuses the body as unknown_path, naming the first such field', () => {
    const err = invalidEntityError('crate', validateSchemaObject(crate(true), { label: 'a', extra: 1 }));

    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.code, 'unknown_path');
    assert.strictEqual(err.message, 'crate: Unknown field: extra');
    assert.deepStrictEqual(err.details, { schema: 'crate', path: 'extra', issues: [{ path: 'extra', code: 'unknown_path' }] });
  });

  it('takes the same body, dropping what it does not define, when the schema is not strict', () => {
    assert.strictEqual(validateSchemaObject(crate(false), body()).isValid, true);
  });
});
