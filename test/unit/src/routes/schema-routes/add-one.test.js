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
import * as Errors from '../../../../../dist/helpers/errors.js';

const { RequestError } = Errors;

function createFakeModel({ validation = { isValid: true }, isDuplicate = false, added, storedIds = [] } = {}) {
  return {
    schemaData: { name: 'test-schema' },
    validate: () => validation,
    isDuplicate: async () => isDuplicate,
    findStoredIds: async (ids) => storedIds.filter((id) => ids.includes(id)),
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

  it('checks an array of entities as bulk/add does, naming the index of the first that fails', async () => {
    const model = createFakeModel({ storedIds: ['x'] });
    model.validate = (entity) => (entity.name ? { isValid: true } : { isValid: false, missing: ['name'], invalid: [] });
    const route = createRoute(model);

    for (const [body, message] of [
      [[{ name: 'a' }, { id: 'x', name: 'b' }], 'test-schema: Duplicate id x at index 1'],
      [[{ name: 'a' }, { id: 'y', name: 'b' }, { id: 'y', name: 'c' }], 'test-schema: Duplicate id y at index 2'],
      [[{ name: 'a' }, {}], 'test-schema: Missing field: name at index 1'],
      [[{ name: 'a' }, [{ name: 'b' }]], 'test-schema: Invalid entity at index 1, expected an object'],
    ]) {
      await assert.rejects(
        () => route._validate({ body, context: { id: 'req-1' } }, {}),
        (err) => err instanceof RequestError && err.code === 400 && err.message === message,
      );
    }
  });

  it('resolves true for an array of valid, new entities', async () => {
    const route = createRoute(createFakeModel({ storedIds: ['x'] }));

    assert.strictEqual(await route._validate({ body: [{ id: 'y' }, { name: 'b' }], context: { id: 'req-1' } }, {}), true);
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

  it('refuses the entity as a duplicate when its id is taken while it is being stored', async () => {
    const model = createFakeModel();
    model.add = async () => {
      throw new Errors.DuplicateIdError(0, 'x');
    };
    const route = createRoute(model);

    await assert.rejects(
      () => route._exec({ body: { id: 'x' }, context: { id: 'req-1' } }, {}, true),
      (err) => err instanceof RequestError && err.code === 400 && err.message === 'duplicate',
    );
  });

  it('names the index of an id taken while an array of entities is being stored', async () => {
    const model = createFakeModel();
    model.add = async () => {
      throw new Errors.DuplicateIdError(1, 'x');
    };
    const route = createRoute(model);

    await assert.rejects(
      () => route._exec({ body: [{ name: 'a' }, { id: 'x' }], context: { id: 'req-1' } }, {}, true),
      (err) => err instanceof RequestError && err.message === 'test-schema: Duplicate id x at index 1',
    );
  });
});
