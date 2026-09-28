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
import * as Errors from '../../../../../dist/helpers/errors.js';

const { RequestError } = Errors;

// storedIds are given back in lower case, as the Mongo adapter gives ids.
function createFakeModel({ validation = { isValid: true }, added, storedIds = [] } = {}) {
  const lookups = [];
  return {
    lookups,
    validate: () => validation,
    findStoredIds: async (ids) => {
      lookups.push(ids);
      return storedIds.filter((id) => ids.some((wanted) => wanted.toLowerCase() === id));
    },
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

  it('names the index of the first invalid entity', async () => {
    const model = createFakeModel();
    model.validate = (entity) => (entity.name ? { isValid: true } : { isValid: false, missing: ['name'], invalid: [] });
    const route = createRoute(model);

    await assert.rejects(
      () => route._validate({ body: [{ name: 'a' }, {}], context: { id: 'req-1' } }, {}),
      (err) => err.code === 400 && err.message === 'test-schema: Missing field: name at index 1',
    );
  });

  it('refuses two entities with the same id, naming the second', async () => {
    const route = createRoute(createFakeModel());

    await assert.rejects(
      () => route._validate({ body: [{ id: 'x' }, { id: 'y' }, { id: 'x' }], context: { id: 'req-1' } }, {}),
      (err) => err.code === 400 && err.message === 'test-schema: Duplicate id x at index 2',
    );
  });

  it('refuses an entity that is not an object, naming its index', async () => {
    const route = createRoute(createFakeModel());

    for (const entity of [[{ name: 'a' }], null, 1, 'a']) {
      await assert.rejects(
        () => route._validate({ body: [{ name: 'a' }, entity], context: { id: 'req-1' } }, {}),
        (err) => err.code === 400 && err.message === 'test-schema: Invalid entity at index 1, expected an object',
      );
    }
  });

  it('refuses two entities whose ids differ only in case', async () => {
    const route = createRoute(createFakeModel());

    await assert.rejects(
      () => route._validate({ body: [{ id: '6ab0abcd' }, { id: '6AB0ABCD' }], context: { id: 'req-1' } }, {}),
      (err) => err.code === 400 && err.message === 'test-schema: Duplicate id 6AB0ABCD at index 1',
    );
  });

  it('refuses an entity whose id is already stored', async () => {
    const route = createRoute(createFakeModel({ storedIds: ['y'] }));

    await assert.rejects(
      () => route._validate({ body: [{ id: 'x' }, { id: 'y' }], context: { id: 'req-1' } }, {}),
      (err) => err.code === 400 && err.message === 'test-schema: Duplicate id y at index 1',
    );
  });

  it('refuses an entity whose id is stored, whatever its case', async () => {
    const route = createRoute(createFakeModel({ storedIds: ['6ab0abcd'] }));

    await assert.rejects(
      () => route._validate({ body: [{ id: '6AB0ABCD' }], context: { id: 'req-1' } }, {}),
      (err) => err.code === 400 && err.message === 'test-schema: Duplicate id 6AB0ABCD at index 0',
    );
  });

  it('looks the stored ids up once for the whole batch', async () => {
    const model = createFakeModel();
    const route = createRoute(model);

    await route._validate({ body: [{ id: 'x' }, { name: 'a' }, { id: 'y' }], context: { id: 'req-1' } }, {});

    assert.deepStrictEqual(model.lookups, [['x', 'y']]);
  });

  it('does not look up ids when no entity has one', async () => {
    const model = createFakeModel();
    const route = createRoute(model);

    await route._validate({ body: [{ name: 'a' }, { name: 'b' }], context: { id: 'req-1' } }, {});

    assert.deepStrictEqual(model.lookups, []);
  });

  it('names the first entity that fails, whether it is invalid or a duplicate', async () => {
    const model = createFakeModel({ storedIds: ['s'] });
    model.validate = (entity) => (entity.name ? { isValid: true } : { isValid: false, missing: ['name'], invalid: [] });
    const route = createRoute(model);

    await assert.rejects(
      () => route._validate({ body: [{ id: 's', name: 'a' }, {}], context: { id: 'req-1' } }, {}),
      (err) => err.message === 'test-schema: Duplicate id s at index 0',
    );
    await assert.rejects(
      () => route._validate({ body: [{}, { id: 's', name: 'a' }], context: { id: 'req-1' } }, {}),
      (err) => err.message === 'test-schema: Missing field: name at index 0',
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

  it('refuses the batch with a 400 when an id is taken while it is being stored', async () => {
    const model = createFakeModel();
    model.add = async () => {
      throw new Errors.DuplicateIdError(1, '6ab0abcd');
    };
    const route = createRoute(model);

    await assert.rejects(
      () => route._exec({ context: { id: 'req-1' } }, {}, [{ name: 'a' }, { id: '6AB0ABCD' }]),
      (err) => {
        assert.ok(err instanceof RequestError);
        assert.strictEqual(err.code, 400);
        assert.strictEqual(err.message, 'test-schema: Duplicate id 6AB0ABCD at index 1');
        return true;
      },
    );
  });
});
