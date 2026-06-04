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

describe('access-control/filter:evaluateQueryAgainstEntity', () => {
  it('should return true for %FULL_ACCESS% query', () => {
    const result = Filter.evaluateQueryAgainstEntity({ access: '%FULL_ACCESS%' }, { name: 'test' });
    assert.strictEqual(result, true);
  });

  it('should return true when entity matches simple $eq query', () => {
    const result = Filter.evaluateQueryAgainstEntity({ name: { $eq: 'test' } }, { name: 'test' });
    assert.strictEqual(result, true);
  });

  it('should return false when entity does not match $eq query', () => {
    const result = Filter.evaluateQueryAgainstEntity({ name: { $eq: 'other' } }, { name: 'test' });
    assert.strictEqual(result, false);
  });

  it('should return true when entity matches $and query', () => {
    const query = { $and: [{ age: { $gt: 18 } }, { country: { $eq: 'USA' } }] };
    const entity = { age: 25, country: 'USA' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity);
    assert.strictEqual(result, true);
  });

  it('should return false when entity fails $and query', () => {
    const query = { $and: [{ age: { $gt: 18 } }, { country: { $eq: 'USA' } }] };
    const entity = { age: 15, country: 'USA' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity);
    assert.strictEqual(result, false);
  });

  it('should return true when entity matches $or query', () => {
    const query = { $or: [{ age: { $gt: 18 } }, { role: { $eq: 'admin' } }] };
    const entity = { age: 15, role: 'admin' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity);
    assert.strictEqual(result, true);
  });

  it('should return false when entity fails $or query', () => {
    const query = { $or: [{ age: { $gt: 18 } }, { role: { $eq: 'admin' } }] };
    const entity = { age: 15, role: 'user' };
    const result = Filter.evaluateQueryAgainstEntity(query, entity);
    assert.strictEqual(result, false);
  });

  it('should handle nested/flattened entity fields', () => {
    const entity = { 'address.city': 'London', name: 'test' };
    const query = { 'address.city': { $eq: 'London' } };
    const result = Filter.evaluateQueryAgainstEntity(query, entity);
    assert.strictEqual(result, true);
  });

  it('should return false when query field is missing from entity', () => {
    const entity = { name: 'test' };
    const query = { missingField: { $eq: 'value' } };
    const result = Filter.evaluateQueryAgainstEntity(query, entity);
    assert.strictEqual(result, false);
  });
});
