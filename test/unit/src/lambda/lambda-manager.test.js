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

import LambdaManager from '../../../../dist/lambda/lambda-manager.js';

function createManager() {
  const nrp = { on: () => {}, emit: () => {} };
  const services = { get: (key) => (key === 'nrp' ? nrp : undefined) };
  return new LambdaManager(services);
}

// Captures listeners registered via nrp.on() so tests can fire them directly, and spies on
// emit() so tests can assert what the manager announced back out.
function createManagerWithNrp() {
  const nrp = {
    _listeners: {},
    on(evt, cb) {
      this._listeners[evt] = cb;
    },
    emit: sinon.spy(),
  };
  const services = { get: (key) => (key === 'nrp' ? nrp : undefined) };
  const manager = new LambdaManager(services);
  return { manager, nrp };
}

afterEach(() => {
  sinon.restore();
});

// Stub out the parts of execution creation that would otherwise hit the real
// model/DB layer, and record what was "created" so tests can assert on it.
function stubExecutionCreation(manager) {
  const createdExecutions = [];
  manager._createLambdaExecution = async (_triggerType, lambdaId) => {
    const id = `exec-${createdExecutions.length + 1}`;
    createdExecutions.push({ id, lambdaId });
    return { id };
  };
  manager._processQueue = async () => {};
  return createdExecutions;
}

// The debounce timer is just scheduling — fire the underlying handler directly
// instead of waiting out the real 1s debounce window in every test.
async function fireDebounceTimer(manager, id) {
  const record = manager._debouncedPathMutations.find((r) => r.id === id);
  if (record?.timer) clearTimeout(record.timer);
  await manager._createLambdaPathMutationExecution(id);
}

describe('lambda/LambdaManager path-mutation debounce', () => {
  const cr = { paths: ['schema.field'], values: ['x'], schema: 'schema' };

  it('debounces and executes every lambda matching a write, not just the first', async () => {
    const manager = createManager();
    const createdExecutions = stubExecutionCreation(manager);

    const lambdaA = { id: 'lambda-a', gitHash: 'hash-a', type: 'PATH_MUTATION', appId: 'app-1' };
    const lambdaB = { id: 'lambda-b', gitHash: 'hash-b', type: 'PATH_MUTATION', appId: 'app-1' };

    await manager._debounceLambdaTriggers([lambdaA, lambdaB], cr);

    assert.strictEqual(
      manager._debouncedPathMutations.length,
      2,
      'both matching lambdas should get their own debounce record',
    );

    for (const id of manager._debouncedPathMutations.map((r) => r.id)) {
      await fireDebounceTimer(manager, id);
    }

    assert.strictEqual(createdExecutions.length, 2);
    assert.deepStrictEqual(createdExecutions.map((e) => e.lambdaId).sort(), ['lambda-a', 'lambda-b']);
  });

  it('lets a later identical write trigger a new execution once the previous debounce has completed', async () => {
    const manager = createManager();
    const createdExecutions = stubExecutionCreation(manager);
    const lambdaA = { id: 'lambda-a', gitHash: 'hash-a', type: 'PATH_MUTATION', appId: 'app-1' };

    await manager._debounceLambdaTriggers([lambdaA], cr);
    assert.strictEqual(manager._debouncedPathMutations.length, 1);

    await fireDebounceTimer(manager, manager._debouncedPathMutations[0].id);

    assert.strictEqual(createdExecutions.length, 1);
    assert.strictEqual(
      manager._debouncedPathMutations.length,
      0,
      'the completed debounce record must be removed, not left behind',
    );

    // The exact same change (same lambda, same change hash) arrives again later.
    await manager._debounceLambdaTriggers([lambdaA], cr);
    assert.strictEqual(
      manager._debouncedPathMutations.length,
      1,
      'a repeat write must start a fresh debounce record rather than being silently dropped',
    );

    await fireDebounceTimer(manager, manager._debouncedPathMutations[0].id);

    assert.strictEqual(createdExecutions.length, 2, 'the repeat write must produce a second execution');
  });
});

describe('lambda/LambdaManager worker assignment', () => {
  it('assigns an idle worker to a newly-available execution', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    nrp._listeners['lambda:worker:available'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));

    assert.strictEqual(manager._workerMap['worker-1'], 'exec-1');
    assert.ok(nrp.emit.calledWith('lambda:worker:execute'));
  });

  it('does not reassign an execution another worker already claimed', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    nrp._listeners['lambda:worker:available'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));
    nrp.emit.resetHistory();

    nrp._listeners['lambda:worker:available'](JSON.stringify({ workerId: 'worker-2', executionId: 'exec-1' }));

    assert.strictEqual(manager._workerMap['worker-2'], undefined);
    assert.strictEqual(nrp.emit.called, false);
  });

  it('does not reassign a worker that is already tracked against another execution', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    nrp._listeners['lambda:worker:available'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));
    nrp.emit.resetHistory();

    nrp._listeners['lambda:worker:available'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-2' }));

    assert.strictEqual(
      manager._workerMap['worker-1'],
      'exec-1',
      'worker-1 should stay assigned to its first execution',
    );
    assert.strictEqual(nrp.emit.called, false);
  });

  it('throws if an available announcement is missing a workerId', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    assert.throws(
      () => nrp._listeners['lambda:worker:available'](JSON.stringify({ executionId: 'exec-1' })),
      /Unable to assign Lamba worker without a workerId/,
    );
  });

  it('untracks the worker once an execution errors', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    nrp._listeners['lambda:worker:available'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));
    assert.strictEqual(manager._workerMap['worker-1'], 'exec-1');

    nrp._listeners['lambda:worker:errored'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));

    assert.strictEqual(manager._workerMap['worker-1'], undefined);
    assert.strictEqual(manager._inflightExecutions['exec-1'], undefined);
  });

  it('untracks the worker once an execution finishes', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    nrp._listeners['lambda:worker:available'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));
    nrp._listeners['lambda:worker:finished'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));

    assert.strictEqual(manager._workerMap['worker-1'], undefined);
    assert.strictEqual(manager._inflightExecutions['exec-1'], undefined);
  });

  it("heals tracking onto the worker's current execution when it reports overloaded", () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    // worker-1 was assigned exec-1, but by the time it checked in it had actually already
    // moved on to exec-current (e.g. a stale/duplicate announcement was assigned to it).
    manager.trackWorkerLambda({ workerId: 'worker-1', executionId: 'exec-current' });

    nrp._listeners['lambda:worker:overloaded'](
      JSON.stringify({ workerId: 'worker-1', executionId: 'exec-stale', currentExecutionId: 'exec-current' }),
    );

    assert.strictEqual(manager._workerMap['worker-1'], 'exec-current');
    assert.strictEqual(manager._inflightExecutions['exec-current'].workerId, 'worker-1');
  });

  it('untracks a worker when the overloaded execution matches what the manager thinks it is running', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._listenToLambdaWorkers();

    manager.trackWorkerLambda({ workerId: 'worker-1', executionId: 'exec-1' });

    nrp._listeners['lambda:worker:overloaded'](JSON.stringify({ workerId: 'worker-1', executionId: 'exec-1' }));

    assert.strictEqual(manager._workerMap['worker-1'], undefined);
    assert.strictEqual(manager._inflightExecutions['exec-1'], undefined);
  });
});

describe('lambda/LambdaManager trackWorkerLambda/untrackWorkerLambda', () => {
  it('throws when tracking a message without a workerId', () => {
    const manager = createManager();
    assert.throws(() => manager.trackWorkerLambda({ executionId: 'exec-1' }), /Unable to track Lamba worker/);
  });

  it('throws when untracking a message without a workerId', () => {
    const manager = createManager();
    assert.throws(() => manager.untrackWorkerLambda({ executionId: 'exec-1' }), /Unable to track Lamba worker/);
  });
});
