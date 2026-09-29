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
import cluster from 'node:cluster';

import Bootstrap from '../../../dist/bootstrap.js';
import Logging from '../../../dist/helpers/logging.js';

// A stand-in for a cluster worker, which the tests make exit by emitting 'exit'
function createWorker({ dead = false, connected = !dead } = {}) {
  const worker = new EventEmitter();
  worker.isDead = () => dead;
  worker.isConnected = () => connected;
  worker.send = sinon.spy();
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

describe('bootstrap:notifyWorkers', () => {
  const payload = { type: 'app-routes:bust-cache', payload: {} };

  function createBootstrap(workers) {
    const bootstrap = new Bootstrap();
    bootstrap.workerProcesses = workers.length;
    bootstrap.workers = workers.map((worker) => ({ initiated: true, worker }));
    return bootstrap;
  }

  it('skips a worker that has exited, and still notifies the others', async () => {
    sinon.stub(Logging, 'logWarn');
    const workers = [createWorker(), createWorker({ dead: true }), createWorker()];

    await createBootstrap(workers).notifyWorkers(payload);

    assert.strictEqual(workers[1].send.called, false);
    assert.ok(workers[0].send.calledOnceWith(payload));
    assert.ok(workers[2].send.calledOnceWith(payload));
  });

  it('skips a worker that is still running but has disconnected', async () => {
    sinon.stub(Logging, 'logWarn');
    const worker = createWorker({ connected: false });

    await createBootstrap([worker]).notifyWorkers(payload);

    assert.strictEqual(worker.send.called, false);
  });

  it('logs a failed send rather than letting it be emitted as an error', async () => {
    const logError = sinon.stub(Logging, 'logError');
    const worker = createWorker();

    await createBootstrap([worker]).notifyWorkers(payload);
    const callback = worker.send.firstCall.args.find((arg) => typeof arg === 'function');
    callback(new Error('Channel closed'));

    assert.ok(logError.calledOnce);
    assert.match(logError.firstCall.args[0], /Channel closed/);
  });
});

describe('bootstrap:notifyWorker', () => {
  it('closes a connection meant for a worker that has exited', async () => {
    sinon.stub(Logging, 'logWarn');
    const worker = createWorker({ dead: true });
    const bootstrap = new Bootstrap();
    bootstrap.workers = [{ initiated: true, worker }];
    const connection = { destroy: sinon.spy() };

    await bootstrap.notifyWorker(0, { type: 'buttress:connection', payload: null }, connection);

    assert.strictEqual(worker.send.called, false);
    assert.ok(connection.destroy.calledOnce);
  });
});

describe('bootstrap:worker exit', () => {
  // Spawns the workers with cluster.fork stubbed, giving the fake workers in the order they were forked
  function spawn(workerProcesses) {
    const forked = [];
    sinon.stub(cluster, 'fork').callsFake(() => {
      const worker = createWorker();
      forked.push(worker);
      return worker;
    });
    const bootstrap = new Bootstrap();
    bootstrap.workerProcesses = workerProcesses;
    bootstrap.__spawnWorkers();
    return { bootstrap, forked };
  }

  function initiate(forked) {
    forked.forEach((worker) => worker.emit('message', { type: 'worker:initiated', payload: null }));
  }

  it('replaces a worker that exits while the process is running', () => {
    sinon.stub(Logging, 'logError');
    const { bootstrap, forked } = spawn(2);
    initiate(forked);

    forked[1].emit('exit', 1, null);

    assert.strictEqual(forked.length, 3);
    assert.strictEqual(bootstrap.workers[1].worker, forked[2]);
    assert.strictEqual(bootstrap.workers[0].worker, forked[0]);

    // The replacement is notified like any other worker
    bootstrap.notifyWorkers({ type: 'app-routes:bust-cache', payload: {} });
    assert.ok(forked[2].send.calledOnce);
  });

  it("doesn't replace a worker that exits while shutting down", async () => {
    const { bootstrap, forked } = spawn(1);
    initiate(forked);

    const cleaning = bootstrap.clean();
    forked[0].emit('exit', 0, 'SIGTERM');
    await cleaning;

    assert.strictEqual(forked.length, 1);
  });

  it("doesn't replace a worker that exits before it finished starting", () => {
    const logError = sinon.stub(Logging, 'logError');
    const { forked } = spawn(1);

    forked[0].emit('exit', 1, null);

    assert.strictEqual(forked.length, 1);
    assert.match(logError.firstCall.args[0], /before it finished starting/);
  });

  it('logs an error a worker emits', () => {
    const logError = sinon.stub(Logging, 'logError');
    const { forked } = spawn(1);

    forked[0].emit('error', new Error('Channel closed'));

    assert.match(logError.firstCall.args[0], /Channel closed/);
  });
});
