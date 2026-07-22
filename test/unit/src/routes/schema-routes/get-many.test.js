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

import GetMany from '../../../../../dist/routes/schema-routes/get-many.js';
import { streamAll } from '../../../../../dist/helpers/index.js';

function createFakeModel(docs) {
  return {
    createId: (id) => id,
    flatSchemaData: {},
    parseQuery: (query) => query,
    find(query) {
      const matches = docs.filter((doc) => matchesQuery(doc, query));
      return Readable.from(matches, { objectMode: true });
    },
  };
}

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (query.$and) return query.$and.every((q) => matchesQuery(doc, q));
  return Object.keys(query).every((key) => {
    const cond = query[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && '$in' in cond) {
      return cond.$in.some((v) => `${v}` === `${doc[key]}`);
    }
    return `${doc?.[key]}` === `${cond}`;
  });
}

function createRoute(model) {
  const route = Object.create(GetMany.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/GetMany', () => {
  const docs = [
    { id: 'doc-1', ownerId: 'user-1' },
    { id: 'doc-2', ownerId: 'user-2' },
    { id: 'doc-3', ownerId: 'user-1' },
  ];

  it('returns all requested docs when the token has full access', async () => {
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: { query: { ids: ['doc-1', 'doc-2', 'doc-3'] } },
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };

    const validate = await route._validate(req, {});
    const result = await streamAll(await route._exec(req, {}, validate));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), ['doc-1', 'doc-2', 'doc-3']);
  });

  it('only returns the subset of requested docs that fall within the access-control policy scope', async () => {
    // doc-2 belongs to user-2, so it must be excluded even though it was requested by id.
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: { query: { ids: ['doc-1', 'doc-2', 'doc-3'] } },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: 'user-1' } }] } },
    };

    const validate = await route._validate(req, {});
    const result = await streamAll(await route._exec(req, {}, validate));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), ['doc-1', 'doc-3']);
  });
});
