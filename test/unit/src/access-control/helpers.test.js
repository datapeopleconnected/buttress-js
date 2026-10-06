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

import { filterPolicyConfigs, CombineEnvGroups } from '../../../../dist/access-control/helpers.js';

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

  // SR-DPC-001 S21: a data sharing agreement's config could be stored with text there, which matched by its substrings
  it("should not return a config whose verbs or schema aren't lists", () => {
    const policy = makePolicy([
      { verbs: 'GET,PUT', schema: ['car'], query: {}, projection: null, condition: null },
      { verbs: ['GET'], schema: 'cars-and-vans', query: {}, projection: null, condition: null },
      { verbs: '%ALL%', schema: '%ALL%', query: {}, projection: null, condition: null },
    ]);

    for (const verb of ['GET', 'PUT']) {
      for (const schema of ['car', 'cars', 'van', 'vans']) {
        assert.deepStrictEqual(filterPolicyConfigs(policy, schema, verb, false), [], `${verb} ${schema}`);
      }
    }
    assert.deepStrictEqual(filterPolicyConfigs(policy, 'car', 'POST', false, true), []);
  });

  it('should match the items of verbs and schema exactly', () => {
    const policy = makePolicy([{ verbs: ['GET'], schema: ['cars-and-vans'], query: {}, projection: null, condition: null }]);

    assert.strictEqual(filterPolicyConfigs(policy, 'cars-and-vans', 'GET', false).length, 1);
    assert.strictEqual(filterPolicyConfigs(policy, 'car', 'GET', false).length, 0);
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
