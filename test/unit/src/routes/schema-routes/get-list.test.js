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

import GetList from '../../../../../dist/routes/schema-routes/get-list.js';
import { streamAll } from '../../../../../dist/helpers/index.js';
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
  const route = Object.create(GetList.prototype);
  route.name = 'GetList';
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

function createReq({ body = {}, ac = { policyConfigs: [{}] } } = {}) {
  return {
    body,
    context: { id: 'req-1', timer: { interval: 0, lapTime: 0 }, ac },
  };
}

describe('schema-routes/GetList:_validate', () => {
  it('wraps a request query in $and, parsed', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate(createReq({ body: { query: { ownerId: USER_1 } } }), {});

    assert.deepStrictEqual(result.query, { $and: [{ ownerId: { $eq: USER_1 } }] });
  });

  it('defaults to an empty query, as parsing drops an empty $and, and no projection when the body is empty', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate(createReq(), {});

    assert.deepStrictEqual(result.query, {});
    assert.strictEqual(result.project, false);
  });

  it('short-circuits to false when the query explicitly requests zero results', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate(createReq({ body: { query: { zeroResults: true } } }), {});

    assert.strictEqual(result, false);
  });

  it('forwards an explicit projection', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate(createReq({ body: { project: { name: 1 } } }), {});

    assert.deepStrictEqual(result.project, { name: 1 });
  });
});

describe('schema-routes/GetList:_exec', () => {
  const docs = [
    { id: DOC_1, ownerId: USER_1 },
    { id: DOC_2, ownerId: USER_2 },
  ];

  // SR-DPC-001 C2: false was passed on as the query params, so every entity was listed, or a policy's query failed
  for (const [name, ac] of [
    ['no query', { policyConfigs: [{}] }],
    ['a query', { policyConfigs: [{ query: { ownerId: USER_1 } }] }],
  ]) {
    it(`lists nothing for a query that asks for zero results, under a policy with ${name}`, async () => {
      const route = createRoute(createFakeModel(docs));

      const result = await route._exec(createReq({ ac }), {}, false);

      assert.deepStrictEqual(Array.isArray(result) ? result : await streamAll(result), []);
    });
  }

  it('returns docs scoped to the access-control policy', async () => {
    const route = createRoute(createFakeModel(docs));
    const req = createReq({ ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } });
    const validateResult = { query: {}, project: false };

    const result = await streamAll(await route._exec(req, {}, validateResult));

    assert.deepStrictEqual(
      result.map((d) => d.id),
      [DOC_1],
    );
  });
});
