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

import AccessControlConditions from '../../../../dist/access-control/conditions.js';

describe('access-control/conditions:filterPoliciesByPolicyConditions', () => {
  const emptyEnv = { date: { now: '2025-06-01T00:00:00.000Z' }, user: null, ipAddress: null, appId: 'app1' };

  it('should return all policies when condition is null', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: null,
        config: { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
  });

  it('should return policy when condition key resolves to matching env value', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { location: 'UK' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '#env.location': { '@eq': 'UK' } },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
  });

  it('should filter out policy when condition value does not match env value', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { location: 'UK' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '#env.location': { '@eq': 'US' } },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 0);
  });

  it('should handle date-based conditions with @ltDate (condition value is before env date)', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: null,
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '#env.date.now': { '@ltDate': '2025-01-01' } },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
  });

  it('should filter out when date condition fails with @gtDate (condition value is before env date)', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: null,
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '#env.date.now': { '@gtDate': '2025-01-01' } },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 0);
  });

  it('should handle @and logical conditions where both must pass', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { location: 'UK', role: 'admin' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '@and': [{ '#env.location': { '@eq': 'UK' } }, { '#env.role': { '@eq': 'admin' } }] },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
  });

  it('should filter out when @and condition partially fails', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { location: 'UK', role: 'user' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '@and': [{ '#env.location': { '@eq': 'UK' } }, { '#env.role': { '@eq': 'admin' } }] },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 0);
  });

  it('should pass when a condition object mixes an @and block with a sibling plain field, both satisfied', async () => {
    // Regression check: the sibling field used to make __checkCondition re-iterate every key
    // (including '@and') on each outer-loop pass, injecting a spurious `false` and failing
    // the whole condition even though every individual piece was actually satisfied.
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { location: 'UK' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: {
            '@and': [{ '#env.location': { '@eq': 'UK' } }],
            '#env.appId': { '@eq': 'app1' },
          },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
  });

  it('should handle @or logical conditions where one must pass', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { role: 'user' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '@or': [{ '#env.role': { '@eq': 'admin' } }, { '#env.role': { '@eq': 'user' } }] },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
  });

  it('should filter out when @or fully fails', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { role: 'guest' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '@or': [{ '#env.role': { '@eq': 'admin' } }, { '#env.role': { '@eq': 'user' } }] },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 0);
  });

  it('should throw on invalid operator', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { location: 'UK' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: { '#env.location': { '@invalidOp': 'UK' } },
        },
      },
    ];

    await assert.rejects(
      () => AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv),
      { message: /Invalid policy condition operator/ },
    );
  });

  it('should handle nested @and within @or', async () => {
    const policies = [
      {
        id: 'p1', name: 'test', appId: 'app1', env: { role: 'admin', location: 'UK' },
        config: {
          verbs: ['GET'], schema: ['user'], query: {}, projection: null,
          condition: {
            '@or': [
              { '@and': [{ '#env.role': { '@eq': 'admin' } }, { '#env.location': { '@eq': 'UK' } }] },
              { '#env.role': { '@eq': 'superadmin' } },
            ],
          },
        },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
  });

  it('should handle multiple policies - pass some and filter others', async () => {
    const policies = [
      {
        id: 'p1', name: 'pass', appId: 'app1', env: { role: 'admin' },
        config: { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: { '#env.role': { '@eq': 'admin' } } },
      },
      {
        id: 'p2', name: 'fail', appId: 'app1', env: { role: 'user' },
        config: { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: { '#env.role': { '@eq': 'admin' } } },
      },
    ];

    const result = await AccessControlConditions.filterPoliciesByPolicyConditions(policies, emptyEnv);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, 'pass');
  });
});

describe('access-control/conditions:isPolicyDateTimeBased', () => {
  it('should return the date field name when key is "date" with end range operator', async () => {
    const condition = { date: { '@gt': '2025-01-01' } };
    const result = await AccessControlConditions.isPolicyDateTimeBased(condition);
    assert.strictEqual(result, 'date');
  });

  it('should return the time field name when key is "time" with end range operator', async () => {
    const condition = { time: { '@gt': '14:00' } };
    const result = await AccessControlConditions.isPolicyDateTimeBased(condition);
    assert.strictEqual(result, 'time');
  });

  it('should return false for non-date/time conditions', async () => {
    const condition = { '#env.role': { '@eq': 'admin' } };
    const result = await AccessControlConditions.isPolicyDateTimeBased(condition);
    assert.strictEqual(result, false);
  });

  it('should return false for conditions without end range operators (@eq is not an end range)', async () => {
    const condition = { date: { '@eq': '2025-01-01' } };
    const result = await AccessControlConditions.isPolicyDateTimeBased(condition);
    assert.strictEqual(result, false);
  });

  it('should return false when operator is @lte (not in conditionEndRange)', async () => {
    const condition = { date: { '@lte': '2025-01-01' } };
    const result = await AccessControlConditions.isPolicyDateTimeBased(condition);
    assert.strictEqual(result, false);
  });
});

describe('access-control/conditions:isPolicyQueryBasedCondition', () => {
  it('should return false when no schema names match', async () => {
    const condition = { '#env.role': { '@eq': 'admin' } };
    const result = await AccessControlConditions.isPolicyQueryBasedCondition(condition, ['user', 'car']);
    assert.strictEqual(result, undefined);
  });
});
