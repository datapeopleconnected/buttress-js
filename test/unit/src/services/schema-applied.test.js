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

import {
  SchemaChangeAcks,
  SchemaAppliedWaiter,
  restProcessIdentity,
} from '../../../../dist/services/schema-applied.js';

afterEach(() => sinon.restore());

describe('services/schema-applied: SchemaChangeAcks', () => {
  it('announces a change once every worker told of it has applied it', () => {
    const applied = [];
    const acks = new SchemaChangeAcks((changeId, appId) => applied.push([changeId, appId]));

    acks.start('c1', [0, 1, 2], 'app-1');
    acks.ack('c1', 0);
    acks.ack('c1', 2);
    assert.deepStrictEqual(applied, []);

    acks.ack('c1', 1);
    assert.deepStrictEqual(applied, [['c1', 'app-1']]);
  });

  it('announces a change once, however often a worker says it has applied it', () => {
    const applied = [];
    const acks = new SchemaChangeAcks((changeId) => applied.push(changeId));

    acks.start('c1', [0, 1], 'app-1');
    acks.ack('c1', 0);
    acks.ack('c1', 0);
    acks.ack('c1', 1);
    acks.ack('c1', 1);

    assert.deepStrictEqual(applied, ['c1']);
  });

  it('announces a change at once when no worker was told of it', () => {
    const applied = [];
    const acks = new SchemaChangeAcks((changeId) => applied.push(changeId));

    acks.start('c1', [], 'app-1');

    assert.deepStrictEqual(applied, ['c1']);
  });

  it("keeps changes apart, so one worker's answer to another isn't taken for this one's", () => {
    const applied = [];
    const acks = new SchemaChangeAcks((changeId) => applied.push(changeId));

    acks.start('c1', [0, 1], 'app-1');
    acks.start('c2', [0, 1], 'app-1');
    acks.ack('c2', 0);
    acks.ack('c2', 1);

    assert.deepStrictEqual(applied, ['c2']);
  });

  it("stops waiting on a worker that's gone", () => {
    const applied = [];
    const acks = new SchemaChangeAcks((changeId) => applied.push(changeId));

    acks.start('c1', [0, 1], 'app-1');
    acks.ack('c1', 0);
    acks.workerGone(1);

    assert.deepStrictEqual(applied, ['c1']);
  });

  it('announces a change anyway when a worker has not applied it in time', () => {
    const clock = sinon.useFakeTimers();
    const applied = [];
    const acks = new SchemaChangeAcks((changeId) => applied.push(changeId), 1000);

    acks.start('c1', [0, 1], 'app-1');
    clock.tick(999);
    assert.deepStrictEqual(applied, []);

    clock.tick(1);
    assert.deepStrictEqual(applied, ['c1']);

    // And not again when the worker does answer
    acks.ack('c1', 0);
    acks.ack('c1', 1);
    assert.deepStrictEqual(applied, ['c1']);
  });

  it('announces nothing for a change it has cleared', () => {
    const clock = sinon.useFakeTimers();
    const applied = [];
    const acks = new SchemaChangeAcks((changeId) => applied.push(changeId), 1000);

    acks.start('c1', [0], 'app-1');
    acks.clear();
    clock.tick(5000);
    acks.ack('c1', 0);

    assert.deepStrictEqual(applied, []);
  });
});

// A pub/sub client that keeps its handlers, and delivers what's published to them
function createNrp() {
  const handlers = new Map();
  const nrp = {
    on: sinon.stub().callsFake(async (channel, handler) => {
      handlers.set(channel, handler);
    }),
  };
  const deliver = (channel, message) => handlers.get(channel)(JSON.stringify(message));
  return { nrp, deliver };
}

describe('services/schema-applied: SchemaAppliedWaiter', () => {
  it('resolves true once its own process says the change is applied', async () => {
    const { nrp, deliver } = createNrp();
    const waiter = new SchemaAppliedWaiter(nrp);

    const wait = await waiter.expect('c1');
    deliver('app-schema:applied', { changeId: 'c1', appId: 'app-1', ...restProcessIdentity() });

    assert.strictEqual(await wait(), true);
  });

  it("isn't answered by another process's announcement of the change", async () => {
    const clock = sinon.useFakeTimers();
    const { nrp, deliver } = createNrp();
    const waiter = new SchemaAppliedWaiter(nrp, 1000);

    const wait = await waiter.expect('c1');
    const other = { ...restProcessIdentity() };
    deliver('app-schema:applied', { changeId: 'c1', appId: 'app-1', host: other.host, pid: other.pid + 1 });
    deliver('app-schema:applied', { changeId: 'c1', appId: 'app-1', host: `${other.host}-2`, pid: other.pid });
    const result = wait();
    clock.tick(1000);

    assert.strictEqual(await result, false);
  });

  it("isn't answered by the announcement of another change", async () => {
    const clock = sinon.useFakeTimers();
    const { nrp, deliver } = createNrp();
    const waiter = new SchemaAppliedWaiter(nrp, 1000);

    const wait = await waiter.expect('c1');
    deliver('app-schema:applied', { changeId: 'c2', appId: 'app-1', ...restProcessIdentity() });
    const result = wait();
    clock.tick(1000);

    assert.strictEqual(await result, false);
  });

  it('resolves false when the change is not applied in time, rather than waiting on', async () => {
    const clock = sinon.useFakeTimers();
    const { nrp } = createNrp();
    const waiter = new SchemaAppliedWaiter(nrp, 1000);

    const wait = await waiter.expect('c1');
    const result = wait();
    clock.tick(1000);

    assert.strictEqual(await result, false);
  });

  it('is answered when the announcement comes before it starts waiting', async () => {
    const { nrp, deliver } = createNrp();
    const waiter = new SchemaAppliedWaiter(nrp);

    const wait = await waiter.expect('c1');
    deliver('app-schema:applied', { changeId: 'c1', appId: 'app-1', ...restProcessIdentity() });
    await Promise.resolve();

    assert.strictEqual(await wait(), true);
  });

  it('listens once, however many changes it waits for', async () => {
    const { nrp, deliver } = createNrp();
    const waiter = new SchemaAppliedWaiter(nrp);

    const first = await waiter.expect('c1');
    deliver('app-schema:applied', { changeId: 'c1', appId: 'app-1', ...restProcessIdentity() });
    await first();
    const second = await waiter.expect('c2');
    deliver('app-schema:applied', { changeId: 'c2', appId: 'app-1', ...restProcessIdentity() });
    await second();

    assert.strictEqual(nrp.on.callCount, 1);
  });
});
