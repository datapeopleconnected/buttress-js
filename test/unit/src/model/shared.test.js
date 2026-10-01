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

import { validateSchemaObject, validateUpdate } from '../../../../dist/model/shared.js';

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
      const validate = validateUpdate({}, schema(core));

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
  const validate = validateUpdate(
    {},
    {
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
    },
  );
  const accepts = (path, value) => {
    const { validation, body } = validate({ path, value });
    assert.strictEqual(validation.isValid, true, `refused ${path}`);
    return body[0].contextPath;
  };
  const refuses = (path, value) => {
    const { validation } = validate({ path, value });
    assert.strictEqual(validation.isValid, false, `accepted ${path}`);
    assert.strictEqual(validation.isPathValid, false, `${path} was refused for its value, not its path`);
  };

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
    assert.strictEqual(accepts('owner.name', 'x'), '^owner$');
    assert.strictEqual(accepts('meta.a.b', 1), '^meta$');
  });

  it('refuses a path that is not a declared property, or an update operation beneath an object property', () => {
    refuses('datastore.connectionString', 'mongodb://example.com');
    refuses('datastore.other', 'x');
    refuses('owner.__remove__', 'x');
    refuses('owner.', 'x');
  });

  it('still takes the declared paths', () => {
    assert.strictEqual(accepts('owner', { name: 'x' }), '^owner$');
    assert.strictEqual(accepts('datastore.name', 'x'), '^datastore\\.name$');
    assert.strictEqual(accepts('specification.env', 'x'), '^specification\\.env$');
    assert.strictEqual(accepts('a+b', 'x'), '^a\\+b$');
  });
});

describe('model/shared:validateUpdate paths beneath a typed object', () => {
  const validate = validateUpdate({}, {
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

      const { validation, body: updates } = validateUpdate({}, flags)({ path: 'on', value: given });
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

      const { validation } = validateUpdate({}, flags)({ path, value: given });
      assert.strictEqual(validation.isValid, false);
      assert.strictEqual(validation.isValueValid, false);
    });
  }

  it('takes a uuid in its usual form', () => {
    assert.strictEqual(validateSchemaObject(flags, { ref: UUID }).isValid, true);
  });
});
