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

import AddOne from '../../../../../dist/routes/schema-routes/add-one.js';
import { RequestError } from '../../../../../dist/helpers/errors.js';

function createFakeModel({ validation = { isValid: true }, isDuplicate = false, added } = {}) {
  return {
    schemaData: { name: 'test-schema' },
    validate: () => validation,
    isDuplicate: async () => isDuplicate,
    add: async (body) => added || { id: 'new-id', ...body },
  };
}

function createRoute(model) {
  const route = Object.create(AddOne.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/AddOne:_validate', () => {
  it('rejects with the first missing field', async () => {
    const route = createRoute(createFakeModel({ validation: { isValid: false, missing: ['name'], invalid: [] } }));

    await assert.rejects(
      () => route._validate({ body: {}, context: { id: 'req-1' } }, {}),
      (err) => {
        assert.ok(err instanceof RequestError);
        assert.strictEqual(err.code, 400);
        assert.match(err.message, /Missing field: name/);
        return true;
      },
    );
  });

  it('rejects with the first invalid value when nothing is missing', async () => {
    const route = createRoute(
      createFakeModel({ validation: { isValid: false, missing: [], invalid: ['age:abc[string]'] } }),
    );

    await assert.rejects(
      () => route._validate({ body: {}, context: { id: 'req-1' } }, {}),
      (err) => {
        assert.ok(err instanceof RequestError);
        assert.match(err.message, /Invalid value: age:abc\[string\]/);
        return true;
      },
    );
  });

  it('rejects as a duplicate when the entity already exists', async () => {
    const route = createRoute(createFakeModel({ isDuplicate: true }));

    await assert.rejects(
      () => route._validate({ body: { name: 'test' }, context: { id: 'req-1' } }, {}),
      (err) => {
        assert.ok(err instanceof RequestError);
        assert.strictEqual(err.code, 400);
        assert.strictEqual(err.message, 'duplicate');
        return true;
      },
    );
  });

  it('resolves true when the body is valid and not a duplicate', async () => {
    const route = createRoute(createFakeModel());

    const result = await route._validate({ body: { name: 'test' }, context: { id: 'req-1' } }, {});

    assert.strictEqual(result, true);
  });
});

describe('schema-routes/AddOne:_exec', () => {
  it('adds the entity and returns it unchanged (no plugin filters registered)', async () => {
    const model = createFakeModel({ added: { id: 'new-id', name: 'test' } });
    const route = createRoute(model);

    const result = await route._exec({ body: { name: 'test' }, context: { id: 'req-1' } }, {}, true);

    assert.deepStrictEqual(result, { id: 'new-id', name: 'test' });
  });
});
