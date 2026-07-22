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

import DeleteOne from '../../../../../dist/routes/schema-routes/delete-one.js';
import { RequestError } from '../../../../../dist/helpers/errors.js';

function createFakeModel(docs) {
  return {
    createId: (id) => id,
    flatSchemaData: {},
    parseQuery: (query) => query,
    find(query) {
      const matches = docs.filter((doc) => matchesQuery(doc, query));
      return Readable.from(matches, { objectMode: true });
    },
    async rm(id) {
      const idx = docs.findIndex((d) => d.id === id);
      if (idx >= 0) docs.splice(idx, 1);
      return true;
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
  const route = Object.create(DeleteOne.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/DeleteOne', () => {
  const makeDocs = () => [
    { id: 'doc-1', ownerId: 'user-1' },
    { id: 'doc-2', ownerId: 'user-2' },
  ];

  it('deletes the entity when the token has full access', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = { params: { id: 'doc-1' }, context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.ok(!docs.some((d) => d.id === 'doc-1'));
  });

  it('deletes the entity when it matches the access-control policy query', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: 'doc-1' },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: 'user-1' } }] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.ok(!docs.some((d) => d.id === 'doc-1'));
  });

  it('rejects with a 400 and leaves the entity intact when it exists but is outside the access-control policy scope', async () => {
    // doc-2 exists, but belongs to user-2 while the policy only scopes to user-1's records.
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: 'doc-2' },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: 'user-1' } }] } },
    };

    await assert.rejects(
      () => route._validate(req, {}),
      (err) => {
        assert.ok(err instanceof RequestError);
        assert.strictEqual(err.code, 400);
        return true;
      },
    );

    assert.ok(
      docs.some((d) => d.id === 'doc-2'),
      'entity outside the access-control scope must not be deleted',
    );
  });
});
