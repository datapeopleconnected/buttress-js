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

import SearchList from '../../../../../dist/routes/schema-routes/search-list.js';
import { streamAll } from '../../../../../dist/helpers/index.js';
import { RequestError } from '../../../../../dist/helpers/errors.js';

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (query.$and) return query.$and.every((q) => matchesQuery(doc, q));
  if (query.$or) return query.$or.some((q) => matchesQuery(doc, q));
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
        assert.ok(err instanceof RequestError);
        assert.strictEqual(err.message, 'invalid_value_skip');
        return true;
      },
    );
  });

  it('rejects when limit is not a number', async () => {
    const route = createRoute(createFakeModel([]));
    await assert.rejects(() => route._validate({ body: { limit: 'abc' } }, {}), /invalid_value_limit/);
  });

  it('defaults skip/limit/sort/project when the body omits them', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate({ body: {} }, {});

    assert.strictEqual(result.skip, 0);
    assert.strictEqual(result.limit, 0);
    assert.deepStrictEqual(result.sort, {});
    assert.strictEqual(result.project, false);
  });

  it('wraps the request query in $and', async () => {
    const route = createRoute(createFakeModel([]));
    const result = await route._validate({ body: { query: { ownerId: 'user-1' } } }, {});

    assert.deepStrictEqual(result.query, { $and: [{ ownerId: 'user-1' }] });
  });
});

describe('schema-routes/SearchList:_exec', () => {
  const docs = [
    { id: 'doc-1', ownerId: 'user-1' },
    { id: 'doc-2', ownerId: 'user-2' },
  ];

  it('returns every doc under a single unrestricted policy', async () => {
    const route = createRoute(createFakeModel(docs));
    const validateResult = { query: {}, skip: 0, limit: 0, sort: {}, project: false };

    const result = await streamAll(await route._exec({ context: { ac: { policyConfigs: [{}] } } }, {}, validateResult));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), ['doc-1', 'doc-2']);
  });

  it('scopes results to the access-control policy query', async () => {
    const route = createRoute(createFakeModel(docs));
    const validateResult = { query: {}, skip: 0, limit: 0, sort: {}, project: false };
    const ac = { policyConfigs: [{ query: { ownerId: 'user-1' } }] };

    const result = await streamAll(await route._exec({ context: { ac } }, {}, validateResult));

    assert.deepStrictEqual(
      result.map((d) => d.id),
      ['doc-1'],
    );
  });

  it('unions results across multiple policy scopes', async () => {
    const route = createRoute(createFakeModel(docs));
    const validateResult = { query: {}, skip: 0, limit: 0, sort: {}, project: false };
    const ac = { policyConfigs: [{ query: { ownerId: 'user-1' } }, { query: { ownerId: 'user-2' } }] };

    const result = await streamAll(await route._exec({ context: { ac } }, {}, validateResult));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), ['doc-1', 'doc-2']);
  });
});
