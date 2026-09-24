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
import EventEmitter from 'node:events';
import sinon from 'sinon';

import Bootstrap from '../../../dist/bootstrap.js';

// A stand-in for a cluster worker, which the tests make exit by emitting 'exit'
function createWorker({ dead = false } = {}) {
  const worker = new EventEmitter();
  worker.isDead = () => dead;
  worker.process = { kill: sinon.spy() };
  return worker;
}

// Capture the signal handlers instead of adding them to the test process
function registerHandlers(bootstrap) {
  const handlers = {};
  const on = sinon.stub(process, 'on').callsFake((signal, handler) => {
    handlers[signal] = handler;
    return process;
  });
  bootstrap.shutdownOnSignals();
  on.restore();
  return handlers;
}

afterEach(() => {
  sinon.restore();
});

describe('bootstrap:clean', () => {
  it('sends the workers SIGTERM and waits for them to exit before closing NRP', async () => {
    const bootstrap = new Bootstrap();
    const nrp = { quit: sinon.stub().resolves() };
    bootstrap.__nrp = nrp;
    const workers = [createWorker(), createWorker()];
    bootstrap.workers = workers.map((worker) => ({ initiated: true, worker }));

    const cleaning = bootstrap.clean();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(workers.every((worker) => worker.process.kill.calledOnceWith('SIGTERM')));
    assert.strictEqual(nrp.quit.called, false);

    workers[0].emit('exit', 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(nrp.quit.called, false);

    workers[1].emit('exit', 0);
    await cleaning;
    assert.ok(nrp.quit.calledOnce);
  });

  it('leaves workers that have already exited alone', async () => {
    const bootstrap = new Bootstrap();
    const worker = createWorker({ dead: true });
    bootstrap.workers = [{ initiated: true, worker }];

    await bootstrap.clean();

    assert.strictEqual(worker.process.kill.called, false);
  });
});

describe('bootstrap:shutdownOnSignals', () => {
  it('handles SIGTERM and SIGINT', () => {
    const handlers = registerHandlers(new Bootstrap());

    assert.deepStrictEqual(Object.keys(handlers).sort(), ['SIGINT', 'SIGTERM']);
  });

  it('cleans up and exits with 0', async () => {
    sinon.useFakeTimers();
    const exit = sinon.stub(process, 'exit');
    const bootstrap = new Bootstrap();
    const clean = sinon.stub(bootstrap, 'clean').resolves();
    const handlers = registerHandlers(bootstrap);

    await handlers.SIGTERM('SIGTERM');

    assert.ok(clean.calledOnce);
    assert.ok(exit.calledOnceWith(0));
  });

  it('only shuts down once when signalled again', async () => {
    sinon.useFakeTimers();
    const exit = sinon.stub(process, 'exit');
    const bootstrap = new Bootstrap();
    const clean = sinon.stub(bootstrap, 'clean').resolves();
    const handlers = registerHandlers(bootstrap);

    await Promise.all([handlers.SIGINT('SIGINT'), handlers.SIGTERM('SIGTERM')]);

    assert.ok(clean.calledOnce);
    assert.ok(exit.calledOnceWith(0));
  });

  it('exits with 1 when cleaning up fails', async () => {
    sinon.useFakeTimers();
    const exit = sinon.stub(process, 'exit');
    const bootstrap = new Bootstrap();
    sinon.stub(bootstrap, 'clean').rejects(new Error('redis went away'));
    const handlers = registerHandlers(bootstrap);

    await handlers.SIGTERM('SIGTERM');

    assert.ok(exit.calledOnceWith(1));
  });

  it('exits with 1 when cleaning up takes longer than the default 8s', async () => {
    const clock = sinon.useFakeTimers();
    const exit = sinon.stub(process, 'exit');
    const bootstrap = new Bootstrap();
    sinon.stub(bootstrap, 'clean').returns(new Promise(() => {}));
    const handlers = registerHandlers(bootstrap);

    handlers.SIGTERM('SIGTERM');
    await clock.tickAsync(7999);
    assert.strictEqual(exit.called, false);

    await clock.tickAsync(1);
    assert.ok(exit.calledOnceWith(1));
  });
});
