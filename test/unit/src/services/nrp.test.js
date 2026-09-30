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
import sinon from 'sinon';

import NodeRedisPubsub from '../../../../dist/services/nrp.js';
import Logging from '../../../../dist/helpers/logging.js';

// A pub/sub client whose receiver calls handlers as @redis/client does, where a handler that throws takes the
// client's pub/sub routing down with it
function createNrp() {
  const nrp = Object.create(NodeRedisPubsub.prototype);
  const listeners = new Map();
  nrp.prefix = 'test:';
  nrp.receiver = {
    pSubscribe: async (channel, fn) => listeners.set(channel, fn),
    pUnsubscribe: async (channel, fn) => {
      if (listeners.get(channel) === fn) listeners.delete(channel);
    },
  };
  const deliver = (channel, message) => listeners.get(`test:${channel}`)(message, `test:${channel}`);
  return { nrp, listeners, deliver };
}

describe('services/nrp: handlers that fail', () => {
  afterEach(() => sinon.restore());

  it("doesn't let a handler's throw reach the Redis client, and logs it", async () => {
    const logError = sinon.stub(Logging, 'logError');
    const { nrp, deliver } = createNrp();
    await nrp.subscribe('boom', () => {
      throw new Error('handler broke');
    });

    assert.doesNotThrow(() => deliver('boom', '{}'));
    assert.ok(logError.args.some((args) => String(args[0]).includes('handler broke')), JSON.stringify(logError.args));
  });

  it("logs an async handler's rejection instead of leaving it unhandled", async () => {
    const logError = sinon.stub(Logging, 'logError');
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { nrp, deliver } = createNrp();
      await nrp.subscribe('boom', async () => {
        throw new Error('async handler broke');
      });

      deliver('boom', '{}');
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepStrictEqual(unhandled, []);
      assert.ok(logError.args.some((args) => String(args[0]).includes('async handler broke')));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still hands each message to the handler, and unsubscribes it', async () => {
    const { nrp, listeners, deliver } = createNrp();
    const received = [];
    const unsubscribe = await nrp.subscribe('ok', (message) => received.push(message));

    deliver('ok', 'hello');
    await unsubscribe();

    assert.deepStrictEqual(received, ['hello']);
    assert.strictEqual(listeners.size, 0);
  });
});
