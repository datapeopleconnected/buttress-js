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

import createConfig from '@dpc/node-env-obj';

import Bootstrap from '../../../dist/bootstrap.js';
import BootstrapLambda from '../../../dist/bootstrap-lambda.js';
import Logging from '../../../dist/helpers/logging.js';
import Model from '../../../dist/model/index.js';
import LambdaManager from '../../../dist/lambda/lambda-manager.js';
import LambdaRunner from '../../../dist/lambda/lambda-runner.js';

const Config = createConfig();

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
  it("closes a connection meant for a worker that hasn't finished starting, and sends one once it has", async () => {
    sinon.stub(Logging, 'logWarn');
    const worker = createWorker();
    const bootstrap = new Bootstrap();
    bootstrap.workers = [{ initiated: false, worker }];
    const payload = { type: 'buttress:connection', payload: null };

    const early = { destroy: sinon.spy() };
    await bootstrap.notifyWorker(0, payload, early);

    assert.strictEqual(worker.send.called, false);
    assert.ok(early.destroy.calledOnce);

    bootstrap.workers[0].initiated = true;
    const later = { destroy: sinon.spy() };
    await bootstrap.notifyWorker(0, payload, later);

    assert.ok(worker.send.calledOnceWith(payload, later));
    assert.strictEqual(later.destroy.called, false);
  });

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
    const startup = bootstrap.__spawnWorkers();
    // Tests that don't wait on it still mustn't leave it rejected and unhandled
    startup.catch(() => {});
    return { bootstrap, forked, startup };
  }

  function initiate(forked) {
    forked.forEach((worker) => worker.emit('message', { type: 'worker:initiated', payload: { id: 'worker' } }));
  }

  it('replaces a worker that exits while the process is running', () => {
    sinon.stub(Logging, 'logError');
    const { bootstrap, forked } = spawn(2);
    initiate(forked);

    forked[1].emit('exit', 1, null);

    assert.strictEqual(forked.length, 3);
    assert.strictEqual(bootstrap.workers[1].worker, forked[2]);
    assert.strictEqual(bootstrap.workers[0].worker, forked[0]);

    // The replacement is notified like any other worker, once it has started
    sinon.stub(Logging, 'logWarn');
    bootstrap.notifyWorkers({ type: 'app-routes:bust-cache', payload: {} });
    assert.strictEqual(forked[2].send.called, false);

    initiate([forked[2]]);
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

  it('fails to start when a worker exits before it finished starting', async () => {
    const { forked, startup } = spawn(2);
    initiate([forked[0]]);

    forked[1].emit('exit', 1, null);

    await assert.rejects(startup, { message: 'Worker 1 exited with code 1 before it finished starting' });
    assert.strictEqual(forked.length, 2);
  });

  it('starts once every worker has finished starting', async () => {
    const { forked, startup } = spawn(2);

    initiate(forked);

    await startup;
  });

  it("doesn't replace a replacement that exits before it finished starting", () => {
    const logError = sinon.stub(Logging, 'logError');
    const { forked } = spawn(1);
    initiate(forked);
    forked[0].emit('exit', 1, null);

    forked[1].emit('exit', 1, null);

    assert.strictEqual(forked.length, 2);
    assert.match(logError.lastCall.args[0], /Worker 0 exited with code 1 before it finished starting/);
  });

  it('keeps the id a worker gives when it finished starting', () => {
    const { bootstrap, forked } = spawn(1);

    forked[0].emit('message', { type: 'worker:initiated', payload: { id: '7' } });

    assert.strictEqual(bootstrap.workers[0].processId, '7');
  });

  it('logs an error a worker emits', () => {
    const logError = sinon.stub(Logging, 'logError');
    const { forked } = spawn(1);

    forked[0].emit('error', new Error('Channel closed'));

    assert.match(logError.firstCall.args[0], /Channel closed/);
  });
});

describe('bootstrap-lambda:worker types', () => {
  // Delivers each message published to every handler subscribed to its channel, as Redis would
  function createNrp() {
    const handlers = new Map();
    return {
      on: async (channel, handler) => handlers.set(channel, [...(handlers.get(channel) ?? []), handler]),
      emit: async (channel, message) => (handlers.get(channel) ?? []).forEach((handler) => handler(message)),
    };
  }

  const lambdaConfig = { ...Config.lambda };
  const restApp = Config.rest.app;
  afterEach(() => {
    Object.assign(Config.lambda, lambdaConfig);
    Config.rest.app = restApp;
  });

  it('gives a replacement lambda worker the type of the one that exited', async () => {
    sinon.stub(Logging, 'logError');
    Object.assign(Config.lambda, { apiWorkers: '1', pathMutationWorkers: '1', cronWorkers: '0' });
    Config.rest.app = 'primary';
    sinon.stub(Model, 'initCoreModels').resolves();
    sinon.stub(LambdaManager.prototype, 'init').resolves();

    const nrp = createNrp();
    const types = new Map();
    await nrp.on('lambdaProcessMain:worker-type', (json) => {
      const { id, type } = JSON.parse(json);
      types.set(id, type);
    });

    // Each forked worker asks for its type over NRP, as a lambda worker does, then reports that it has started
    const forked = [];
    sinon.stub(cluster, 'fork').callsFake(() => {
      const worker = createWorker();
      const id = `${forked.length + 1}`;
      forked.push(worker);
      setImmediate(async () => {
        await nrp.emit('lambdaProcessWorker:worker-initiated', id);
        worker.emit('message', { type: 'worker:initiated', payload: { id } });
      });
      return worker;
    });

    const main = new BootstrapLambda();
    main.__nrp = nrp;
    main.__services.set('nrp', nrp);
    main.workerProcesses = 2;
    await main.__initMain();

    assert.deepStrictEqual(Object.fromEntries(types), { 1: 'API_ENDPOINT', 2: 'PATH_MUTATION' });

    forked[0].emit('exit', 1, null);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(forked.length, 3);
    assert.strictEqual(types.get('3'), 'API_ENDPOINT');
  });

  it('has a worker listen for its type before it asks for one', async () => {
    sinon.stub(Model, 'initCoreModels').resolves();
    sinon.stub(LambdaRunner.prototype, 'init').resolves();

    // Subscribing takes a round trip, as it does with Redis, and the primary main answers at once
    const handlers = new Map();
    const nrp = {
      on: async (channel, handler) => {
        await new Promise((resolve) => setImmediate(resolve));
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      },
      emit: async (channel, message) => (handlers.get(channel) ?? []).forEach((handler) => handler(message)),
    };
    handlers.set('lambdaProcessWorker:worker-initiated', [
      (id) => nrp.emit('lambdaProcessMain:worker-type', JSON.stringify({ id, type: 'CRON' })),
    ]);

    const worker = new BootstrapLambda();
    worker.id = '1';
    worker.workerProcesses = 1;
    worker.__nrp = nrp;
    worker.__services.set('nrp', nrp);

    const started = worker.__initWorker().then(() => 'started');
    const waiting = new Promise((resolve) => setTimeout(() => resolve('still waiting for a type'), 100));

    assert.strictEqual(await Promise.race([started, waiting]), 'started');
    assert.strictEqual(worker.__lambdaWorkerProcess.lambdaType, 'CRON');
  });
});
