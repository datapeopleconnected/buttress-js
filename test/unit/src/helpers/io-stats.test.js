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

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import diagnosticsChannel from 'node:diagnostics_channel';
import { setTimeout as sleep } from 'node:timers/promises';

import IOStats from '../../../../dist/helpers/io-stats.js';

// node-redis publishes every command it sends on this tracing channel (see @redis/client's tracing.js).
const redisCommandChannel = diagnosticsChannel.tracingChannel('node-redis:command');
const sendRedisCommand = (command, ...args) =>
  redisCommandChannel.tracePromise(async () => 'OK', { command, args: [command, ...args] });

afterEach(() => {
  IOStats.disable();
});

describe('helpers/IOStats: disabled', () => {
  it('runs the function and returns its result without tracking anything', () => {
    const result = IOStats.run('req-1', () => {
      IOStats.record('mongo', 'find');
      return 42;
    });

    assert.strictEqual(result, 42);
    assert.strictEqual(IOStats.get('req-1'), undefined);
  });

  it('ignores Redis commands', async () => {
    await IOStats.run('req-1', () => sendRedisCommand('GET', 'key'));
    assert.strictEqual(IOStats.get('req-1'), undefined);
  });
});

describe('helpers/IOStats: enabled', () => {
  it('counts operations recorded inside run against its key, by category and name', () => {
    IOStats.enable();

    IOStats.run('req-1', () => {
      IOStats.record('mongo', 'find', 'tokens');
      IOStats.record('mongo', 'find', 'users');
      IOStats.record('mongo', 'insert', 'activities');
      IOStats.record('nrp', 'rest:activity');
    });

    const counts = IOStats.get('req-1');
    assert.deepStrictEqual(counts.mongo, { find: 2, insert: 1 });
    assert.deepStrictEqual(counts.redis, {});
    assert.deepStrictEqual(counts.nrp, { 'rest:activity': 1 });
    assert.deepStrictEqual(counts.log, [
      'mongo find tokens',
      'mongo find users',
      'mongo insert activities',
      'nrp rest:activity',
    ]);
  });

  it('ignores operations outside any unit of work', () => {
    IOStats.enable();
    IOStats.record('mongo', 'find');
    IOStats.run('req-1', () => {});

    assert.deepStrictEqual(IOStats.get('req-1').mongo, {});
  });

  it('keeps counting work the unit started after the run has returned', async () => {
    IOStats.enable();

    IOStats.run('req-1', () => {
      setTimeout(() => IOStats.record('mongo', 'insert'), 5);
      setImmediate(() => IOStats.record('mongo', 'find'));
    });
    await sleep(20);

    assert.deepStrictEqual(IOStats.get('req-1').mongo, { insert: 1, find: 1 });
  });

  it('keeps concurrent units apart', async () => {
    IOStats.enable();

    const findTimes = async (finds) => {
      for (let i = 0; i < finds; i++) {
        await sleep(1);
        IOStats.record('mongo', 'find');
      }
    };
    await Promise.all([IOStats.run('req-1', () => findTimes(3)), IOStats.run('req-2', () => findTimes(1))]);

    assert.deepStrictEqual(IOStats.get('req-1').mongo, { find: 3 });
    assert.deepStrictEqual(IOStats.get('req-2').mongo, { find: 1 });
  });

  it('adds runs with the same key together, until the key is forgotten', () => {
    IOStats.enable();

    IOStats.run('spr', () => IOStats.record('mongo', 'find'));
    IOStats.run('spr', () => IOStats.record('mongo', 'find'));
    assert.deepStrictEqual(IOStats.get('spr').mongo, { find: 2 });

    IOStats.forget('spr');
    assert.strictEqual(IOStats.get('spr'), undefined);
    IOStats.run('spr', () => IOStats.record('mongo', 'find'));
    assert.deepStrictEqual(IOStats.get('spr').mongo, { find: 1 });
  });

  it('counts Redis commands from the node-redis tracing channel, with their key', async () => {
    IOStats.enable();

    await IOStats.run('req-1', async () => {
      await sendRedisCommand('SMEMBERS', 'bjs:token:1:policies');
      await sendRedisCommand('HMGET', 'bjs:policies', '1', '2');
      await sendRedisCommand('SMEMBERS', 'bjs:token:2:policies');
    });

    const counts = IOStats.get('req-1');
    assert.deepStrictEqual(counts.redis, { SMEMBERS: 2, HMGET: 1 });
    assert.deepStrictEqual(counts.log, [
      'redis SMEMBERS bjs:token:1:policies',
      'redis HMGET bjs:policies',
      'redis SMEMBERS bjs:token:2:policies',
    ]);
  });

  it('leaves Redis PUBLISH out, NRP publishes are counted by channel instead', async () => {
    IOStats.enable();

    await IOStats.run('req-1', () => sendRedisCommand('PUBLISH', 'bjs:rest:activity', '{}'));

    assert.deepStrictEqual(IOStats.get('req-1').redis, {});
  });

  it('stops counting and drops all counts when disabled', async () => {
    IOStats.enable();
    IOStats.run('req-1', () => IOStats.record('mongo', 'find'));

    IOStats.disable();
    assert.strictEqual(IOStats.get('req-1'), undefined);

    await IOStats.run('req-2', () => sendRedisCommand('GET', 'key'));
    assert.strictEqual(IOStats.get('req-2'), undefined);
    assert.strictEqual(diagnosticsChannel.channel('tracing:node-redis:command:start').hasSubscribers, false);
  });
});
