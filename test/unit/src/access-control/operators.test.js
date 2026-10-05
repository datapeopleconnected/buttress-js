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

import { toMongoQuery } from '../../../../dist/access-control/operators.js';

// A Buttress query in MongoDB's terms, as the MongoDB adapter gives it MongoDB, and as realtime matches it
describe('access-control/operators:toMongoQuery', () => {
  const at = new Date('2025-01-01T00:00:00.000Z');

  it('gives each operator the name MongoDB gives it, with its options', () => {
    assert.deepStrictEqual(toMongoQuery({ name: { $rex: '^a' } }), { name: { $regex: '^a' } });
    assert.deepStrictEqual(toMongoQuery({ name: { $rexi: '^a' } }), { name: { $regex: '^a', $options: 'i' } });
    assert.deepStrictEqual(toMongoQuery({ age: { $not: 1 } }), { age: { $ne: 1 } });
    assert.deepStrictEqual(toMongoQuery({ at: { $gtDate: at, $lteDate: at } }), { at: { $gt: at, $lte: at } });
    assert.deepStrictEqual(toMongoQuery({ name: { '@eq': 'a' } }), { name: { $eq: 'a' } });
  });

  it('escapes the text $inProp looks for, so it is matched as the text it is', () => {
    assert.deepStrictEqual(toMongoQuery({ name: { $inProp: 'a.b(c' } }), { name: { $regex: 'a\\.b\\(c' } });
  });

  it('gives $elMatch as $elemMatch, and the query or operators in it in MongoDB\'s terms', () => {
    assert.deepStrictEqual(toMongoQuery({ lines: { $elMatch: { sku: { $rexi: 'x' }, at: { $gtDate: at } } } }), {
      lines: { $elemMatch: { sku: { $regex: 'x', $options: 'i' }, at: { $gt: at } } },
    });
    assert.deepStrictEqual(toMongoQuery({ scores: { $elMatch: { $gt: 3, $not: 5 } } }), {
      scores: { $elemMatch: { $gt: 3, $ne: 5 } },
    });
  });

  it('gives @and, @or and @nor as $and, $or and $nor, with the queries in them', () => {
    assert.deepStrictEqual(toMongoQuery({ '@or': [{ name: { $rex: 'a' } }], $nor: [{ '@and': [{ age: { $not: 1 } }] }] }), {
      $or: [{ name: { $regex: 'a' } }],
      $nor: [{ $and: [{ age: { $ne: 1 } }] }],
    });
  });

  it('leaves values as they are: a list, a date, an object of fields', () => {
    const query = { tags: ['a', 'b'], at, address: { city: 'Leeds' }, name: 'a' };
    assert.deepStrictEqual(toMongoQuery(query), query);
  });

  it("leaves a name the registry doesn't have as it is, for the datastore", () => {
    assert.deepStrictEqual(toMongoQuery({ name: { $regex: 'a', $options: 'i' } }), { name: { $regex: 'a', $options: 'i' } });
  });
});
