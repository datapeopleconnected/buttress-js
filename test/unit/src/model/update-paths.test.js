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

import { resolveUpdatePath } from '../../../../dist/model/update-paths.js';
import { getFlattenedSchema } from '../../../../dist/helpers/index.js';

// A fresh copy each time, so one flattening can't hide another's changes
const makeSchema = () => ({
  name: 'thing',
  type: 'collection',
  properties: {
    name: { __type: 'string', __allowUpdate: true },
    colour: { __type: 'string', __enum: ['red', 'blue'], __allowUpdate: true },
    count: { __type: 'number', __allowUpdate: true },
    on: { __type: 'boolean', __allowUpdate: true },
    due: { __type: 'date', __allowUpdate: true },
    meta: { __type: 'object', __allowUpdate: true },
    ownerId: { __type: 'id', __allowUpdate: false },
    datastore: {
      name: { __type: 'string', __allowUpdate: true },
      connectionString: { __type: 'string', __allowUpdate: false },
    },
    tags: { __type: 'array', __itemtype: 'string', __allowUpdate: true },
    notes: { __type: 'array', __allowUpdate: true },
    items: {
      __type: 'array',
      __allowUpdate: true,
      __schema: {
        sku: { __type: 'string', __allowUpdate: true },
        qty: { __type: 'number', __allowUpdate: true },
        locked: { __type: 'string', __allowUpdate: false },
        parts: { __type: 'array', __allowUpdate: true, __schema: { code: { __type: 'string', __allowUpdate: true } } },
      },
    },
    'a+b': { __type: 'string', __allowUpdate: true },
  },
});
const flat = getFlattenedSchema(makeSchema());
const resolve = (path) => {
  const resolved = resolveUpdatePath(flat, path);
  return 'error' in resolved ? resolved : { property: resolved.property, kind: resolved.kind, values: resolved.values };
};

describe('model/update-paths:resolveUpdatePath', () => {
  for (const [path, property, kind, values = []] of [
    ['name', 'name', 'scalar'],
    ['colour', 'colour', 'scalar', ['red', 'blue']],
    ['count', 'count', 'scalar'],
    ['count.__increment__', 'count', 'scalar-increment'],
    ['on', 'on', 'scalar'],
    ['due', 'due', 'scalar'],
    ['meta', 'meta', 'scalar'],
    ['meta.a.b', 'meta', 'scalar'],
    ['meta.removeMe', 'meta', 'scalar'],
    ['datastore.name', 'datastore.name', 'scalar'],
    ['tags', 'tags', 'vector-add'],
    ['tags.3', 'tags', 'scalar'],
    ['tags.3.__remove__', 'tags', 'vector-rm'],
    ['notes', 'notes', 'vector-add'],
    ['items', 'items', 'vector-add'],
    ['items.0', 'items', 'scalar'],
    ['items.0.__remove__', 'items', 'vector-rm'],
    ['items.2.sku', 'items.sku', 'scalar'],
    ['items.2.qty.__increment__', 'items.qty', 'scalar-increment'],
    ['items.2.parts', 'items.parts', 'vector-add'],
    ['items.2.parts.1.code', 'items.parts.code', 'scalar'],
    ['a+b', 'a+b', 'scalar'],
  ]) {
    it(`resolves ${path} to a ${kind} update of ${property}`, () => {
      assert.deepStrictEqual(resolve(path), { property, kind, values });
    });
  }

  for (const path of ['ownerId', 'datastore.connectionString', 'items.0.locked']) {
    it(`refuses ${path}, which does not allow updates, as immutable`, () => {
      assert.deepStrictEqual(resolve(path), { error: 'immutable' });
    });
  }

  for (const path of [
    'nothing',
    'aab',
    'datastore.other',
    'datastore',
    'name.__increment__',
    'due.__increment__',
    'meta.__remove__',
    'meta.',
    'meta..x',
    'items.sku',
    'items.x',
    'items.0.nothing',
    'tags.x',
    'items.123456789012',
    'name.x',
    '',
    // Names an object has from Object.prototype aren't the schema's
    'constructor',
    'toString',
    '__proto__',
    'items.0.constructor',
  ]) {
    it(`refuses ${JSON.stringify(path)} as an unknown path`, () => {
      assert.deepStrictEqual(resolve(path), { error: 'unknown_path' });
    });
  }
});

describe('helpers:getFlattenedSchema', () => {
  it('leaves the schema it is given as it was', () => {
    const given = makeSchema();

    getFlattenedSchema(given);

    assert.deepStrictEqual(given, makeSchema());
  });

  it("gives an array's flattened item schema", () => {
    assert.deepStrictEqual(Object.keys(flat.items.__schema), ['sku', 'qty', 'locked', 'parts.code', 'parts']);
    assert.deepStrictEqual(Object.keys(flat.items.__schema.parts.__schema), ['code']);
  });
});
