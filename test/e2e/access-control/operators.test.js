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

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { MongoClient } from 'mongodb';

import Config from '../../config.js';
import Datastore from '../../../dist/datastore/index.js';
import MongodbIds from '../../../dist/datastore/adapters/mongodb-ids.js';
import { sanitizeSchemaObject } from '../../../dist/model/shared.js';
import { Filter } from '../../../dist/access-control/filter.js';
import { matchQuery, asQueried, toMongoQuery } from '../../../dist/access-control/operators.js';
import { createSchemaModel } from '../../schema-model.js';

// The in-memory matcher realtime uses, checked against MongoDB itself: each query is parsed as REST parses it, run in
// MongoDB over documents stored as the adapter stores them, and matched in memory against the same documents as
// realtime has them, their JSON
const schema = {
  name: 'oracle',
  type: 'collection',
  properties: {
    name: { __type: 'string', __default: null },
    count: { __type: 'number', __default: null },
    active: { __type: 'boolean', __default: null },
    at: { __type: 'date', __default: null },
    owner: { __type: 'id', __default: null },
    tags: { __type: 'array', __itemtype: 'string' },
    scores: { __type: 'array', __itemtype: 'number' },
    lines: { __type: 'array', __schema: { sku: { __type: 'string', __default: null }, qty: { __type: 'number', __default: null } } },
    meta: { __type: 'object', __default: null },
    address: { city: { __type: 'string', __default: null } },
  },
};

const OWNER = '6abd01000000000000000001';
const OTHER_OWNER = '6abd01000000000000000002';
const id = (n) => `6abd0b00000000000000000${n}`;

// Stored as a create stores them: every property, with its default where it's left out
const documents = [
  { id: id(1), name: 'Ada', count: 3, active: true, at: '2026-01-01T00:00:00.000Z', owner: OWNER, tags: ['a', 'b'], scores: [1, 5],
    lines: [{ sku: 'X', qty: 2 }, { sku: 'Y', qty: 7 }], meta: { level: 2, parts: [{ n: 1 }, { m: 2 }] }, address: { city: 'Leeds' } },
  { id: id(2), name: 'bob', count: 10, active: false, at: '2026-06-01T00:00:00.000Z', owner: OTHER_OWNER, tags: ['b'], scores: [],
    lines: [{ sku: 'Y', qty: 1 }], meta: null, address: { city: 'York' } },
  { id: id(3), name: 'Cy', count: null, active: null, at: null, owner: null, tags: [], scores: [10],
    lines: [], meta: {}, address: { city: null } },
  { id: id(4), name: 'ada', count: 3.5, active: true, at: '2025-12-31T23:59:59.000Z', owner: OWNER, tags: ['c'], scores: [3, 4],
    lines: [{ sku: 'X', qty: 9 }], meta: { level: 5, parts: [1, 2] }, address: { city: 'leeds' } },
];

// Queries in the query DSL a policy or a search gives, before REST parses them
const QUERIES = [
  { name: 'Ada' },
  { name: { $eq: 'ada' } },
  { name: { $ne: 'Ada' } },
  { name: { $not: 'Ada' } },
  { name: { $in: ['Ada', 'bob'] } },
  { name: { $nin: ['Ada', 'bob'] } },
  { name: { $rex: '^a' } },
  { name: { $rexi: '^a' } },
  { name: { $inProp: 'd' } },
  // Escapes JavaScript and MongoDB read alike
  { name: { $rex: '^\\x41\\w' } },
  { name: { $rexi: '^a\\w{2}$' } },
  { name: { $rex: 'a\\b' } },
  { count: 3 },
  { count: { $gt: 3 } },
  { count: { $gte: 3 } },
  { count: { $lt: 10 } },
  { count: { $lte: 3.5 } },
  { count: { $gt: '3' } },
  { count: null },
  { count: { $ne: null } },
  { count: { $exists: true } },
  { nothing: { $exists: false } },
  { nothing: { $exists: true } },
  { nothing: null },
  { nothing: { $ne: 'x' } },
  { nothing: { $nin: ['x'] } },
  // Names an object has from Object.prototype, which no document has
  { constructor: { $exists: true } },
  { toString: { $exists: false } },
  { active: true },
  { active: 'true' },
  { active: { $ne: true } },
  { at: { $gtDate: '2026-01-01T00:00:00.000Z' } },
  { at: { $gteDate: '2026-01-01T00:00:00.000Z' } },
  { at: { $ltDate: '2026-01-01T00:00:00.000Z' } },
  { at: { $lteDate: '2026-06-01T00:00:00.000Z' } },
  { at: null },
  { owner: OWNER },
  { owner: { $ne: OWNER } },
  { owner: { $in: [OWNER, OTHER_OWNER] } },
  { owner: null },
  { tags: 'b' },
  { tags: { $in: ['a', 'c'] } },
  // A list holding '.', which was read as an env path
  { tags: { $in: ['.', 'c'] } },
  { tags: { $nin: ['b'] } },
  { tags: { $all: ['a', 'b'] } },
  { tags: { $all: [] } },
  { scores: { $all: [] } },
  { tags: { $ne: 'b' } },
  { tags: ['a', 'b'] },
  { tags: [] },
  { scores: { $gt: 4 } },
  { scores: { $lt: 2 } },
  { scores: { $elMatch: { $gt: 3, $lt: 5 } } },
  // Read as the list's items, as outside $elMatch
  { scores: { $elMatch: { $gt: '3' } } },
  { 'lines.sku': 'Y' },
  { 'lines.qty': { $gte: 7 } },
  { lines: { $elMatch: { sku: 'X', qty: { $gt: 5 } } } },
  { lines: { $elMatch: { sku: 'Y', qty: { $gt: 5 } } } },
  { lines: { $elMatch: { $or: [{ sku: 'Y' }, { qty: { $gt: 8 } }] } } },
  { lines: { $elMatch: { sku: 'X', $or: [{ qty: 2 }, { qty: 9 }] } } },
  { lines: { $elMatch: { $and: [{ sku: 'Y' }, { qty: { $lt: 5 } }] } } },
  { 'meta.level': { $gt: 1 } },
  // A field a document of an array hasn't got, an array's items that aren't documents, a value that isn't a document
  { 'meta.parts.n': null },
  { 'meta.parts.n': { $ne: null } },
  { 'meta.parts.n': { $exists: true } },
  { 'meta.parts.n': { $exists: false } },
  { 'meta.parts.1': null },
  { 'meta.level.x': null },
  { meta: null },
  { 'address.city': 'Leeds' },
  { 'address.city': { $rexi: 'LEE' } },
  { 'address.city': null },
  // An object of fields, compared whole
  { address: { city: 'Leeds' } },
  { meta: { level: 2 } },
  { meta: {} },
  { $or: [{ name: 'Ada' }, { count: 10 }] },
  { $and: [{ active: true }, { count: { $lt: 3.5 } }] },
  { $nor: [{ name: 'Ada' }, { name: 'bob' }] },
  { $and: [] },
  {},
];

describe('access-control/operators: matching as MongoDB does', () => {
  const ids = new MongodbIds();
  ids.setSchema(schema.properties);
  let model;
  let client;
  let collection;
  // The model's ids come from the core datastore, which the REST process makes when it starts
  let madeCore = false;

  before(async () => {
    if (!Datastore.getInstance('core')) {
      Datastore.createInstance({ connectionString: 'empty://buttressjs.com' }, true);
      madeCore = true;
    }
    ({ model } = createSchemaModel(schema));

    client = await MongoClient.connect(Config.datastore.connectionString);
    collection = client.db(`${Config.app.code}-test-oracle`).collection('oracle');
    await collection.deleteMany({});
    await collection.insertMany(documents.map((doc) => ids.toStored({ ...sanitizeSchemaObject(schema, doc), id: doc.id })));
  });
  after(async () => {
    await collection.drop();
    await client.close();
    if (madeCore) delete Datastore.datastores.core;
  });

  for (const query of QUERIES) {
    it(`matches ${JSON.stringify(query)} as MongoDB does`, async () => {
      // A Buttress query, read as REST reads it, then put in MongoDB's terms as the MongoDB adapter puts it
      const parsed = toMongoQuery(model.parseQuery(Filter.convertQueryPrefixOperators(query), {}, model.flatSchemaData));

      const stored = await collection.find(ids.toStored(parsed)).toArray();
      const expected = stored.map((doc) => ids.fromStored(doc).id).sort();

      // As realtime has an entity: as a response gives it
      const entities = (await collection.find({}).toArray()).map((doc) => JSON.parse(JSON.stringify(ids.fromStored(doc))));
      const matched = entities.filter((entity) => matchQuery(parsed, asQueried(entity, model.flatSchemaData))).map((e) => e.id).sort();

      assert.deepStrictEqual(matched, expected);
    });
  }

  // The text '3' read as the number the list holds, as it's read outside $elMatch, rather than compared as text
  it("reads an $elMatch's operands on a typed list as the list's items, finding what they find outside $elMatch", async () => {
    const find = async (query) => {
      const parsed = toMongoQuery(model.parseQuery(query, {}, model.flatSchemaData));
      return (await collection.find(ids.toStored(parsed)).toArray()).map((doc) => ids.fromStored(doc).id).sort();
    };

    const outside = await find({ scores: { $gt: '3' } });
    assert.deepStrictEqual(outside, [id(1), id(3), id(4)]);
    assert.deepStrictEqual(await find({ scores: { $elMatch: { $gt: '3' } } }), outside);
  });
});
