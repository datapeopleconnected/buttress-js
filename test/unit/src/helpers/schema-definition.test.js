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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSchemaDefinition } from '../../../../dist/helpers/schema-definition.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../dist');

const check = (properties) => checkSchemaDefinition({ name: 'thing', type: 'collection', properties });

describe('helpers/schema-definition:checkSchemaDefinition', () => {
  it('takes a schema using every kind of property', () => {
    assert.deepStrictEqual(
      check({
        name: { __type: 'string', __default: null, __required: true, __allowUpdate: true, __unique: true },
        secret: { __type: 'string', __private: true },
        colour: { __type: 'string', __enum: ['red', 'blue'], __default: 'red' },
        count: { __type: 'number', __default: 0 },
        on: { __type: 'boolean' },
        due: { __type: 'date', __default: 'now' },
        ownerId: { __type: 'id', __default: 'new' },
        ref: { __type: 'uuid', __default: 'new' },
        meta: { __type: 'object', __timeSeries: 'telemetry' },
        tags: { __type: 'array', __itemtype: 'string' },
        items: { __type: 'array', __schema: { sku: { __type: 'string' }, parts: { __type: 'array', __itemtype: 'id' } } },
        git: { url: { __type: 'string' }, deep: { branch: { __type: 'string' } } },
      }),
      [],
    );
  });

  it('lists every problem with the properties, where it is', () => {
    assert.deepStrictEqual(
      check({
        name: { __type: 'strnig' },
        colour: { __type: 'string', __enum: 'red' },
        count: { __type: 'number', __requried: true, required: true },
        on: { __type: 'boolean', __allowUpdate: 'yes' },
        tags: { __type: 'array', __itemtype: 'thing' },
        items: { __type: 'array', __schema: { 'sku.code': { __type: 'string' }, _hidden: { __type: 'string' } } },
        git: { url: { __default: null, __required: true } },
        $where: { __type: 'string' },
        loose: 'text',
        meta: { __type: 'object', __schema: { a: { __type: 'string' } } },
      }),
      [
        { path: 'name.__type', code: 'enum', expected: ['string', 'number', 'boolean', 'date', 'id', 'uuid', 'object', 'array'] },
        { path: 'colour.__enum', code: 'type', expected: 'array' },
        { path: 'count.__requried', code: 'unknown_path' },
        { path: 'count.required', code: 'unknown_path' },
        { path: 'on.__allowUpdate', code: 'type', expected: 'boolean' },
        { path: 'tags.__itemtype', code: 'enum', expected: ['string', 'number', 'boolean', 'date', 'id', 'uuid', 'object'] },
        { path: 'items.__schema.sku.code', code: 'invalid_name' },
        { path: 'items.__schema._hidden', code: 'invalid_name' },
        { path: 'git.url.__type', code: 'required' },
        { path: '$where', code: 'invalid_name' },
        { path: 'loose', code: 'type', expected: 'object' },
        { path: 'meta.__schema', code: 'unknown_path' },
      ],
    );
  });

  // SR-DPC-001 R15: an Invalid Date default refused every create that left the date out
  it("takes a date default that makes a date, and refuses one that doesn't", () => {
    const dates = ['now', 'Now', 'today', 'tomorrow', '2 days ago', '2026-01-01', '2026-01-01T12:00:00Z', 1700000000000, '', 0, null];
    assert.deepStrictEqual(check(Object.fromEntries(dates.map((value, i) => [`d${i}`, { __type: 'date', __default: value }]))), []);

    assert.deepStrictEqual(
      check({
        garbage: { __type: 'date', __default: 'garbage' },
        blank: { __type: 'date', __default: ' ' },
        idDefault: { __type: 'date', __default: 'new' },
        huge: { __type: 'date', __default: 1e20 },
        later: { a: { __type: 'array', __schema: { at: { __type: 'date', __default: 'nonsense' } } } },
      }),
      [
        { path: 'garbage.__default', code: 'type', expected: 'date' },
        { path: 'blank.__default', code: 'type', expected: 'date' },
        { path: 'idDefault.__default', code: 'type', expected: 'date' },
        { path: 'huge.__default', code: 'type', expected: 'date' },
        { path: 'later.a.__schema.at.__default', code: 'type', expected: 'date' },
      ],
    );
  });

  it("takes a default that isn't a date for a property that isn't one", () => {
    assert.deepStrictEqual(check({ label: { __type: 'string', __default: 'garbage' } }), []);
  });

  it('refuses properties that are not an object', () => {
    assert.deepStrictEqual(checkSchemaDefinition({ name: 'thing', type: 'collection', properties: [] }), [
      { path: 'properties', code: 'type', expected: 'object' },
    ]);
  });

  it("takes every core model's own schema, whose internals are the server's", async () => {
    const files = fs.readdirSync(path.join(DIST, 'model/core')).filter((file) => file.endsWith('.js'));
    for (const file of files) {
      const { default: CoreModel } = await import(path.join(DIST, 'model/core', file));
      if (!CoreModel?.Schema) continue;
      assert.deepStrictEqual(checkSchemaDefinition(CoreModel.Schema, { internals: true }), [], file);
    }
  });
});
