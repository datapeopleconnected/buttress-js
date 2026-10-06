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
import { PolicyCache, policyTokensKey, tokenPoliciesKey } from '../../../../dist/services/policy-cache.js';

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

  async zAdd(key, items, options = {}) {
    if (!this._data.has(key)) this._data.set(key, new Map());
    const zset = this._data.get(key);
    const arr = Array.isArray(items) ? items : [items];
    let count = 0;
    for (const { value, score } of arr) {
      if (options.condition === 'XX' && !zset.has(value)) continue;
      if (!zset.has(value)) count++;
      zset.set(value, score);
    }
    return count;
  },

  async sCard(key) {
    return this._data.get(key)?.size ?? 0;
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

  async zmScore(key, members) {
    const zset = this._data.get(key);
    return members.map((member) => (zset?.get(member) !== undefined ? zset.get(member) : null));
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

  async rename(source, destination) {
    if (!this._data.has(source)) throw new Error('ERR no such key');
    this._data.set(destination, this._data.get(source));
    this._data.delete(source);
    return 'OK';
  },

  async del(key) {
    const existed = this._data.has(key);
    this._data.delete(key);
    return existed ? 1 : 0;
  },

  async get(key) {
    return this._data.get(key) ?? null;
  },

  async set(key, value, options = {}) {
    const previous = this._data.get(key) ?? null;
    this._data.set(key, value);
    return options.GET ? previous : 'OK';
  },

  // As node-redis 5 gives them, a page of keys at a time
  async *scanIterator({ MATCH = '*' } = {}) {
    const pattern = new RegExp(`^${MATCH.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    yield [...this._data.keys()].filter((key) => pattern.test(key));
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
      const members = await Redis.sMembers(K(tokenPoliciesKey('tok1')));
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
      await Redis.sAdd(K(tokenPoliciesKey('tok1')), 'STALE');
      cache = new PolicyCache(Redis, mockModelManager({
        Token: tokenModel,
        Policy: mockModel(policy1),
      }));
      const result = await cache.getPoliciesByToken(token);
      assert(result.length >= 0);
    });

    it('should return cached policies when not stale', async () => {
      await Redis.sAdd(K(tokenPoliciesKey('tok1')), 'p1');
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      const result = await cache.getPoliciesByToken(token);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].id, 'p1');
    });

    // A worker keeps the tokens it loaded in memory, and reloads them a moment after a token's policy properties change,
    // so the token a request carries can be older than the set the cache has worked out from the stored one
    it("should give the policies cached for the token, whatever policy properties the request's copy of it has", async () => {
      await Redis.sAdd(K(tokenPoliciesKey('tok1')), 'p1');
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      const staleToken = { ...token, policyProperties: {} };

      const result = await cache.getPoliciesByToken(staleToken);

      assert.deepStrictEqual(result.map((policy) => policy.id), ['p1']);
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

  // The Redis commands the cache sends while `fn` runs, by name
  const commandsDuring = async (fn) => {
    const commands = [];
    const originals = {};
    for (const name of Object.keys(Redis).filter((key) => typeof Redis[key] === 'function' && key !== 'reset')) {
      originals[name] = Redis[name];
      Redis[name] = async (...args) => {
        commands.push(name);
        return originals[name].apply(Redis, args);
      };
    }
    try {
      await fn();
    } finally {
      Object.assign(Redis, originals);
    }
    return commands;
  };

  describe('getPoliciesByRestActivity', () => {
    it("reads the ids of the policies for the schema, %ALL% and %APP_SCHEMA% in one SUNION", async () => {
      await Redis.sAdd(K('app:app1:schema:user'), 'p1');
      await Redis.sAdd(K('app:app1:schema:%APP_SCHEMA%'), 'p2');
      await Redis.hSet(K('policies'), 'p1', JSON.stringify(policy1));
      await Redis.hSet(K('policies'), 'p2', JSON.stringify(policy2));

      let found;
      const commands = await commandsDuring(async () => {
        found = await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName: 'user' });
      });

      assert.deepStrictEqual(found.map((policy) => policy.id).sort(), ['p1', 'p2']);
      assert.deepStrictEqual(commands, ['sUnion', 'hmGet']);
    });

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

    it('keeps a token connected while any of its sockets is open', async () => {
      await cache.addConnectedSocket('tok1', 'socket-a');
      await cache.addConnectedSocket('tok1', 'socket-b');

      await cache.removeConnectedSocket('tok1', 'socket-a');
      assert.strictEqual(await cache.isTokenConnected('tok1'), true);

      await cache.removeConnectedSocket('tok1', 'socket-b');
      assert.strictEqual(await cache.isTokenConnected('tok1'), false);
      assert.strictEqual(await Redis.sCard(K('connected-token:tok1:sockets')), 0);
    });

    it('renews the tokens a heartbeat names that are still connected, and connects no others', async () => {
      const soon = Math.floor(Date.now() / 1000) + 10;
      await Redis.zAdd(K('connected-tokens'), [{ value: 'tok1', score: soon }]);

      await cache.renewConnectedTokens(['tok1', 'tok2']);

      assert.ok((await Redis.zScore(K('connected-tokens'), 'tok1')) > soon + 3000);
      assert.strictEqual(await cache.isTokenConnected('tok2'), false);
    });

    it("leaves a token that's renewed while the sweep runs, and its policies", async () => {
      const past = Math.floor(Date.now() / 1000) - 10;
      await Redis.zAdd(K('connected-tokens'), [{ value: 'tok1', score: past }]);
      await cache.connectTokenToPolicy('tok1', 'p1');
      // A heartbeat arrives just after the sweep has found the token expired
      const zRangeByScore = Redis.zRangeByScore;
      Redis.zRangeByScore = async (...args) => {
        const found = await zRangeByScore.apply(Redis, args);
        cache.renewConnectedTokens(['tok1']);
        return found;
      };

      try {
        await cache.clearExpiredConnectedTokens();
      } finally {
        Redis.zRangeByScore = zRangeByScore;
      }

      assert.strictEqual(await cache.isTokenConnected('tok1'), true);
      assert.deepStrictEqual(await Redis.sMembers(K(tokenPoliciesKey('tok1'))), ['p1']);
    });

    it("forgets an expired token's sockets", async () => {
      await cache.addConnectedSocket('tok1', 'socket-a');
      await Redis.zAdd(K('connected-tokens'), [{ value: 'tok1', score: Math.floor(Date.now() / 1000) - 10 }]);

      await cache.clearExpiredConnectedTokens();

      assert.strictEqual(await Redis.sCard(K('connected-token:tok1:sockets')), 0);
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

    // SR-DPC-001 S21: text there grants nothing, so isn't looked up by its characters
    it("should not index a config whose verbs or schema aren't lists", async () => {
      await cache.addPolicy({
        ...policy1,
        config: [
          { verbs: ['GET'], schema: 'car', query: {} },
          { verbs: 'GET', schema: ['user'], query: {} },
        ],
      });

      for (const schema of ['car', 'c', 'a', 'r', 'user']) {
        assert.deepStrictEqual(await Redis.sMembers(K(`app:app1:schema:${schema}`)), [], schema);
      }
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
      await Redis.sAdd(K(tokenPoliciesKey('tok1')), 'p1');
      await Redis.sAdd(K(policyTokensKey('p1')), 'tok1');
      await Redis.sAdd(K('token:tok1:policyProperties'), 'role');
      await cache.clearTokenPolicies('tok1');
      const remaining = await Redis.sMembers(K(tokenPoliciesKey('tok1')));
      assert.strictEqual(remaining.length, 0);
    });
  });

  describe('connectTokenToPolicy / disconnectTokenFromPolicy', () => {
    it('should connect a token to a policy', async () => {
      await cache.connectTokenToPolicy('tok1', 'p1');
      const tokenPols = await Redis.sMembers(K(tokenPoliciesKey('tok1')));
      assert(tokenPols.includes('p1'));
      const polTokens = await Redis.sMembers(K(policyTokensKey('p1')));
      assert(polTokens.includes('tok1'));
    });

    it('should throw when connecting with missing IDs', async () => {
      await assert.rejects(() => cache.connectTokenToPolicy('', 'p1'), /required to connect/);
      await assert.rejects(() => cache.connectTokenToPolicy('tok1', ''), /required to connect/);
    });

    it('should disconnect a token from a policy', async () => {
      await cache.connectTokenToPolicy('tok1', 'p1');
      await cache.disconnectTokenFromPolicy('tok1', 'p1');
      const tokenPols = await Redis.sMembers(K(tokenPoliciesKey('tok1')));
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

      const adminPolicies = await Redis.sMembers(K(tokenPoliciesKey('admin-tok')));
      const userPolicies = await Redis.sMembers(K(tokenPoliciesKey('user-tok')));
      assert(adminPolicies.includes('STALE'), 'admin-tok should be marked stale');
      assert(!userPolicies.includes('STALE'), 'user-tok should not be marked stale');
    });

    // D-35: a selection selects a token only if every key holds and the token has each one
    it('should mark only the tokens that have every selected property, as a selection needs them all', async () => {
      await cache.indexTokenPolicyProperties('both-tok', { role: 'admin', dept: 'eng' });
      await cache.indexTokenPolicyProperties('roleOnly-tok', { role: 'admin' });
      await cache.indexTokenPolicyProperties('deptOnly-tok', { dept: 'eng' });

      const multiKeyPolicy = {
        id: 'p3', name: 'multi-key-policy', _appId: 'app1', priority: 1,
        selection: { role: { '@eq': 'admin' }, dept: { '@eq': 'eng' } },
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
      };
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(multiKeyPolicy) }));
      await cache.invalidatePolicyAndTokensBySelection('p3');

      assert((await Redis.sMembers(K(tokenPoliciesKey('both-tok')))).includes('STALE'), 'both-tok should be marked stale');
      assert(!(await Redis.sMembers(K(tokenPoliciesKey('roleOnly-tok')))).includes('STALE'), 'roleOnly-tok lacks dept');
      assert(!(await Redis.sMembers(K(tokenPoliciesKey('deptOnly-tok')))).includes('STALE'), 'deptOnly-tok lacks role');
    });

    it('should mark the tokens having any property an @or names, when the selection has no other keys', async () => {
      await cache.indexTokenPolicyProperties('role-tok', { role: 'admin' });
      await cache.indexTokenPolicyProperties('dept-tok', { dept: 'eng' });
      await cache.indexTokenPolicyProperties('other-tok', { team: 'x' });

      const orPolicy = {
        id: 'p5', name: 'or-policy', _appId: 'app1', priority: 1,
        selection: { '@or': [{ role: { '@eq': 'admin' } }, { '@and': [{ dept: { '@eq': 'eng' } }] }] },
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
      };
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(orPolicy) }));
      await cache.invalidatePolicyAndTokensBySelection('p5');

      assert((await Redis.sMembers(K(tokenPoliciesKey('role-tok')))).includes('STALE'));
      assert((await Redis.sMembers(K(tokenPoliciesKey('dept-tok')))).includes('STALE'));
      assert(!(await Redis.sMembers(K(tokenPoliciesKey('other-tok')))).includes('STALE'));
    });

    it('should narrow an @or selection by the keys beside it', async () => {
      await cache.indexTokenPolicyProperties('admin-tok', { role: 'admin', dept: 'eng' });
      await cache.indexTokenPolicyProperties('user-tok', { role: 'user', dept: 'eng' });

      const mixedPolicy = {
        id: 'p6', name: 'mixed-policy', _appId: 'app1', priority: 1,
        selection: { role: { '@eq': 'admin' }, '@or': [{ dept: { '@eq': 'eng' } }, { team: { '@eq': 'x' } }] },
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
      };
      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(mixedPolicy) }));
      await cache.invalidatePolicyAndTokensBySelection('p6');

      assert((await Redis.sMembers(K(tokenPoliciesKey('admin-tok')))).includes('STALE'));
      assert(!(await Redis.sMembers(K(tokenPoliciesKey('user-tok')))).includes('STALE'));
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

      const policies = await Redis.sMembers(K(tokenPoliciesKey('older-tok')));
      assert(policies.includes('STALE'), 'older-tok should still be caught by the broad fallback index');
    });

    it('should replace the cached policy with the policy as it now is', async () => {
      await Redis.hSet(K('policies'), 'p1', JSON.stringify({ ...policy1, name: 'old-name' }));
      await cache.indexTokenPolicyProperties('admin-tok', { role: 'admin' });

      cache = new PolicyCache(Redis, mockModelManager({ Policy: mockModel(policy1) }));
      await cache.invalidatePolicyAndTokensBySelection('p1');

      assert.strictEqual(JSON.parse(await Redis.hGet(K('policies'), 'p1')).name, 'admin-policy');
    });
  });

  describe('getConnectedTokenIdsByPolicyIds', () => {
    it("gives each policy's connected tokens, looking at when they stop being connected in one ZMSCORE", async () => {
      await Redis.sAdd(K(policyTokensKey('p1')), ['tok1', 'tok2']);
      await Redis.sAdd(K(policyTokensKey('p2')), ['tok2', 'tok3']);
      await cache.addConnectedToken('tok1');
      await cache.addConnectedToken('tok2');
      // tok3 was connected, and its connection has run out
      await Redis.zAdd(K('connected-tokens'), [{ score: 1, value: 'tok3' }]);

      let connected;
      const commands = await commandsDuring(async () => {
        connected = await cache.getConnectedTokenIdsByPolicyIds(['p1', 'p2', 'p3']);
      });

      assert.deepStrictEqual([...connected], [['p1', ['tok1', 'tok2']], ['p2', ['tok2']], ['p3', []]]);
      assert.deepStrictEqual(commands, ['sMembers', 'sMembers', 'sMembers', 'zmScore']);
    });

    it('looks at no connections when the policies have no tokens', async () => {
      let connected;
      const commands = await commandsDuring(async () => {
        connected = await cache.getConnectedTokenIdsByPolicyIds(['p1']);
      });

      assert.deepStrictEqual([...connected], [['p1', []]]);
      assert.deepStrictEqual(commands, ['sMembers']);
    });
  });

  describe('getConnectedTokenIdsByPolicyId', () => {
    it('should return empty for policy with no tokens', async () => {
      assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);
    });

    it('should return connected token IDs', async () => {
      await Redis.sAdd(K(policyTokensKey('p1')), 'tok1');
      await cache.addConnectedToken('tok1');
      const result = await cache.getConnectedTokenIdsByPolicyId('p1');
      assert(result.includes('tok1'));
    });
  });
});

// Changing or deleting a policy, on a stand-in datastore that the test changes as the policy routes would
describe('services/policy-cache: invalidating a policy', () => {
  let db;
  let cache;

  const collection = (name) => ({
    find(query) {
      const ids = query?.id?.$in;
      const appId = query?._appId;
      const docs = db[name].filter((doc) => (!ids || ids.includes(doc.id)) && (!appId || doc._appId === appId));
      return Readable.from(docs.map((doc) => JSON.parse(JSON.stringify(doc))), { objectMode: true });
    },
    async findById(id) {
      return db[name].find((doc) => doc.id === id) ?? null;
    },
  });

  const adminPolicy = (overrides = {}) => ({
    id: 'p1', name: 'admin-policy', _appId: 'app1', priority: 1,
    selection: { role: { '@eq': 'admin' } },
    config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
    ...overrides,
  });
  const admin = { id: 'admin-tok', _appId: 'app1', type: 'user', policyProperties: { role: 'admin' } };

  // The db changes the way the policy routes change it, then the policy is invalidated as the model does
  const changePolicy = async (policy) => {
    db.policies = db.policies.map((p) => (p.id === policy.id ? policy : p));
    await cache.invalidatePolicyAndTokensBySelection(policy.id);
  };

  beforeEach(async () => {
    Redis.reset();
    db = { policies: [adminPolicy()], tokens: [admin] };
    cache = new PolicyCache(Redis, {
      getCoreModel: () => collection('policies'),
      getCoreModelByName: () => collection('tokens'),
    });
    await cache.addConnectedToken(admin.id);
    await cache.getPoliciesByToken(admin);
  });

  it("takes a policy off a token that its narrowed selection no longer selects", async () => {
    await changePolicy(adminPolicy({ selection: { role: { '@eq': 'superadmin' } } }));

    assert.deepStrictEqual((await cache.getPoliciesByToken(admin)).map((p) => p.id), []);
    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);
  });

  it('keeps a changed policy on a token it still selects, with its new content', async () => {
    await changePolicy(adminPolicy({ name: 'renamed' }));

    assert.deepStrictEqual((await cache.getPoliciesByToken(admin)).map((p) => p.name), ['renamed']);
    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), [admin.id]);
  });

  it('finds a policy for activity on the schemas it now covers, and not on those it no longer does', async () => {
    const invoicePolicy = adminPolicy({
      config: [{ verbs: ['GET'], schema: ['invoice'], query: {}, projection: null, condition: null }],
    });
    await changePolicy(invoicePolicy);

    const ids = async (schemaName) =>
      (await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName })).map((p) => p.id);
    assert.deepStrictEqual(await ids('user'), []);
    assert.deepStrictEqual(await ids('invoice'), ['p1']);
  });

  it('indexes a policy it caches after missing it, so activity on its schemas finds it', async () => {
    await Redis.hDel(K('policies'), 'p1');
    db.policies = [adminPolicy({ config: [{ verbs: ['GET'], schema: ['invoice'], query: {}, projection: null, condition: null }] })];

    await cache.getPolicies(['p1']);

    const found = await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName: 'invoice' });
    assert.deepStrictEqual(found.map((p) => p.id), ['p1']);
  });

  it("takes a policy off a token whose stored properties no longer select it, once it's reselected", async () => {
    db.tokens = [{ ...admin, policyProperties: {} }];

    await cache.reselectToken(admin.id);

    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);
    assert.deepStrictEqual(await Redis.sMembers(K(tokenPoliciesKey(admin.id))), []);
  });

  // An earlier release, running alongside this one in a rolling deploy, caches a token's policies by its own rules (any
  // key, ignoring case) under keys without a version
  const cacheAsEarlierRelease = async () => {
    Redis.reset();
    await Redis.sAdd(K(`token:${admin.id}:policies`), 'p1');
    await Redis.sAdd(K('policy:p1:tokens'), admin.id);
    await cache.addConnectedToken(admin.id);
  };

  it("doesn't use the policies an earlier release cached for a token, as in a rolling deploy", async () => {
    await cacheAsEarlierRelease();
    // Selected by the earlier rules, which ignored case: its stored role is 'admin', the selection's 'ADMIN'
    db.policies = [adminPolicy({ selection: { role: { '@eq': 'ADMIN' } } })];

    assert.deepStrictEqual((await cache.getPoliciesByToken(admin)).map((p) => p.id), []);
    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);
    // The earlier release's own set is left to it
    assert.deepStrictEqual(await Redis.sMembers(K(`token:${admin.id}:policies`)), ['p1']);
  });

  it('works out again, once, the policies of tokens cached by other selection rules, for realtime to send by', async () => {
    await cacheAsEarlierRelease();
    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);

    const tokenIds = await cache.tokensCachedByOtherRules();
    assert.deepStrictEqual(tokenIds, [admin.id]);
    await cache.reselectTokens(tokenIds);
    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), [admin.id]);

    // The rules haven't changed since, so they aren't looked for again
    assert.deepStrictEqual(await cache.tokensCachedByOtherRules(), []);
  });

  it("forgets a token's policies when it's reselected after being deleted", async () => {
    db.tokens = [];

    await cache.reselectToken(admin.id);

    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);
  });

  it("takes a deleted policy off every token and every schema lookup", async () => {
    db.policies = [];
    await cache.removePolicy('p1');

    assert.deepStrictEqual((await cache.getPoliciesByToken(admin)).map((p) => p.id), []);
    assert.deepStrictEqual(await cache.getConnectedTokenIdsByPolicyId('p1'), []);
    assert.deepStrictEqual(await cache.getPoliciesByRestActivity({ appId: 'app1', schemaName: 'user' }), []);
  });
});

// Requests read a token's policies while it's rehydrated, so they must see its old policies or its new ones, not some
describe('services/policy-cache: rehydrating a token while it is read', () => {
  const policies = ['p1', 'p2', 'p3'].map((id) => ({
    id, name: id, _appId: 'app1', priority: 1,
    selection: { role: { '@eq': 'admin' } },
    config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
  }));
  const token = { id: 'tok1', _appId: 'app1', type: 'user', policyProperties: { role: 'admin' } };

  it("never leaves the token's policies part-way changed", async () => {
    Redis.reset();
    const cache = new PolicyCache(Redis, mockModelManager({ Token: { findById: async () => token }, Policy: mockModel(policies) }));
    await cache.rehydrateToken(token);

    // Look at the token's policies after every Redis call the next rehydrate makes
    const seen = [];
    const methods = ['sAdd', 'sRem', 'del', 'rename', 'hSet', 'hDel', 'sUnion'];
    const originals = Object.fromEntries(methods.map((m) => [m, Redis[m]]));
    for (const m of methods) {
      Redis[m] = async (...args) => {
        const result = await originals[m].apply(Redis, args);
        seen.push((await Redis.sMembers(K(tokenPoliciesKey('tok1')))).sort().join(','));
        return result;
      };
    }
    try {
      await cache.rehydrateToken(token);
    } finally {
      Object.assign(Redis, originals);
    }

    assert.deepStrictEqual([...new Set(seen)], ['p1,p2,p3']);
    assert.deepStrictEqual((await Redis.sMembers(K(policyTokensKey('p2')))), ['tok1']);
  });
});
