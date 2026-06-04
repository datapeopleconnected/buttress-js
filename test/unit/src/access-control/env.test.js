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

import AccessControlEnv from '../../../../dist/access-control/env.js';

describe('access-control/env:generateBaseGlobalEnvs', () => {
  it('should return an object with date.now', () => {
    const result = AccessControlEnv.generateBaseGlobalEnvs();
    assert(result.date);
    assert(typeof result.date.now === 'string');
    assert(!isNaN(Date.parse(result.date.now)));
  });
});

describe('access-control/env:generateRequestGlobalEnvs', () => {
  it('should return ACEnv with expected structure', () => {
    const result = AccessControlEnv.generateRequestGlobalEnvs(null, 'app123', null);
    assert.strictEqual(result.ipAddress, null);
    assert.strictEqual(result.user, null);
    assert.strictEqual(result.appId, 'app123');
    assert(result.date);
    assert(typeof result.date.now === 'string');
  });
});

describe('access-control/env:getEnvValue', () => {
  it('should return the key unchanged if it does not start with #env.', async () => {
    const result = await AccessControlEnv.getEnvValue('plainKey', {});
    assert.strictEqual(result, 'plainKey');
  });

  it('should return the key unchanged if key is not a string', async () => {
    const result = await AccessControlEnv.getEnvValue(42, {});
    assert.strictEqual(result, 42);
  });

  it('should return the key unchanged if key is null/undefined', async () => {
    const result = await AccessControlEnv.getEnvValue(null, {});
    assert.strictEqual(result, null);
  });

  it('should resolve a simple #env path', async () => {
    const envVars = { user: { id: 'abc123' } };
    const result = await AccessControlEnv.getEnvValue('#env.user.id', envVars);
    assert.strictEqual(result, 'abc123');
  });

  it('should resolve a top-level #env path', async () => {
    const envVars = { userId: 'abc123' };
    const result = await AccessControlEnv.getEnvValue('#env.userId', envVars);
    assert.strictEqual(result, 'abc123');
  });

  it('should return undefined for missing path', async () => {
    const envVars = { user: { name: 'test' } };
    const result = await AccessControlEnv.getEnvValue('#env.user.id', envVars);
    assert.strictEqual(result, undefined);
  });

  it('should resolve date.now', async () => {
    const envVars = { date: { now: '2025-06-01T00:00:00.000Z' } };
    const result = await AccessControlEnv.getEnvValue('#env.date.now', envVars);
    assert.strictEqual(result, '2025-06-01T00:00:00.000Z');
  });

  it('should handle chained env references (value starts with #env.)', async () => {
    const envVars = { base: '#env.actual', actual: 'realValue' };
    const result = await AccessControlEnv.getEnvValue('#env.base', envVars);
    assert.strictEqual(result, 'realValue');
  });
});

describe('access-control/env:__findPaths', () => {
  it('should return paths for nested object values', () => {
    const obj = { a: { b: 'value' } };
    const paths = AccessControlEnv.__findPaths(obj);
    assert.deepStrictEqual(paths, [['a', 'b']]);
  });

  it('should return paths for array elements', () => {
    const obj = { items: ['a', 'b'] };
    const paths = AccessControlEnv.__findPaths(obj);
    assert.deepStrictEqual(paths, [['items', 0], ['items', 1]]);
  });

  it('should return an array with empty path for non-object (leaf value)', () => {
    const paths = AccessControlEnv.__findPaths('string');
    assert.deepStrictEqual(paths, [[]]);
  });
});

describe('access-control/env:__setObjectValueByPath', () => {
  it('should set a nested value by path', () => {
    const obj = { a: { b: 'old' } };
    AccessControlEnv.__setObjectValueByPath(obj, ['a', 'b'], 'new');
    assert.strictEqual(obj.a.b, 'new');
  });
});

describe('access-control/env:__getClientIpFromXForwardedFor', () => {
  it('should extract first valid IPv4 from X-Forwarded-For', () => {
    const result = AccessControlEnv.__getClientIpFromXForwardedFor('192.168.1.1, 10.0.0.1');
    assert.strictEqual(result, '192.168.1.1');
  });

  it('should handle IPv4 with port', () => {
    const result = AccessControlEnv.__getClientIpFromXForwardedFor('192.168.1.1:8080, 10.0.0.1');
    assert.strictEqual(result, '192.168.1.1');
  });

  it('should handle IPv6 addresses', () => {
    const result = AccessControlEnv.__getClientIpFromXForwardedFor('::1');
    assert.strictEqual(result, '::1');
  });

  it('should return undefined for unknown format', () => {
    const result = AccessControlEnv.__getClientIpFromXForwardedFor('not-an-ip');
    assert.strictEqual(result, undefined);
  });
});
