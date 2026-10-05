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

import FilterInstance, { Filter as FilterClass } from '../../../../dist/access-control/filter.js';
import { createSchemaModel } from '../../../schema-model.js';

const Filter = FilterInstance;

describe('access-control/filter:convertQueryPrefixOperators', () => {
  it('should convert @eq to $eq', () => {
    const result = FilterClass.convertQueryPrefixOperators({ age: { '@eq': 18 } });
    assert.deepStrictEqual(result, { age: { $eq: 18 } });
  });

  it('should convert @in to $in', () => {
    const result = FilterClass.convertQueryPrefixOperators({ role: { '@in': ['admin', 'user'] } });
    assert.deepStrictEqual(result, { role: { $in: ['admin', 'user'] } });
  });

  it('should convert @and to $and', () => {
    const result = FilterClass.convertQueryPrefixOperators({ '@and': [{ age: { '@eq': 18 } }, { role: { '@eq': 'admin' } }] });
    assert.deepStrictEqual(result, { $and: [{ age: { $eq: 18 } }, { role: { $eq: 'admin' } }] });
  });

  it('should convert nested @ operators recursively', () => {
    const input = { '@or': [{ age: { '@gte': 18 } }, { parentConsent: { '@eq': true } }] };
    const expected = { $or: [{ age: { $gte: 18 } }, { parentConsent: { $eq: true } }] };
    assert.deepStrictEqual(FilterClass.convertQueryPrefixOperators(input), expected);
  });

  it('should handle non-object values', () => {
    assert.strictEqual(FilterClass.convertQueryPrefixOperators(null), null);
    assert.strictEqual(FilterClass.convertQueryPrefixOperators('string'), 'string');
    assert.strictEqual(FilterClass.convertQueryPrefixOperators(42), 42);
  });

  it('should handle arrays', () => {
    const result = FilterClass.convertQueryPrefixOperators([{ '@eq': 'a' }, { '@eq': 'b' }]);
    assert.deepStrictEqual(result, [{ $eq: 'a' }, { $eq: 'b' }]);
  });
});

describe('access-control/filter:mergeQueryFilters', () => {
  it('should merge two filters with AND operator', () => {
    const filter1 = { age: { $gt: 18 } };
    const filter2 = { country: 'USA' };
    const mergedFilter = Filter.mergeQueryFilters(filter1, filter2);
    assert.deepStrictEqual(mergedFilter, { $and: [filter1, filter2] });
  });

  it('should merge two filters with OR operator', () => {
    const filter1 = { age: { $gt: 18 } };
    const filter2 = { country: 'USA' };
    const mergedFilter = Filter.mergeQueryFilters(filter1, filter2, '$or');
    assert.deepStrictEqual(mergedFilter, { $or: [filter1, filter2] });
  });

  it('should handle merging with existing AND operator', () => {
    const filter1 = { $and: [{ age: { $gt: 18 } }, { country: 'USA' }] };
    const filter2 = { city: 'New York' };
    const mergedFilter = Filter.mergeQueryFilters(filter1, filter2);
    assert.deepStrictEqual(mergedFilter, { $and: [...filter1.$and, filter2] });
  });

  it('should handle merging with existing OR operator', () => {
    const filter1 = { $or: [{ age: { $gt: 18 } }, { country: 'USA' }] };
    const filter2 = { city: 'New York' };
    const mergedFilter = Filter.mergeQueryFilters(filter1, filter2, '$or');
    assert.deepStrictEqual(mergedFilter, { $or: [...filter1.$or, filter2] });
  });

  it('should return the first filter if the second filter is empty', () => {
    const filter1 = { age: { $gt: 18 } };
    const filter2 = {};
    const mergedFilter = Filter.mergeQueryFilters(filter1, filter2);
    assert.deepStrictEqual(mergedFilter, filter1);
  });

  it('should return the second filter if the first filter is empty', () => {
    const filter1 = {};
    const filter2 = { country: 'USA' };
    const mergedFilter = Filter.mergeQueryFilters(filter1, filter2);
    assert.deepStrictEqual(mergedFilter, filter2);
  });

  it('should return an empty object if both filters are empty', () => {
    const filter1 = {};
    const filter2 = {};
    const mergedFilter = Filter.mergeQueryFilters(filter1, filter2);
    assert.deepStrictEqual(mergedFilter, {});
  });

  it('should throw an error if the operator is invalid', () => {
    assert.throws(() => {
      Filter.mergeQueryFilters({ age: { $gt: 18 } }, { country: 'USA' }, '$invalidOperator');
    }, {
      name: 'Error',
      message: "Operator must be either '$and' or '$or'.",
    });
  });

  it('should throw if baseFilter is not provided', () => {
    assert.throws(() => {
      Filter.mergeQueryFilters(null, { country: 'USA' });
    }, { message: 'Both baseFilter and additionalFilter must be provided.' });
  });

  it('should throw if additionalFilter is not provided', () => {
    assert.throws(() => {
      Filter.mergeQueryFilters({ age: { $gt: 18 } }, null);
    }, { message: 'Both baseFilter and additionalFilter must be provided.' });
  });
});

describe('access-control/filter:mergeQueryFilters keeps every key', () => {
  it("keeps the other keys of a filter that has the operator as well", () => {
    const withAnd = { $and: [{ age: { $gt: 18 } }], ownerId: 'owner-1' };
    const withOr = { $or: [{ role: 'admin' }, { role: 'editor' }], tenant: 'tenant-1' };
    const other = { city: 'New York' };

    assert.deepStrictEqual(Filter.mergeQueryFilters(withAnd, other), { $and: [withAnd, other] });
    assert.deepStrictEqual(Filter.mergeQueryFilters(other, withAnd), { $and: [other, withAnd] });
    assert.deepStrictEqual(Filter.mergeQueryFilters(withOr, other, '$or'), { $or: [withOr, other] });
    assert.deepStrictEqual(Filter.mergeQueryFilters(other, withOr, '$or'), { $or: [other, withOr] });
  });
});

describe('access-control/filter:buildPolicyQuery env references that are not set', () => {
  const env = { date: { now: '2025-06-01T00:00:00.000Z' }, user: null, appId: 'app-1', ownerId: 'owner-1' };

  it('refuses a query whose #env reference is not set', async () => {
    for (const query of [
      { ownerId: '#env.user.id' },
      { ownerId: { '@eq': '#env.user.id' } },
      { $and: [{ ownerId: '#env.misspelt' }] },
      { $or: [{ ownerId: '#env.ownerId' }, { editorId: { '@eq': '#env.user.id' } }] },
    ]) {
      await assert.rejects(Filter.buildPolicyQuery(query, env), /unresolved_policy_env: #env\./, JSON.stringify(query));
    }
  });

  it('builds a query whose #env references are set, even to null', async () => {
    assert.deepStrictEqual(await Filter.buildPolicyQuery({ ownerId: '#env.ownerId' }, env), { ownerId: 'owner-1' });
    assert.deepStrictEqual(await Filter.buildPolicyQuery({ userId: { '@eq': '#env.user' } }, env), {
      userId: { $eq: null },
    });
  });
});

describe('access-control/filter:mergeQueryFiltersWithAccessControl', () => {
  it('should merge request query with access control query using $and', () => {
    const reqQuery = { age: { $gt: 18 } };
    const acQuery = { country: 'USA' };
    const merged = Filter.mergeQueryFiltersWithAccessControl(reqQuery, acQuery);
    assert.deepStrictEqual(merged, { $and: [reqQuery, acQuery] });
  });
});

describe('access-control/filter:buildPolicyQuery', () => {
  const emptyEnv = { date: { now: '2025-06-01T00:00:00.000Z' } };

  it('should return null for null query', async () => {
    const result = await Filter.buildPolicyQuery(null, emptyEnv);
    assert.strictEqual(result, null);
  });

  it('should pass through a basic query unchanged', async () => {
    const result = await Filter.buildPolicyQuery({ userId: '12345' }, emptyEnv, false);
    assert.deepStrictEqual(result, { userId: '12345' });
  });

  it('should replace #env variables with values', async () => {
    const env = { ...emptyEnv, test: 'ABC' };
    const result = await Filter.buildPolicyQuery({ userId: '#env.test' }, env, false);
    assert.deepStrictEqual(result, { userId: 'ABC' });
  });

  it('should handle $and and $or operators with env replacement', async () => {
    const env = { ...emptyEnv, test: 'ABC', test2: 'CBA' };
    const result = await Filter.buildPolicyQuery(
      { $and: [{ userId: '#env.test' }, { $or: [{ test: '#env.test2' }] }] },
      env,
      false,
    );
    assert.deepStrictEqual(result, { $and: [{ userId: 'ABC' }, { $or: [{ test: 'CBA' }] }] });
  });

  it('should strip access key when value is %FULL_ACCESS%', async () => {
    const env = { ...emptyEnv };
    const result = await Filter.buildPolicyQuery({ access: '%FULL_ACCESS%', userId: '123' }, env);
    assert.deepStrictEqual(result, { userId: '123' });
  });

  it('should strip access key when value is %APP_SCHEMA%', async () => {
    const env = { ...emptyEnv };
    const result = await Filter.buildPolicyQuery({ access: '%APP_SCHEMA%', userId: '123' }, env);
    assert.deepStrictEqual(result, { userId: '123' });
  });

  it('should strip access key when value is %CORE_SCHEMA%', async () => {
    const env = { ...emptyEnv };
    const result = await Filter.buildPolicyQuery({ access: '%CORE_SCHEMA%', userId: '123' }, env);
    assert.deepStrictEqual(result, { userId: '123' });
  });

  it('should convert @ query prefixes to $', async () => {
    const env = { ...emptyEnv };
    const result = await Filter.buildPolicyQuery({ age: { '@gt': 18 } }, env, false);
    assert.deepStrictEqual(result, { age: { $gt: 18 } });
  });

  it('should handle deeply nested env references in operators', async () => {
    const env = { ...emptyEnv, minAge: 21 };
    const result = await Filter.buildPolicyQuery({ age: { '@gte': '#env.minAge' } }, env, false);
    assert.deepStrictEqual(result, { age: { $gte: 21 } });
  });

  it('should handle empty query objects', async () => {
    const env = { ...emptyEnv };
    const result = await Filter.buildPolicyQuery({}, env, false);
    assert.deepStrictEqual(result, {});
  });

  it('should convert @ and keep $ prefixes as-is', async () => {
    const env = { ...emptyEnv };
    const result = await Filter.buildPolicyQuery({ age: { $gt: 18 } }, env, false);
    assert.deepStrictEqual(result, { age: { $gt: 18 } });
  });
});

// A model with no schema of its own, so its values are compared as given
const { model: untyped } = createSchemaModel({ name: 'untyped', properties: {} });

describe('access-control/filter:evaluateQueryAgainstEntity', () => {
  it('should return true for %FULL_ACCESS% query', () => {
    const result = Filter.evaluateQueryAgainstEntity({ access: '%FULL_ACCESS%' }, { name: 'test' }, untyped);
    assert.strictEqual(result, true);
  });

  it('should return true when entity matches simple $eq query', () => {
    const result = Filter.evaluateQueryAgainstEntity({ name: { $eq: 'test' } }, { name: 'test' }, untyped);
    assert.strictEqual(result, true);
  });

  it('should return false when entity does not match $eq query', () => {
    const result = Filter.evaluateQueryAgainstEntity({ name: { $eq: 'other' } }, { name: 'test' }, untyped);
    assert.strictEqual(result, false);
  });

  it('should return true when entity matches $and query', () => {
    const query = { $and: [{ age: { $gt: 18 } }, { country: { $eq: 'USA' } }] };
    const entity = { age: 25, country: 'USA' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity, untyped);
    assert.strictEqual(result, true);
  });

  it('should return false when entity fails $and query', () => {
    const query = { $and: [{ age: { $gt: 18 } }, { country: { $eq: 'USA' } }] };
    const entity = { age: 15, country: 'USA' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity, untyped);
    assert.strictEqual(result, false);
  });

  it('should return true when entity matches $or query', () => {
    const query = { $or: [{ age: { $gt: 18 } }, { role: { $eq: 'admin' } }] };
    const entity = { age: 15, role: 'admin' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity, untyped);
    assert.strictEqual(result, true);
  });

  it('should return false when entity fails $or query', () => {
    const query = { $or: [{ age: { $gt: 18 } }, { role: { $eq: 'admin' } }] };
    const entity = { age: 15, role: 'user' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity, untyped);
    assert.strictEqual(result, false);
  });

  it('should handle nested entity fields', () => {
    const entity = { address: { city: 'London' }, name: 'test' };
    const query = { 'address.city': { $eq: 'London' } };
    const result = Filter.evaluateQueryAgainstEntity(query, entity, untyped);
    assert.strictEqual(result, true);
  });

  it('should return false when query field is missing from entity', () => {
    const entity = { name: 'test' };
    const query = { missingField: { $eq: 'value' } };
    const result = Filter.evaluateQueryAgainstEntity(query, entity, untyped);
    assert.strictEqual(result, false);
  });
});

describe('access-control/filter:evaluateQueryAgainstEntity $or branches', () => {
  const query = {
    $or: [{ _teamId: { $eq: 'T1' }, visibility: { $eq: 'shared' } }, { _ownerId: { $eq: 'U1' } }],
  };

  it('needs every field of a branch to match, as MongoDB does', () => {
    assert.strictEqual(Filter.evaluateQueryAgainstEntity(query, { _teamId: 'T9', visibility: 'shared', _ownerId: 'U9' }, untyped), false);
    assert.strictEqual(Filter.evaluateQueryAgainstEntity(query, { _teamId: 'T1', visibility: 'private', _ownerId: 'U9' }, untyped), false);
  });

  it('matches when one branch matches in full', () => {
    assert.strictEqual(Filter.evaluateQueryAgainstEntity(query, { _teamId: 'T1', visibility: 'shared', _ownerId: 'U9' }, untyped), true);
    assert.strictEqual(Filter.evaluateQueryAgainstEntity(query, { _teamId: 'T9', visibility: 'private', _ownerId: 'U1' }, untyped), true);
  });
});

// Realtime reads an entity as a REST query would (D-31): the query parsed as REST parses it, and matched as MongoDB
// matches it (see test/e2e/access-control/operators.test.js)
describe('access-control/filter:evaluateQueryAgainstEntity as REST reads the entity', () => {
  const { model } = createSchemaModel({
    name: 'crate',
    properties: {
      name: { __type: 'string' },
      count: { __type: 'number' },
      at: { __type: 'date' },
      tags: { __type: 'array', __itemtype: 'string' },
      lines: { __type: 'array', __schema: { sku: { __type: 'string' }, qty: { __type: 'number' } } },
    },
  });
  const entity = { id: '6abd0b000000000000000001', name: 'Ada', count: 10, at: '2026-03-01T00:00:00.000Z', tags: ['a', 'b'], lines: [{ sku: 'X', qty: 7 }] };
  const reads = (query) => Filter.evaluateQueryAgainstEntity(query, entity, model);

  it('compares text exactly', () => {
    assert.strictEqual(reads({ name: { $eq: 'Ada' } }), true);
    assert.strictEqual(reads({ name: { $eq: 'ada' } }), false);
  });

  it('takes a bare value as the value to equal', () => {
    assert.strictEqual(reads({ name: 'Ada' }), true);
    assert.strictEqual(reads({ name: 'Bob' }), false);
  });

  it("matches an array field by any of its items", () => {
    assert.strictEqual(reads({ tags: 'b' }), true);
    assert.strictEqual(reads({ tags: { $in: ['a', 'z'] } }), true);
    assert.strictEqual(reads({ tags: { $nin: ['b'] } }), false);
  });

  it('reads $exists as whether the field is there', () => {
    assert.strictEqual(reads({ name: { $exists: true } }), true);
    assert.strictEqual(reads({ nothing: { $exists: false } }), true);
    assert.strictEqual(reads({ nothing: { $exists: true } }), false);
  });

  it("matches a field it hasn't got by $ne and $nin", () => {
    assert.strictEqual(reads({ nothing: { $ne: 'x' } }), true);
    assert.strictEqual(reads({ nothing: { $nin: ['x'] } }), true);
  });

  it('matches $elMatch and $inProp', () => {
    assert.strictEqual(reads({ lines: { $elMatch: { sku: 'X', qty: { $gt: 5 } } } }), true);
    assert.strictEqual(reads({ name: { $inProp: 'd' } }), true);
  });

  it('reads compared values and dates as their types', () => {
    assert.strictEqual(reads({ count: { $gt: '3' } }), true);
    assert.strictEqual(reads({ at: { $gtDate: '2026-01-01T00:00:00.000Z' } }), true);
    assert.strictEqual(reads({ at: { $ltDate: '2026-01-01T00:00:00.000Z' } }), false);
  });

  it("doesn't read the entity for a query that can't be read", () => {
    assert.strictEqual(reads({ count: { $gt: 'lots' } }), false);
  });
});
