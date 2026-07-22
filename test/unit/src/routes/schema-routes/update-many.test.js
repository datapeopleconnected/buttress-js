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

import UpdateMany from '../../../../../dist/routes/schema-routes/update-many.js';

function createFakeModel(docs) {
  return {
    createId: (id) => id,
    flatSchemaData: {},
    parseQuery: (query) => query,
    find(query) {
      const matches = docs.filter((doc) => matchesQuery(doc, query));
      return Readable.from(matches, { objectMode: true });
    },
    validateUpdate(body) {
      return { validation: { isValid: true }, body };
    },
    async exists(id) {
      return docs.some((doc) => doc.id === id);
    },
    async updateByPath(body, id) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) return null;
      doc.value = body.value;
      return doc;
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
  const route = Object.create(UpdateMany.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/UpdateMany', () => {
  const makeDocs = () => [
    { id: 'doc-1', ownerId: 'user-1', value: 'original' },
    { id: 'doc-2', ownerId: 'user-2', value: 'original' },
  ];

  it('updates every entity when the token has full access', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [
        { id: 'doc-1', body: { path: 'value', value: 'updated' } },
        { id: 'doc-2', body: { path: 'value', value: 'updated' } },
      ],
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.strictEqual(docs.find((d) => d.id === 'doc-1').value, 'updated');
    assert.strictEqual(docs.find((d) => d.id === 'doc-2').value, 'updated');
  });

  it('marks an entity outside the access-control policy scope invalid and does not apply its update', async () => {
    // doc-2 belongs to user-2, but the policy only scopes to user-1's records.
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [
        { id: 'doc-1', body: { path: 'value', value: 'updated' } },
        { id: 'doc-2', body: { path: 'value', value: 'updated' } },
      ],
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: 'user-1' } }] } },
    };

    const validate = await route._validate(req, {});

    const doc1Update = validate.find((u) => u.id === 'doc-1');
    const doc2Update = validate.find((u) => u.id === 'doc-2');
    assert.strictEqual(doc1Update.validation, true);
    assert.notStrictEqual(doc2Update.validation, true);

    await route._exec(req, {}, validate);

    assert.strictEqual(docs.find((d) => d.id === 'doc-1').value, 'updated');
    assert.strictEqual(
      docs.find((d) => d.id === 'doc-2').value,
      'original',
      'entity outside the access-control scope must not be updated by _exec, even though it was included in the batch',
    );
  });
});
