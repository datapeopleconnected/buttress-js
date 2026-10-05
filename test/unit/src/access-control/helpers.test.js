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

import { filterPolicyConfigs, CombineEnvGroups, findPatternOccurrences, patternExists, containsTokenLevelRef } from '../../../../dist/access-control/helpers.js';

describe('access-control/helpers:CombineEnvGroups', () => {
  it('should combine req env with policy env and config env', () => {
    const reqEnv = { date: { now: '2025-01-01' }, user: null, ipAddress: null, appId: 'app1' };
    const policy = {
      id: 'p1',
      name: 'test',
      appId: 'app1',
      env: { location: 'UK' },
      config: { env: { role: 'admin' }, verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    };

    const result = CombineEnvGroups(policy, reqEnv);

    assert.strictEqual(result.date.now, '2025-01-01');
    assert.strictEqual(result.location, 'UK');
    assert.strictEqual(result.role, 'admin');
  });

  it('should handle null policy env', () => {
    const reqEnv = { date: { now: '2025-01-01' }, user: null, ipAddress: null, appId: 'app1' };
    const policy = {
      id: 'p1',
      name: 'test',
      appId: 'app1',
      env: null,
      config: { env: null, verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    };

    const result = CombineEnvGroups(policy, reqEnv);
    assert.deepStrictEqual(result, reqEnv);
  });

  it('should have policy.config.env override policy.env', () => {
    const reqEnv = { date: { now: '2025-01-01' }, user: null, ipAddress: null, appId: 'app1' };
    const policy = {
      id: 'p1',
      name: 'test',
      appId: 'app1',
      env: { role: 'user' },
      config: { env: { role: 'admin' }, verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    };

    const result = CombineEnvGroups(policy, reqEnv);
    assert.strictEqual(result.role, 'admin');
  });
});

describe('access-control/helpers:filterPolicyConfigs', () => {
  const makePolicy = (configs) => ({
    id: 'p1',
    name: 'test',
    appId: 'app1',
    priority: 1,
    selection: { test: { '@eq': 'basic' } },
    env: null,
    config: configs,
  });

  it('should return a matching config for exact verb and schema', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'user', 'GET', false);
    assert.strictEqual(result.length, 1);
  });

  it('should return a matching config for %ALL% verbs', () => {
    const policy = makePolicy([
      { verbs: ['%ALL%'], schema: ['user'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'user', 'DELETE', false);
    assert.strictEqual(result.length, 1);
  });

  it('should return a matching config for %ALL% schema', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['%ALL%'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'car', 'GET', false);
    assert.strictEqual(result.length, 1);
  });

  it('should return a matching config for %CORE_SCHEMA% on core schema', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['%CORE_SCHEMA%'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'user', 'GET', true);
    assert.strictEqual(result.length, 1);
  });

  it('should not return config for %CORE_SCHEMA% on app schema', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['%CORE_SCHEMA%'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'car', 'GET', false);
    assert.strictEqual(result.length, 0);
  });

  it('should return matching config for %APP_SCHEMA% on app schema', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['%APP_SCHEMA%'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'car', 'GET', false);
    assert.strictEqual(result.length, 1);
  });

  it('should not return config for non-matching verb', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'user', 'POST', false);
    assert.strictEqual(result.length, 0);
  });

  it('should not return config for non-matching schema', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'car', 'GET', false);
    assert.strictEqual(result.length, 0);
  });

  it('should filter out configs missing required properties', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['user'], query: null, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'user', 'GET', false);
    assert.strictEqual(result.length, 0);
  });

  it('should return multiple matching configs', () => {
    const policy = makePolicy([
      { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
      { verbs: ['POST'], schema: ['user'], query: {}, projection: null, condition: null },
      { verbs: ['GET'], schema: ['car'], query: {}, projection: null, condition: null },
    ]);

    const result = filterPolicyConfigs(policy, 'user', 'GET', false);
    assert.strictEqual(result.length, 1);
  });

  describe('QUERY and its old name SEARCH', () => {
    const configFor = (verbs) => makePolicy([{ verbs, schema: ['user'], query: {}, projection: null, condition: null }]);

    for (const [granted, requested] of [
      ['QUERY', 'QUERY'],
      ['SEARCH', 'SEARCH'],
      ['SEARCH', 'QUERY'],
      ['QUERY', 'SEARCH'],
    ]) {
      it(`should let a config granting ${granted} match a ${requested} request`, () => {
        assert.strictEqual(filterPolicyConfigs(configFor([granted]), 'user', requested, false).length, 1);
      });
    }

    it('should not let QUERY grant GET or POST', () => {
      assert.strictEqual(filterPolicyConfigs(configFor(['QUERY']), 'user', 'GET', false).length, 0);
      assert.strictEqual(filterPolicyConfigs(configFor(['QUERY']), 'user', 'POST', false).length, 0);
    });

    it('should not let GET grant QUERY', () => {
      assert.strictEqual(filterPolicyConfigs(configFor(['GET']), 'user', 'QUERY', false).length, 0);
    });
  });

  describe('verbCheckReadability', () => {
    it('should return config when readability check matches GET', () => {
      const policy = makePolicy([
        { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
      ]);

      const result = filterPolicyConfigs(policy, 'user', 'POST', true, true);
      assert.strictEqual(result.length, 1);
    });

    it('should return config when readability check matches SEARCH', () => {
      const policy = makePolicy([
        { verbs: ['SEARCH'], schema: ['user'], query: {}, projection: null, condition: null },
      ]);

      const result = filterPolicyConfigs(policy, 'user', 'DELETE', true, true);
      assert.strictEqual(result.length, 1);
    });

    it('should return config when readability check matches QUERY', () => {
      const policy = makePolicy([
        { verbs: ['QUERY'], schema: ['user'], query: {}, projection: null, condition: null },
      ]);

      const result = filterPolicyConfigs(policy, 'user', 'DELETE', true, true);
      assert.strictEqual(result.length, 1);
    });

    it('should not return config when readability check fails', () => {
      const policy = makePolicy([
        { verbs: ['POST'], schema: ['user'], query: {}, projection: null, condition: null },
      ]);

      const result = filterPolicyConfigs(policy, 'user', 'DELETE', true, true);
      assert.strictEqual(result.length, 0);
    });
  });
});

describe('access-control/helpers:findPatternOccurrences', () => {
  it('should find pattern in value strings', () => {
    const obj = { name: '#env.user.id' };
    const result = findPatternOccurrences(obj, '#env\\.');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].type, 'value');
    assert.strictEqual(result[0].value, '#env.user.id');
  });

  it('should find pattern in keys', () => {
    const obj = { '#env.user.id': 'value' };
    const result = findPatternOccurrences(obj, '#env\\.');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].type, 'key');
  });

  it('should find nested pattern occurrences', () => {
    const obj = { query: { userId: '#env.user.id' } };
    const result = findPatternOccurrences(obj, '#env\\.');
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].path, ['query', 'userId']);
  });

  it('should find occurrences in arrays', () => {
    const obj = { rules: ['#env.role', '#env.location'] };
    const result = findPatternOccurrences(obj, '#env\\.');
    assert.strictEqual(result.length, 2);
  });

  it('should return empty array when no pattern matches', () => {
    const obj = { name: 'hello' };
    const result = findPatternOccurrences(obj, '#env\\.');
    assert.strictEqual(result.length, 0);
  });

  it('should handle nested objects', () => {
    const obj = { a: { b: { c: '#env.deeply.nested' } } };
    const result = findPatternOccurrences(obj, '#env\\.');
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0].path, ['a', 'b', 'c']);
  });
});

describe('access-control/helpers:patternExists', () => {
  it('should return true when pattern exists in value', () => {
    const obj = { userId: '#env.user.id' };
    assert.strictEqual(patternExists(obj, '#env\\.'), true);
  });

  it('should return true when pattern exists in key', () => {
    const obj = { '#env.role': 'admin' };
    assert.strictEqual(patternExists(obj, '#env\\.'), true);
  });

  it('should return true for deeply nested pattern', () => {
    const obj = { a: { b: { c: '#env.deep' } } };
    assert.strictEqual(patternExists(obj, '#env\\.'), true);
  });

  it('should return false when pattern does not exist', () => {
    const obj = { name: 'hello' };
    assert.strictEqual(patternExists(obj, '#env\\.'), false);
  });

  it('should return true when pattern exists in array', () => {
    const obj = { list: ['#env.item1', 'plain'] };
    assert.strictEqual(patternExists(obj, '#env\\.'), true);
  });
});

describe('access-control/helpers:containsTokenLevelRef', () => {
  it('should return all false when no user token refs exist', () => {
    const policy = {
      id: 'p1',
      name: 'test',
      appId: 'app1',
      env: null,
      config: {
        env: null,
        query: { userId: '#env.date' },
        condition: { date: { '@gt': '#env.date.now' } },
        verbs: ['GET'],
        schema: ['user'],
        projection: null,
      },
    };

    const result = containsTokenLevelRef(policy);
    assert.strictEqual(result.env, false);
    assert.strictEqual(result.configEnv, false);
    assert.strictEqual(result.query, false);
    assert.strictEqual(result.condition, false);
  });

  it('should detect user token ref in query', () => {
    const policy = {
      id: 'p1',
      name: 'test',
      appId: 'app1',
      env: null,
      config: {
        env: null,
        query: { userId: '#env.user.id' },
        condition: null,
        verbs: ['GET'],
        schema: ['user'],
        projection: null,
      },
    };

    const result = containsTokenLevelRef(policy);
    assert.strictEqual(result.query, true);
  });
});
