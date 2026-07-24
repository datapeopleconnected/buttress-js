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
import sinon from 'sinon';

import SearchCount from '../../../../../dist/routes/schema-routes/search-count.js';

function createFakeModel(countResult = 0) {
  return {
    flatSchemaData: {},
    parseQuery: (query) => query,
    count: sinon.stub().resolves(countResult),
  };
}

function createRoute(model) {
  const route = Object.create(SearchCount.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/SearchCount:_validate', () => {
  it('wraps an explicit body.query in $and', async () => {
    const route = createRoute(createFakeModel());
    const result = await route._validate({ body: { query: { ownerId: 'user-1' } } }, {});

    assert.deepStrictEqual(result.queryParams.query, { $and: [{ ownerId: 'user-1' }] });
    assert.strictEqual(result.actualCount, false);
  });

  it('treats a queryless body as the query itself', async () => {
    const route = createRoute(createFakeModel());
    const result = await route._validate({ body: { ownerId: 'user-1' } }, {});

    assert.deepStrictEqual(result.queryParams.query, { $and: [{ ownerId: 'user-1' }] });
  });

  it('honours an explicit actualCount flag', async () => {
    const route = createRoute(createFakeModel());
    const result = await route._validate({ body: { actualCount: true, query: {} } }, {});

    assert.strictEqual(result.actualCount, true);
  });
});

describe('schema-routes/SearchCount:_exec', () => {
  it('counts against a single policy scope', async () => {
    const model = createFakeModel(3);
    const route = createRoute(model);
    const validateResult = { queryParams: { query: { ownerId: 'user-1' } }, actualCount: false };

    const result = await route._exec({ context: { ac: { policyConfigs: [{}] } } }, {}, validateResult);

    assert.strictEqual(result, 3);
    assert.strictEqual(model.count.callCount, 1);
  });

  it('sums per-policy counts when actualCount is requested across multiple policies', async () => {
    const model = createFakeModel();
    model.count.onCall(0).resolves(2);
    model.count.onCall(1).resolves(5);
    const route = createRoute(model);
    const validateResult = { queryParams: { query: {} }, actualCount: true };
    const ac = { policyConfigs: [{}, {}] };

    const result = await route._exec({ context: { ac } }, {}, validateResult);

    assert.strictEqual(result, 7);
    assert.strictEqual(model.count.callCount, 2);
  });

  it('combines multiple policies into a single $or count when actualCount is not requested', async () => {
    const model = createFakeModel(4);
    const route = createRoute(model);
    const validateResult = { queryParams: { query: {} }, actualCount: false };
    const ac = { policyConfigs: [{ query: { a: 1 } }, { query: { b: 2 } }] };

    const result = await route._exec({ context: { ac } }, {}, validateResult);

    assert.strictEqual(result, 4);
    assert.strictEqual(model.count.callCount, 1);
    const [countQuery] = model.count.firstCall.args;
    assert.strictEqual(countQuery.$or.length, 2);
  });
});
