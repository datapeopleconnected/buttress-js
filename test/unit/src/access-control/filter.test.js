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

import Filter from '../../../../dist/access-control/filter.js';

describe('access-control/filter', () => {
  describe('mergeQueryFilters', () => {
    // These tests should cover merging mongoDB query filters.

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
      const filter1 = { age: { $gt: 18 } };
      const filter2 = { country: 'USA' };
      assert.throws(() => {
        Filter.mergeQueryFilters(filter1, filter2, '$invalidOperator');
      }, {
        name: 'Error',
        message: `Operator must be either '$and' or '$or'.`
      });
    });
  });

  describe('mergeQueryFilters', () => {
    it('should combine two queries with the default (and)', async () => {
      const q1 = { "car": { "$eq": "blue" } };
      const q2 = { "car": { "$eq": "red" } };
      const mergedFilter = await Filter.mergeQueryFilters(q1, q2);
      assert.deepStrictEqual(mergedFilter, { $and: [q1, q2] });
    });

    it('should combine two queries with $or', async () => {
      const q1 = { "car": { "$eq": "blue" } };
      const q2 = { "car": { "$eq": "red" } };
      const mergedFilter = await Filter.mergeQueryFilters(q1, q2, '$or');
      assert.deepStrictEqual(mergedFilter, { $or: [q1, q2] });
    });

    it('should combine two queries with $and', async () => {
      const q1 = { "car": { "$eq": "blue" } };
      const q2 = { "car": { "$eq": "red" } };
      const mergedFilter = await Filter.mergeQueryFilters(q1, q2, '$and');
      assert.deepStrictEqual(mergedFilter, { $and: [q1, q2] });
    });

    it('should combine two queries with $and merging down an existing $and', async () => {
      const q1 = { $and: [{ "car": { "$eq": "blue" } }] };
      const q2 = { "car": { "$eq": "red" } };
      const mergedFilter = await Filter.mergeQueryFilters(q1, q2, '$and');
      assert.deepStrictEqual(mergedFilter, { $and: [q1.$and[0], q2] });
    });
  })

  describe('mergeQueryFiltersWithAccessControl', () => {
    it('should merge together two queries', async () => {
      const q1 = { "$and": [{ "userId": { "$eq": "a" } }] };
      const q2 = { "userId": { "userId": { "$eq": "b" } } };
      const mergedFilter = await Filter.mergeQueryFiltersWithAccessControl(q1, q2);
      assert.deepStrictEqual(mergedFilter, { $and: [q1.$and[0], q2] });
    });
  });

  describe('buildPolicyQuery', () => {
    it('should pass through a basic query', async () => {
      const result = await Filter.buildPolicyQuery({ userId: '12345' }, { }, false);
      assert.deepStrictEqual(result, { userId: '12345' });
    });

    it('should handle a query with a simple env query', async () => {
      const result = await Filter.buildPolicyQuery({ userId: '#env.test' }, { test: 'ABC' }, false);
      assert.deepStrictEqual(result, { userId: 'ABC' });
    });

    it('should handle a query with a $and or $or operators', async () => {
      const result = await Filter.buildPolicyQuery({ $and: [{ userId: '#env.test' }, { $or: [{ test: '#env.test2' }] }] }, { test: 'ABC', test2: 'CBA' }, false);
      assert.deepStrictEqual(result, { $and: [{ userId: 'ABC' }, { $or: [{ test: 'CBA' }] }] });
    });
  });
});