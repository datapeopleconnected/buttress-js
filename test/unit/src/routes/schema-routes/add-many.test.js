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

import AddMany from '../../../../../dist/routes/schema-routes/add-many.js';
import { RequestError } from '../../../../../dist/helpers/errors.js';

function createFakeModel({ validation = { isValid: true }, added } = {}) {
  return {
    validate: () => validation,
    add: async (entities) => added || entities.map((e, idx) => ({ id: `new-${idx}`, ...e })),
  };
}

function createRoute(model) {
  const route = Object.create(AddMany.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/AddMany:_validate', () => {
  it('rejects when the body is not an array', async () => {
    const route = createRoute(createFakeModel());

    await assert.rejects(
      () => route._validate({ body: { name: 'test' }, context: { id: 'req-1' } }, {}),
      (err) => {
        assert.ok(err instanceof RequestError);
        assert.strictEqual(err.code, 400);
        assert.strictEqual(err.message, 'array_required');
        return true;
      },
    );
  });

  it('rejects with the first missing field across the batch', async () => {
    const route = createRoute(createFakeModel({ validation: { isValid: false, missing: ['name'], invalid: [] } }));

    await assert.rejects(() => route._validate({ body: [{}], context: { id: 'req-1' } }, {}), /Missing field: name/);
  });

  it('rejects with the first invalid value when nothing is missing', async () => {
    const route = createRoute(
      createFakeModel({ validation: { isValid: false, missing: [], invalid: ['age:abc[string]'] } }),
    );

    await assert.rejects(
      () => route._validate({ body: [{}], context: { id: 'req-1' } }, {}),
      /Invalid value: age:abc\[string\]/,
    );
  });

  it('returns the entities array unchanged when valid', async () => {
    const route = createRoute(createFakeModel());
    const entities = [{ name: 'a' }, { name: 'b' }];

    const result = await route._validate({ body: entities, context: { id: 'req-1' } }, {});

    assert.strictEqual(result, entities);
  });
});

describe('schema-routes/AddMany:_exec', () => {
  it('adds every validated entity in one call', async () => {
    const model = createFakeModel({ added: [{ id: 'new-0' }, { id: 'new-1' }] });
    const route = createRoute(model);

    const result = await route._exec({}, {}, [{ name: 'a' }, { name: 'b' }]);

    assert.deepStrictEqual(result, [{ id: 'new-0' }, { id: 'new-1' }]);
  });
});
