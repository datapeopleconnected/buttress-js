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
import { Readable } from 'stream';

import GetList from '../../../../../dist/routes/schema-routes/get-list.js';
import { streamAll } from '../../../../../dist/helpers/index.js';

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (query.$and) return query.$and.every((q) => matchesQuery(doc, q));
  return Object.keys(query).every((key) => `${doc?.[key]}` === `${query[key]}`);
}

function createFakeModel(docs) {
  return {
    flatSchemaData: {},
    parseQuery: (query) => query,
    find(query) {
      const matches = docs.filter((doc) => matchesQuery(doc, query));
      return Readable.from(matches, { objectMode: true });
    },
  };
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
  it('wraps a request query in $and', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate(createReq({ body: { query: { ownerId: 'user-1' } } }), {});

    assert.deepStrictEqual(result.query, { $and: [{ ownerId: 'user-1' }] });
  });

  it('defaults to an empty $and query and no projection when the body is empty', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate(createReq(), {});

    assert.deepStrictEqual(result.query, { $and: [] });
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
    { id: 'doc-1', ownerId: 'user-1' },
    { id: 'doc-2', ownerId: 'user-2' },
  ];

  it('returns docs scoped to the access-control policy', async () => {
    const route = createRoute(createFakeModel(docs));
    const req = createReq({ ac: { policyConfigs: [{ query: { ownerId: 'user-1' } }] } });
    const validateResult = { query: {}, project: false };

    const result = await streamAll(await route._exec(req, {}, validateResult));

    assert.deepStrictEqual(
      result.map((d) => d.id),
      ['doc-1'],
    );
  });
});
