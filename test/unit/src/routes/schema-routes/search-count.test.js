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

import SearchCount from '../../../../../dist/routes/schema-routes/search-count.js';
import { createSchemaModel, newId } from '../../../../schema-model.js';

// A real schema model, so the route and access control run the real parseQuery, over rows in memory
const schema = {
  name: 'test-schema',
  properties: { ownerId: { __type: 'id' }, a: { __type: 'number' }, b: { __type: 'number' } },
};
const USER_1 = newId();
const USER_2 = newId();

const createModel = (rows = []) => createSchemaModel(schema, rows);
const counts = (datastore) => datastore.calls.filter(([call]) => call === 'count');

function createRoute(model) {
  const route = Object.create(SearchCount.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/SearchCount:_validate', () => {
  it('wraps an explicit body.query in $and, parsed', async () => {
    const route = createRoute(createModel().model);
    const result = await route._validate({ body: { query: { ownerId: USER_1 } } }, {});

    assert.deepStrictEqual(result.queryParams.query, { $and: [{ ownerId: { $eq: USER_1 } }] });
    assert.strictEqual(result.actualCount, false);
  });

  it('treats a queryless body as the query itself', async () => {
    const route = createRoute(createModel().model);
    const result = await route._validate({ body: { ownerId: USER_1 } }, {});

    assert.deepStrictEqual(result.queryParams.query, { $and: [{ ownerId: { $eq: USER_1 } }] });
  });

  it('takes actualCount from a queryless body as the flag it is, not as a field to match', async () => {
    const route = createRoute(createModel().model);
    const result = await route._validate({ body: { actualCount: true, ownerId: USER_1 } }, {});

    assert.deepStrictEqual(result.queryParams.query, { $and: [{ ownerId: { $eq: USER_1 } }] });
    assert.strictEqual(result.actualCount, true);

    const flagOnly = await route._validate({ body: { actualCount: true } }, {});
    assert.deepStrictEqual(flagOnly.queryParams.query, { $and: [{}] });
  });

  it('honours an explicit actualCount flag', async () => {
    const route = createRoute(createModel().model);
    const result = await route._validate({ body: { actualCount: true, query: {} } }, {});

    assert.strictEqual(result.actualCount, true);
  });
});

describe('schema-routes/SearchCount:_exec', () => {
  const byOwner = () => [
    { id: newId(), ownerId: USER_1 },
    { id: newId(), ownerId: USER_1 },
    { id: newId(), ownerId: USER_1 },
    { id: newId(), ownerId: USER_2 },
  ];

  it('counts against a single policy scope', async () => {
    const { model, datastore } = createModel(byOwner());
    const route = createRoute(model);
    const validateResult = { queryParams: { query: { ownerId: USER_1 } }, actualCount: false };

    const result = await route._exec({ context: { ac: { policyConfigs: [{}] } } }, {}, validateResult);

    assert.strictEqual(result, 3);
    assert.strictEqual(counts(datastore).length, 1);
  });

  // An entity two of them reach was counted twice (BUG-17)
  it('counts what every policy reaches in one $or count, when actualCount is requested too', async () => {
    const { model, datastore } = createModel(byOwner());
    const route = createRoute(model);
    const validateResult = { queryParams: { query: {} }, actualCount: true };
    const ac = { policyConfigs: [{ query: { ownerId: USER_1 } }, { query: { ownerId: USER_2 } }] };

    const result = await route._exec({ context: { ac } }, {}, validateResult);

    assert.strictEqual(result, 4);
    assert.strictEqual(counts(datastore).length, 1);
  });

  it('combines multiple policies into a single $or count when actualCount is not requested', async () => {
    // A row both policies select is counted once
    const { model, datastore } = createModel([
      { id: newId(), a: 1 },
      { id: newId(), b: 2 },
      { id: newId(), a: 1, b: 2 },
      { id: newId(), a: 3 },
    ]);
    const route = createRoute(model);
    const validateResult = { queryParams: { query: {} }, actualCount: false };
    const ac = { policyConfigs: [{ query: { a: 1 } }, { query: { b: 2 } }] };

    const result = await route._exec({ context: { ac } }, {}, validateResult);

    assert.strictEqual(result, 3);
    assert.strictEqual(counts(datastore).length, 1);
    const [, countQuery] = counts(datastore)[0];
    assert.strictEqual(countQuery.$or.length, 2);
  });
});
