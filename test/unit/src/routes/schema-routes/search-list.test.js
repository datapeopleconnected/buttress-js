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

import SearchList from '../../../../../dist/routes/schema-routes/search-list.js';
import { streamAll } from '../../../../../dist/helpers/index.js';
import { ApiError } from '../../../../../dist/helpers/errors.js';
import { createSchemaModel, newId } from '../../../../schema-model.js';

// A real schema model, so the route and access control run the real parseQuery, over rows in memory
const schema = {
  name: 'test-schema',
  properties: {
    ownerId: { __type: 'id' },
    value: { __type: 'string', __default: null, __allowUpdate: true },
  },
};
const DOC_1 = newId();
const DOC_2 = newId();
const USER_1 = newId();
const USER_2 = newId();

function createFakeModel(docs) {
  return createSchemaModel(schema, docs).model;
}

function createRoute(model) {
  const route = Object.create(SearchList.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/SearchList:_validate', () => {
  it('rejects when skip is not a number', async () => {
    const route = createRoute(createFakeModel([]));
    await assert.rejects(
      () => route._validate({ body: { skip: 'abc' } }, {}),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.code, 'invalid_value_skip');
        return true;
      },
    );
  });

  it('rejects when limit is not a number', async () => {
    const route = createRoute(createFakeModel([]));
    await assert.rejects(() => route._validate({ body: { limit: 'abc' } }, {}), { code: 'invalid_value_limit' });
  });

  it('rejects a negative skip or limit, before it reaches the datastore', async () => {
    const route = createRoute(createFakeModel([]));
    for (const skip of [-1, '-5']) {
      await assert.rejects(() => route._validate({ body: { skip } }, {}), { status: 400, code: 'invalid_value_skip' });
    }
    for (const limit of [-1, '-5']) {
      await assert.rejects(() => route._validate({ body: { limit } }, {}), { status: 400, code: 'invalid_value_limit' });
    }
  });

  it('takes a skip and limit given as text', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate({ body: { skip: '2', limit: '3' } }, {});

    assert.strictEqual(result.skip, 2);
    assert.strictEqual(result.limit, 3);
  });

  it('defaults skip/limit/sort/project when the body omits them', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate({ body: {} }, {});

    assert.strictEqual(result.skip, 0);
    assert.strictEqual(result.limit, 0);
    assert.deepStrictEqual(result.sort, {});
    assert.strictEqual(result.project, false);
  });

  it('wraps the request query in $and, parsed', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate({ body: { query: { ownerId: USER_1 } } }, {});

    assert.deepStrictEqual(result.query, { $and: [{ ownerId: { $eq: USER_1 } }] });
  });
});

describe('schema-routes/SearchList:_exec', () => {
  const docs = [
    { id: DOC_1, ownerId: USER_1 },
    { id: DOC_2, ownerId: USER_2 },
  ];

  it('returns every doc under a single unrestricted policy', async () => {
    const route = createRoute(createFakeModel(docs));
    const validateResult = { query: {}, skip: 0, limit: 0, sort: {}, project: false };

    const result = await streamAll(await route._exec({ context: { ac: { policyConfigs: [{}] } } }, {}, validateResult));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), [DOC_1, DOC_2]);
  });

  it('scopes results to the access-control policy query', async () => {
    const route = createRoute(createFakeModel(docs));
    const validateResult = { query: {}, skip: 0, limit: 0, sort: {}, project: false };
    const ac = { policyConfigs: [{ query: { ownerId: USER_1 } }] };

    const result = await streamAll(await route._exec({ context: { ac } }, {}, validateResult));

    assert.deepStrictEqual(
      result.map((d) => d.id),
      [DOC_1],
    );
  });

  it('unions results across multiple policy scopes', async () => {
    const route = createRoute(createFakeModel(docs));
    const validateResult = { query: {}, skip: 0, limit: 0, sort: {}, project: false };
    const ac = { policyConfigs: [{ query: { ownerId: USER_1 } }, { query: { ownerId: USER_2 } }] };

    const result = await streamAll(await route._exec({ context: { ac } }, {}, validateResult));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), [DOC_1, DOC_2]);
  });
});
