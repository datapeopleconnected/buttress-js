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

import Stream from 'node:stream';

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import { ObjectId } from 'bson';

import AccessControlEnv from '../../../../dist/access-control/env.js';
import Model from '../../../../dist/model/index.js';

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

  it("sets ipAddress to the request's address", () => {
    const result = AccessControlEnv.generateRequestGlobalEnvs({ ip: '203.0.113.7' }, 'app123', null);
    assert.strictEqual(result.ipAddress, '203.0.113.7');
  });

  it('gives an IPv4-mapped IPv6 address as the IPv4 address, and other IPv6 addresses as they are', () => {
    const mapped = AccessControlEnv.generateRequestGlobalEnvs({ ip: '::ffff:203.0.113.7' }, 'app123', null);
    assert.strictEqual(mapped.ipAddress, '203.0.113.7');

    const ipv6 = AccessControlEnv.generateRequestGlobalEnvs({ ip: '2001:db8::1' }, 'app123', null);
    assert.strictEqual(ipv6.ipAddress, '2001:db8::1');
  });

  it('sets ipAddress to null when the request has no address, as once its client has gone', () => {
    const result = AccessControlEnv.generateRequestGlobalEnvs({ ip: undefined }, 'app123', null);
    assert.strictEqual(result.ipAddress, null);
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

// SR-DPC-001 R1: a value that referred back to itself was read until the stack overflowed, failing every request
describe('access-control/env:getEnvValue an env value that refers back to itself', () => {
  const circular = (message) => (err) => {
    assert.strictEqual(err.name, 'CircularEnvError', String(err));
    assert.match(err.message, message);
    return true;
  };

  it('refuses a value that refers to itself, naming it', async () => {
    await assert.rejects(
      AccessControlEnv.getEnvValue('#env.a', { a: '#env.a' }),
      circular(/^circular_policy_env: #env\.a -> #env\.a$/),
    );
  });

  it('refuses a value that refers back to itself through others, naming each', async () => {
    await assert.rejects(
      AccessControlEnv.getEnvValue('#env.a', { a: '#env.b', b: '#env.c', c: '#env.a' }),
      circular(/^circular_policy_env: #env\.a -> #env\.b -> #env\.c -> #env\.a$/),
    );
  });

  it('reads a value that takes 16 env values to read, and refuses one that takes more', async () => {
    // v0 -> v1 -> ... -> v<n>, which holds the value
    const chain = (n) => {
      const env = { [`v${n}`]: 'end' };
      for (let i = 0; i < n; i++) env[`v${i}`] = `#env.v${i + 1}`;
      return env;
    };

    assert.strictEqual(await AccessControlEnv.getEnvValue('#env.v0', chain(15)), 'end');
    await assert.rejects(
      AccessControlEnv.getEnvValue('#env.v0', chain(16)),
      circular(/#env\.v0 takes more than 16 env values to read/),
    );
  });

  it('reads a value that two others refer to', async () => {
    const env = { a: '#env.c', b: '#env.c', c: 'value' };
    assert.strictEqual(await AccessControlEnv.getEnvValue('#env.a', env), 'value');
    assert.strictEqual(await AccessControlEnv.getEnvValue('#env.b', env), 'value');
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

  // SR-DPC-001 C11: index 0 was taken as no key, so a list's first item was never set
  it("sets a list's first item", () => {
    const obj = { ids: ['old', 'old'] };
    AccessControlEnv.__setObjectValueByPath(obj, ['ids', 0], 'first');
    AccessControlEnv.__setObjectValueByPath(obj, ['ids', 1], 'second');
    assert.deepStrictEqual(obj.ids, ['first', 'second']);
  });
});

describe('access-control/env: collection lookups', () => {
  const USER_ID = '507f1f77bcf86cd799439011';
  const BOARD_IDS = ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022'];

  // A policy env that looks up the ids of the boards the user is subscribed to, as the data-filter policies do
  const envVars = () => ({
    appId: 'app1',
    user: { id: USER_ID },
    boardIds: {
      collection: 'board',
      type: 'array',
      query: { subscribed: { '@eq': '#env.user.id' } },
      output: { key: 'id', type: 'id' },
    },
  });

  // Stubs the app's board model, which finds `entities`, and records the queries it's given
  function stubBoardModel(entities) {
    const queries = [];
    const model = {
      find: (query) => {
        queries.push(query);
        return Stream.Readable.from(entities.map((entity) => ({ ...entity })));
      },
    };
    sinon.stub(Model, 'getAppModel').callsFake(async (_appId, name) => (name === 'board' ? model : undefined));
    return queries;
  }

  afterEach(() => {
    sinon.restore();
  });

  it('gives the ids of the entities it finds, querying with the env values substituted', async () => {
    const queries = stubBoardModel([{ id: BOARD_IDS[0] }, { id: new ObjectId(BOARD_IDS[1]) }]);

    const result = await AccessControlEnv.getEnvValue('#env.boardIds', envVars());

    assert.deepStrictEqual(result, BOARD_IDS);
    assert.deepStrictEqual(queries, [{ subscribed: { $eq: USER_ID } }]);
  });

  it('leaves out values that are not ids, so only ids reach an $in', async () => {
    stubBoardModel([{ id: BOARD_IDS[0] }, { id: 'not-an-id' }, {}, { id: [BOARD_IDS[1], null] }]);

    const result = await AccessControlEnv.getEnvValue('#env.boardIds', envVars());

    assert.deepStrictEqual(result, BOARD_IDS);
  });

  it('gives an empty array when it finds nothing', async () => {
    stubBoardModel([]);

    const result = await AccessControlEnv.getEnvValue('#env.boardIds', envVars());

    assert.deepStrictEqual(result, []);
  });

  // SR-DPC-001 C11: the first #env reference in a list was left as its text
  it("reads every #env reference in a list in the lookup's query, the first one included", async () => {
    const queries = stubBoardModel([{ id: BOARD_IDS[0] }]);
    const env = { ...envVars(), first: 'one', second: 'two' };
    env.boardIds.query = { name: { '@in': ['#env.first', '#env.second'] } };

    await AccessControlEnv.getEnvValue('#env.boardIds', env);

    assert.deepStrictEqual(queries, [{ name: { $in: ['one', 'two'] } }]);
  });

  // SR-DPC-001 R1
  it("refuses a lookup whose query refers back to the lookup, without querying", async () => {
    const queries = stubBoardModel([{ id: BOARD_IDS[0] }]);
    const env = { ...envVars(), owner: '#env.boardIds' };
    env.boardIds.query = { subscribed: { '@eq': '#env.user.id' }, owner: '#env.owner' };

    await assert.rejects(AccessControlEnv.getEnvValue('#env.boardIds', env), (err) => {
      assert.strictEqual(err.name, 'CircularEnvError', String(err));
      assert.strictEqual(err.message, 'circular_policy_env: #env.boardIds -> #env.owner -> #env.boardIds');
      return true;
    });
    assert.deepStrictEqual(queries, []);
  });

  it('reads a value its query refers to twice', async () => {
    const queries = stubBoardModel([{ id: BOARD_IDS[0] }]);
    const env = { ...envVars(), userId: '#env.user.id' };
    env.boardIds.query = { '@or': [{ subscribed: '#env.userId' }, { owner: '#env.userId' }] };

    assert.deepStrictEqual(await AccessControlEnv.getEnvValue('#env.boardIds', env), [BOARD_IDS[0]]);
    assert.deepStrictEqual(queries, [{ $or: [{ subscribed: USER_ID }, { owner: USER_ID }] }]);
  });

  it("gives an empty array for a collection the app doesn't have", async () => {
    stubBoardModel([{ id: BOARD_IDS[0] }]);
    const env = envVars();
    env.boardIds.collection = 'missing';

    const result = await AccessControlEnv.getEnvValue('#env.boardIds', env);

    assert.deepStrictEqual(result, []);
  });
});
