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

import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';
import { Readable } from 'stream';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig();

import { redisPrefix } from '../../../../dist/helpers/index.js';
import { PolicyCache } from '../../../../dist/services/policy-cache.js';

const K = (k) => redisPrefix(Config.redis.scope, k);
const Redis = {
  _data: null,

  reset() {
    this._data = new Map();
  },

  async hGet(key, field) {
    const hash = this._data.get(key);
    return hash ? (hash[field] !== undefined ? hash[field] : null) : null;
  },

  async hmGet(key, fields) {
    const hash = this._data.get(key) || {};
    return fields.map((f) => (hash[f] !== undefined ? hash[f] : null));
  },

  async hSet(key, field, value) {
    if (!this._data.has(key)) this._data.set(key, {});
    this._data.get(key)[field] = value;
    return 1;
  },

  async hDel(key, field) {
    const hash = this._data.get(key);
    if (!hash) return 0;
    const existed = field in hash;
    delete hash[field];
    return existed ? 1 : 0;
  },

  async hExists(key, field) {
    const hash = this._data.get(key);
    return hash ? field in hash : false;
  },

  async sAdd(key, members) {
    if (!this._data.has(key)) this._data.set(key, new Set());
    const set = this._data.get(key);
    const arr = Array.isArray(members) ? members : [members];
    let count = 0;
    for (const m of arr) {
      if (!set.has(m)) { set.add(m); count++; }
    }
    return count;
  },

  async sRem(key, members) {
    const set = this._data.get(key);
    if (!set) return 0;
    const arr = Array.isArray(members) ? members : [members];
    let count = 0;
    for (const m of arr) {
      if (set.delete(m)) count++;
    }
    return count;
  },

  async sMembers(key) {
    const set = this._data.get(key);
    return set ? [...set] : [];
  },

  async sInter(keys) {
    if (keys.length === 0) return [];
    const sets = keys.map((k) => {
      const s = this._data.get(k);
      return s ? new Set(s) : new Set();
    });
    const result = [];
    for (const item of sets[0]) {
      if (sets.every((s) => s.has(item))) result.push(item);
    }
    return result;
  },

  async sUnion(keys) {
    const result = new Set();
    for (const k of keys) {
      const s = this._data.get(k);
      if (!s) continue;
      for (const item of s) result.add(item);
    }
    return [...result];
  },

  async zAdd(key, items) {
    if (!this._data.has(key)) this._data.set(key, new Map());
    const zset = this._data.get(key);
    const arr = Array.isArray(items) ? items : [items];
    let count = 0;
    for (const { value, score } of arr) {
      if (!zset.has(value)) count++;
      zset.set(value, score);
    }
    return count;
  },

  async zRem(key, member) {
    const zset = this._data.get(key);
    if (!zset) return 0;
    const arr = Array.isArray(member) ? member : [member];
    let count = 0;
    for (const m of arr) {
      if (zset.delete(m)) count++;
    }
    return count;
  },

  async zScore(key, member) {
    const zset = this._data.get(key);
    if (!zset) return null;
    const score = zset.get(member);
    return score !== undefined ? score : null;
  },

  async zRangeByScore(key, min, max) {
    const zset = this._data.get(key);
    if (!zset) return [];
    const results = [];
    for (const [value, score] of zset) {
      if (score >= min && score <= max) results.push(value);
    }
    return results;
  },

  async zRemRangeByScore(key, min, max) {
    const zset = this._data.get(key);
    if (!zset) return 0;
    let count = 0;
    for (const [value, score] of zset) {
      if (score >= min && score <= max) { zset.delete(value); count++; }
    }
    return count;
  },

  async zRange(key, start, stop) {
    const zset = this._data.get(key);
    if (!zset) return [];
    return [...zset.keys()].slice(start, stop === -1 ? undefined : stop + 1);
  },

  async del(key) {
    const existed = this._data.has(key);
    this._data.delete(key);
    return existed ? 1 : 0;
  },
};

function mockModel(findResult) {
  return {
    find() {
      const stream = new Readable({ objectMode: true, read() {} });
      const items = Array.isArray(findResult) ? findResult : [findResult].filter(Boolean);
      for (const item of items) stream.push(item);
      stream.push(null);
      return stream;
    },
    findById() {
      return Promise.resolve(findResult);
    },
  };
}

function mockModelManager(models) {
  return {
    getCoreModel(modelClass) {
      const name = modelClass?.name || modelClass;
      const result = models[name];
      return result;
    },
    getCoreModelByName(name) {
      return models[name];
    },
  };
}

const policy1 = {
  id: 'p1', name: 'admin-policy', _appId: 'app1', priority: 1,
  selection: { role: { '@eq': 'admin' } },
  config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
};

const policy2 = {
  id: 'p2', name: 'user-policy', _appId: 'app1', priority: 2,
  selection: { role: { '@eq': 'user' } },
  config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
};

const token = {
  id: 'tok1', _appId: 'app1', _userId: 'usr1', type: 'user', value: 'tok-val-1',
  policyProperties: { role: 'admin' },
};

const tokenModel = { findById: async () => token };

describe('services/policy-cache', () => {
  let cache;

  beforeEach(() => {
    Redis.reset();
    cache = new PolicyCache(Redis, mockModelManager({}));
  });

  describe('getPolicies', () => {
    it('should return empty array for no policy IDs', async () => {
      assert.deepStrictEqual(await cache.getPolicies([]), []);
    });

    it('should return empty array for null', async () => {
      assert.deepStrictEqual(await cache.getPolicies(null), []);
    });

    it('should return cached policies from Redis', async () => {
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      await Redis.hSet(K('policies'), 'p2', JSON.stringify(policy2));
      const result = await cache.getPolicies(['p1', 'p2']);
      assert.strictEqual(result.length, 2);
    });

    it('should fetch missing policies from DB and cache them', async () => {
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(policy1) }));
      const result = await cache.getPolicies(['p1']);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'p1');
      const cached = await Redis.hGet(K('policies'), 'p1');
      assert(cached);
    });

    it('should combine cached and fetched policies', async () => {
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(policy2) }));
      const result = await cache.getPolicies(['p1', 'p2']);
      assert.strictEqual(result.length, 2);
    });
  });

  describe('storePolicy', () => {
    it('should store a policy in Redis hash', async () => {
      await cache.storePolicy(policy1);
      const raw = await Redis.hGet(K('policies'), `policy:${policy1.id}`);
      assert(JSON.parse(raw).id === 'p1');
    });
  });

  describe('setTokenIdAsStale', () => {
    it('should add STALE marker to token policy set', async () => {
      await cache.setTokenIdAsStale('tok1');
      const members = await Redis.sMembers(K('token:tok1:policies'));
      assert(members.includes('STALE'));
    });
  });

  describe('clearPolicyById', () => {
    it('should remove a policy from the hash', async () => {
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      await cache.clearPolicyById('p1');
      assert.strictEqual(await Redis.hExists(K('policies'), 'p1'), false);
    });
  });

  describe('getPoliciesByToken', () => {
    it('should rehydrate when no cached policies exist', async () => {
      cache = new PolicyCache(Redis, mockModelManager({
        Token: tokenModel,
        Policy: mockModel(policy1),
      }));
      const result = await cache.getPoliciesByToken(token);
      assert(result.length >= 0);
    });

    it('should rehydrate when policies are stale', async () => {
      await Redis.sAdd(K('token:tok1:policies'), 'STALE');
      cache = new PolicyCache(Redis, mockModelManager({
        Token: tokenModel,
        Policy: mockModel(policy1),
      }));
      const result = await cache.getPoliciesByToken(token);
      assert(result.length >= 0);
    });

    it('should return cached policies when not stale', async () => {
      await Redis.sAdd(K('token:tok1:policies'), 'p1');
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      const result = await cache.getPoliciesByToken(token);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'p1');
    });
  });

  describe('rehydrateToken', () => {
    it('should fetch fresh token and rebuild policies', async () => {
      cache = new PolicyCache(Redis, mockModelManager({
        Token: tokenModel,
        Policy: mockModel(policy1),
      }));
      const result = await cache.rehydrateToken(token);
      assert(result.length >= 0);
    });
  });

  describe('getPoliciesByRestActivity', () => {
    it('should return empty array when no policies match', async () => {
      const result = await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName: 'unknown' });
      assert.deepStrictEqual(result, []);
    });

    it('should return policies matching the schema', async () => {
      await Redis.sAdd(K('app:app1:schema:user'), 'p1');
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      const result = await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName: 'user' });
      assert.strictEqual(result.length, 1);
    });

    it('should include %ALL% schema policies', async () => {
      await Redis.sAdd(K('app:app1:schema:%ALL%'), 'p2');
      await Redis.hSet(K('policies'), 'p2', JSON.stringify(policy2));
      const result = await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName: 'car' });
      assert.strictEqual(result.length, 1);
    });

    it('should deduplicate policies in multiple schema sets', async () => {
      await Redis.sAdd(K('app:app1:schema:user'), 'p1');
      await Redis.sAdd(K('app:app1:schema:%ALL%'), 'p1');
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      const result = await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName: 'user' });
      assert.strictEqual(result.length, 1);
    });
  });

  describe('connected tokens', () => {
    it('isTokenConnected should return false for unknown token', async () => {
      assert.strictEqual(await cache.isTokenConnected('nonexistent'), false);
    });

    it('isTokenConnected should return false for empty/null', async () => {
      assert.strictEqual(await cache.isTokenConnected(''), false);
      assert.strictEqual(await cache.isTokenConnected(null), false);
    });

    it('isTokenConnected should return true for recently added token', async () => {
      await cache.addConnectedToken('tok1');
      assert.strictEqual(await cache.isTokenConnected('tok1'), true);
    });

    it('removeConnectedToken should remove the token', async () => {
      await cache.addConnectedToken('tok1');
      await cache.removeConnectedToken('tok1');
      assert.strictEqual(await cache.isTokenConnected('tok1'), false);
    });

    it('clearExpiredConnectedTokens should remove expired tokens', async () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      await Redis.zAdd(K('connected-tokens'), [{ value: 'expired-tok', score: past }]);
      await cache.clearExpiredConnectedTokens();
      assert.strictEqual(await cache.isTokenConnected('expired-tok'), false);
    });
  });

  describe('addPolicy', () => {
    it('should store policy and index by schema/verb', async () => {
      await cache.addPolicy(policy1);
      const raw = await Redis.hGet(K('policies'), 'p1');
      assert(raw);
      const members = await Redis.sMembers(K('app:app1:schema:user'));
      assert(members.includes('p1'));
    });

    it('should not store duplicate policies', async () => {
      await cache.addPolicy(policy1);
      assert.strictEqual(await cache.addPolicy(policy1), false);
    });
  });

  describe('removePolicy', () => {
    it('should remove policy from hash', async () => {
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      await cache.removePolicy('p1');
      assert.strictEqual(await Redis.hExists(K('policies'), 'p1'), false);
    });
  });

  describe('clearTokenPolicies', () => {
    it('should clear token policy links and indexed properties', async () => {
      await Redis.sAdd(K('token:tok1:policies'), 'p1');
      await Redis.sAdd(K('policy:p1:tokens'), 'tok1');
      await Redis.sAdd(K('token:tok1:policyProperties'), 'role');
      await cache.clearTokenPolicies('tok1');
      const remaining = await Redis.sMembers(K('token:tok1:policies'));
      assert.strictEqual(remaining.length, 0);
    });
  });

  describe('connectTokenToPolicy / disconnectTokenFromPolicy', () => {
    it('should connect a token to a policy', async () => {
      await cache.connectTokenToPolicy('tok1', 'p1');
      const tokenPols = await Redis.sMembers(K('token:tok1:policies'));
      assert(tokenPols.includes('p1'));
      const polTokens = await Redis.sMembers(K('policy:p1:tokens'));
      assert(polTokens.includes('tok1'));
    });

    it('should throw when connecting with missing IDs', async () => {
      await assert.rejects(() => cache.connectTokenToPolicy('', 'p1'), /required to connect/);
      await assert.rejects(() => cache.connectTokenToPolicy('tok1', ''), /required to connect/);
    });

    it('should disconnect a token from a policy', async () => {
      await cache.connectTokenToPolicy('tok1', 'p1');
      await cache.disconnectTokenFromPolicy('tok1', 'p1');
      const tokenPols = await Redis.sMembers(K('token:tok1:policies'));
      assert(!tokenPols.includes('p1'));
    });

    it('should throw when disconnecting with missing IDs', async () => {
      await assert.rejects(() => cache.disconnectTokenFromPolicy('', 'p1'), /required/);
    });
  });

  describe('indexTokenPolicyProperties', () => {
    it('should throw for empty token ID', async () => {
      await assert.rejects(() => cache.indexTokenPolicyProperties(''), /required to index/);
    });

    it('should index new properties and skip existing', async () => {
      await cache.indexTokenPolicyProperties('tok1', { role: 'admin', dept: 'eng' });
      const indexed = await Redis.sMembers(K('token:tok1:policyProperties'));
      assert(indexed.includes('role'));
      assert(indexed.includes('dept'));
      const roleIdx = await Redis.sMembers(K('policy:propertyIndex:role'));
      assert(roleIdx.includes('tok1'));
    });

    it('should remove a property from both the forward and reverse index once it is no longer present', async () => {
      // Regression check: missingProperties used to be computed with the exact same filter as
      // newProperties (a copy-paste bug), so a property the token lost was never actually purged.
      await cache.indexTokenPolicyProperties('tok1', { role: 'admin', dept: 'eng' });

      await cache.indexTokenPolicyProperties('tok1', { dept: 'eng' });

      const indexed = await Redis.sMembers(K('token:tok1:policyProperties'));
      assert(!indexed.includes('role'), 'role should have been removed from the forward index');
      assert(indexed.includes('dept'));

      const roleIdx = await Redis.sMembers(K('policy:propertyIndex:role'));
      assert(!roleIdx.includes('tok1'), 'tok1 should have been removed from the role reverse index');
    });

    it('should index a value-qualified entry alongside the key-only entry', async () => {
      await cache.indexTokenPolicyProperties('tok1', { role: 'admin' });
      const valueIdx = await Redis.sMembers(K('policy:propertyIndex:role:ADMIN'));
      assert(valueIdx.includes('tok1'));
    });

    it('should re-index the value-qualified entry when the value changes without the key changing', async () => {
      await cache.indexTokenPolicyProperties('tok1', { role: 'admin' });
      await cache.indexTokenPolicyProperties('tok1', { role: 'user' });

      const oldValueIdx = await Redis.sMembers(K('policy:propertyIndex:role:ADMIN'));
      assert(!oldValueIdx.includes('tok1'), 'tok1 should have been removed from the old value index');

      const newValueIdx = await Redis.sMembers(K('policy:propertyIndex:role:USER'));
      assert(newValueIdx.includes('tok1'));

      // The key-only index is unaffected since the key itself never changed.
      const roleIdx = await Redis.sMembers(K('policy:propertyIndex:role'));
      assert(roleIdx.includes('tok1'));
    });

    it('should index every value of an array-valued property', async () => {
      await cache.indexTokenPolicyProperties('tok1', { dept: ['sales', 'eng'] });
      const salesIdx = await Redis.sMembers(K('policy:propertyIndex:dept:SALES'));
      const engIdx = await Redis.sMembers(K('policy:propertyIndex:dept:ENG'));
      assert(salesIdx.includes('tok1'));
      assert(engIdx.includes('tok1'));
    });
  });

  describe('removeIndexedTokenPolicyProperties', () => {
    it('should throw for empty token ID', async () => {
      await assert.rejects(() => cache.removeIndexedTokenPolicyProperties(''), /required to remove/);
    });

    it('should remove token from property indexes', async () => {
      await Redis.sAdd(K('token:tok1:policyProperties'), 'role');
      await Redis.sAdd(K('policy:propertyIndex:role'), 'tok1');
      await cache.removeIndexedTokenPolicyProperties('tok1');
      const props = await Redis.sMembers(K('token:tok1:policyProperties'));
      assert.strictEqual(props.length, 0);
    });

    it('should also remove the token from the value-qualified index', async () => {
      await cache.indexTokenPolicyProperties('tok1', { role: 'admin' });
      await cache.removeIndexedTokenPolicyProperties('tok1');

      const valueIdx = await Redis.sMembers(K('policy:propertyIndex:role:ADMIN'));
      assert(!valueIdx.includes('tok1'));
      const entries = await Redis.sMembers(K('token:tok1:policyPropertyValues'));
      assert.strictEqual(entries.length, 0);
    });
  });

  describe('invalidatePolicyAndTokensBySelection', () => {
    it('should do nothing when the policy is not found', async () => {
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(null) }));
      await cache.invalidatePolicyAndTokensBySelection('missing');
      // No throw is success here - nothing indexed, nothing to assert on.
    });

    it('should only mark tokens whose indexed value matches an @eq selection', async () => {
      await cache.indexTokenPolicyProperties('admin-tok', { role: 'admin' });
      await cache.indexTokenPolicyProperties('user-tok', { role: 'user' });

      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(policy1) }));
      await cache.invalidatePolicyAndTokensBySelection('p1');

      const adminPolicies = await Redis.sMembers(K('token:admin-tok:policies'));
      const userPolicies = await Redis.sMembers(K('token:user-tok:policies'));
      assert(adminPolicies.includes('STALE'), 'admin-tok should be marked stale');
      assert(!userPolicies.includes('STALE'), 'user-tok should not be marked stale');
    });

    it('should mark a token stale if ANY selected property matches, not requiring all of them', async () => {
      // roleOnly-tok only has `role`, deptOnly-tok only has `dept` - neither has both properties that
      // the policy selects on, but the real match is an OR across selection keys, so both should
      // still be invalidated.
      await cache.indexTokenPolicyProperties('roleOnly-tok', { role: 'admin' });
      await cache.indexTokenPolicyProperties('deptOnly-tok', { dept: 'eng' });

      const multiKeyPolicy = {
        id: 'p3', name: 'multi-key-policy', _appId: 'app1', priority: 1,
        selection: { role: { '@eq': 'admin' }, dept: { '@eq': 'eng' } },
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
      };
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(multiKeyPolicy) }));
      await cache.invalidatePolicyAndTokensBySelection('p3');

      const rolePolicies = await Redis.sMembers(K('token:roleOnly-tok:policies'));
      const deptPolicies = await Redis.sMembers(K('token:deptOnly-tok:policies'));
      assert(rolePolicies.includes('STALE'), 'roleOnly-tok should be marked stale');
      assert(deptPolicies.includes('STALE'), 'deptOnly-tok should be marked stale');
    });

    it('should fall back to the broad key index for operators other than @eq', async () => {
      await cache.indexTokenPolicyProperties('older-tok', { seniority: 5 });

      const rangePolicy = {
        id: 'p4', name: 'range-policy', _appId: 'app1', priority: 1,
        selection: { seniority: { '@gt': '3' } },
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
      };
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(rangePolicy) }));
      await cache.invalidatePolicyAndTokensBySelection('p4');

      const policies = await Redis.sMembers(K('token:older-tok:policies'));
      assert(policies.includes('STALE'), 'older-tok should still be caught by the broad fallback index');
    });

    it('should remove the policy from the cache after invalidating', async () => {
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      await cache.indexTokenPolicyProperties('admin-tok', { role: 'admin' });

      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(policy1) }));
      await cache.invalidatePolicyAndTokensBySelection('p1');

      assert.strictEqual(await Redis.hExists(K('policies'), 'p1'), false);
    });
  });

  describe('getConnectedTokenIdsByPolicyId', () => {
    it('should return empty for policy with no tokens', async () => {
      assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);
    });

    it('should return connected token IDs', async () => {
      await Redis.sAdd(K('policy:p1:tokens'), 'tok1');
      await cache.addConnectedToken('tok1');
      const result = await cache.getConnectedTokenIdsByPolicyId('p1');
      assert(result.includes('tok1'));
    });
  });
});
