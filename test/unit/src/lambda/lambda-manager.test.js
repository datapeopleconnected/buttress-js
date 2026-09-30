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

import { Readable } from 'node:stream';

import LambdaManager from '../../../../dist/lambda/lambda-manager.js';
import Model from '../../../../dist/model/index.js';

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
  manager._createLambdaExecution = async (_triggerType, lambdaId, _gitHash, _appId, _priority, metadata) => {
    const id = `exec-${createdExecutions.length + 1}`;
    const CRs = JSON.parse(metadata.find((m) => m.key === 'CR').value);
    createdExecutions.push({ id, lambdaId, CRs });
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
  const watchAll = ['schema.*'];

  it('debounces and executes every lambda matching a write, not just the first', async () => {
    const manager = createManager();
    const createdExecutions = stubExecutionCreation(manager);

    const lambdaA = { id: 'lambda-a', gitHash: 'hash-a', type: 'PATH_MUTATION', appId: 'app-1', paths: watchAll };
    const lambdaB = { id: 'lambda-b', gitHash: 'hash-b', type: 'PATH_MUTATION', appId: 'app-1', paths: watchAll };

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
    const lambdaA = { id: 'lambda-a', gitHash: 'hash-a', type: 'PATH_MUTATION', appId: 'app-1', paths: watchAll };

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

describe('lambda/LambdaManager path-mutation grouping', () => {
  const lambda = { id: 'lambda-a', gitHash: 'hash-a', type: 'PATH_MUTATION', appId: 'app-1', paths: ['car.*'] };
  const change = (entityId, value) => ({ paths: [`car.${entityId}.name`], values: [value], schema: 'car' });

  let clock = null;
  afterEach(() => clock?.restore());

  it('runs a lambda once for many changes to one entity, a second after the last of them', async () => {
    clock = sinon.useFakeTimers();
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    for (const value of ['a', 'b', 'c']) {
      await manager._debounceLambdaTriggers([lambda], change('e1', value));
      await clock.tickAsync(300);
    }
    await clock.tickAsync(600);
    assert.strictEqual(created.length, 0, 'no run until a second after the last change');

    await clock.tickAsync(100);
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(
      created[0].CRs.map((cr) => cr.values[0]),
      ['a', 'b', 'c'],
    );
  });

  it('runs no later than five seconds after the first change while the entity keeps changing', async () => {
    clock = sinon.useFakeTimers();
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    for (let ms = 0; ms < 5000; ms += 500) {
      await manager._debounceLambdaTriggers([lambda], change('e1', ms));
      await clock.tickAsync(500);
    }

    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].CRs.length, 10);
  });

  it('gives each entity its own run, including the entities of one bulk request', async () => {
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    await manager._debounceLambdaTriggers([lambda], {
      paths: ['car.e1.name', 'car.e2.name', 'car.e1.colour'],
      values: ['a', 'b', 'red'],
      schema: 'car',
    });
    await manager._debounceLambdaTriggers([lambda], change('e2', 'c'));

    for (const id of manager._debouncedPathMutations.map((r) => r.id)) {
      await fireDebounceTimer(manager, id);
    }

    assert.deepStrictEqual(
      created.map((e) => e.CRs),
      [
        [{ paths: ['car.e1.name', 'car.e1.colour'], values: ['a', 'red'], schema: 'car' }],
        [
          { paths: ['car.e2.name'], values: ['b'], schema: 'car' },
          { paths: ['car.e2.name'], values: ['c'], schema: 'car' },
        ],
      ],
    );
  });

  it('only runs a lambda for the entities whose paths it watches', async () => {
    const manager = createManager();
    const created = stubExecutionCreation(manager);
    const watchesE1 = { ...lambda, paths: ['car.e1.name'] };

    await manager._debounceLambdaTriggers([watchesE1], {
      paths: ['car.e1.name', 'car.e2.name'],
      values: ['a', 'b'],
      schema: 'car',
    });
    for (const id of manager._debouncedPathMutations.map((r) => r.id)) {
      await fireDebounceTimer(manager, id);
    }

    assert.deepStrictEqual(
      created.map((e) => e.CRs),
      [[{ paths: ['car.e1.name'], values: ['a'], schema: 'car' }]],
    );
  });

  it('groups changes that name no entity, such as creates, into one run per lambda', async () => {
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    await manager._debounceLambdaTriggers([lambda], { paths: ['car'], values: [{ name: 'a' }], schema: 'car' });
    await manager._debounceLambdaTriggers([lambda], { paths: ['car'], values: [{ name: 'b' }], schema: 'car' });
    assert.strictEqual(manager._debouncedPathMutations.length, 1);

    await fireDebounceTimer(manager, manager._debouncedPathMutations[0].id);
    assert.deepStrictEqual(
      created[0].CRs.map((cr) => cr.values[0].name),
      ['a', 'b'],
    );
  });

  it('starts a run straight away once it holds 100 changes', async () => {
    clock = sinon.useFakeTimers();
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    for (let n = 0; n < 100; n++) await manager._debounceLambdaTriggers([lambda], change('e1', n));
    await clock.tickAsync(0);

    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].CRs.length, 100);
    assert.strictEqual(manager._debouncedPathMutations.length, 0);
  });

  // The changes are stored in the run's LambdaExecution document, which Mongo caps at 16 MB.
  const MB = 1024 * 1024;
  const sizedChange = (entityId, bytes) => change(entityId, 'x'.repeat(bytes));

  it('starts a run straight away when its next change would take it past 1 MB, before it holds 100', async () => {
    clock = sinon.useFakeTimers();
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    // Each change is a little over a quarter of 1 MB once serialised, so the fourth would take the run past it.
    for (let n = 0; n < 5; n++) await manager._debounceLambdaTriggers([lambda], sizedChange('e1', MB / 4));
    await clock.tickAsync(0);

    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].CRs.length, 3);
    assert.strictEqual(manager._debouncedPathMutations[0].CRs.length, 2, 'the fourth and fifth are the next run');
  });

  it('starts a run before a change that would take it past 1 MB, and puts that change in the next', async () => {
    clock = sinon.useFakeTimers();
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    await manager._debounceLambdaTriggers([lambda], sizedChange('e1', MB / 2));
    await manager._debounceLambdaTriggers([lambda], sizedChange('e1', (MB * 3) / 4));
    await clock.tickAsync(0);

    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].CRs.length, 1);
    assert.strictEqual(manager._debouncedPathMutations[0].CRs.length, 1);
  });

  it('runs a change bigger than 1 MB on its own, straight away', async () => {
    clock = sinon.useFakeTimers();
    const manager = createManager();
    const created = stubExecutionCreation(manager);

    await manager._debounceLambdaTriggers([lambda], change('e1', 'small'));
    await manager._debounceLambdaTriggers([lambda], sizedChange('e1', 2 * MB));
    await clock.tickAsync(0);

    assert.deepStrictEqual(
      created.map((run) => run.CRs.length),
      [1, 1],
    );
    assert.strictEqual(created[1].CRs[0].values[0].length, 2 * MB);
    assert.strictEqual(manager._debouncedPathMutations.length, 0);
  });

  it('puts a change that arrives while a run is being recorded into the next run', async () => {
    const manager = createManager();
    const created = stubExecutionCreation(manager);
    const create = manager._createLambdaExecution;
    let release = null;
    manager._createLambdaExecution = async (...args) => {
      await new Promise((resolve) => (release = resolve));
      return create(...args);
    };

    await manager._debounceLambdaTriggers([lambda], change('e1', 'a'));
    const running = fireDebounceTimer(manager, manager._debouncedPathMutations[0].id);
    await manager._debounceLambdaTriggers([lambda], change('e1', 'b'));
    release();
    await running;

    assert.deepStrictEqual(
      created[0].CRs.map((cr) => cr.values[0]),
      ['a'],
    );
    assert.strictEqual(manager._debouncedPathMutations.length, 1, 'the late change should wait for the next run');
    assert.deepStrictEqual(
      manager._debouncedPathMutations[0].CRs.map((cr) => cr.values[0]),
      ['b'],
    );
    clearTimeout(manager._debouncedPathMutations[0].timer);
  });
});

describe('lambda/LambdaManager path changes from other apps', () => {
  const watchesCars = (id, appId) => ({ id, gitHash: 'hash', type: 'PATH_MUTATION', appId, paths: ['car.*'] });

  function notify(manager, nrp, message) {
    manager._listenLambdaPathChange();
    nrp._listeners['rest:worker:notifyLambdaPathChange'](JSON.stringify(message));
    const queued = manager._debouncedPathMutations.map((r) => r.lambdaId);
    manager._debouncedPathMutations.forEach((r) => clearTimeout(r.timer));
    return queued;
  }

  it("only runs the lambdas of the app whose data changed, even when another app's lambda watches the same paths", () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._pathsMutation = [watchesCars('lambda-app-1', 'app-1'), watchesCars('lambda-app-2', 'app-2')];

    const queued = notify(manager, nrp, { paths: ['car.e1.name'], values: ['a'], collection: 'car', appId: 'app-2' });

    assert.deepStrictEqual(queued, ['lambda-app-2']);
  });

  it('runs no lambda for a change that does not say which app it belongs to', () => {
    const { manager, nrp } = createManagerWithNrp();
    manager._pathsMutation = [watchesCars('lambda-app-1', 'app-1')];

    const queued = notify(manager, nrp, { paths: ['car.e1.name'], values: ['a'], collection: 'car' });

    assert.deepStrictEqual(queued, []);
  });
});

describe('lambda/LambdaManager path-mutation cache rebuild', () => {
  const watching = (id) => ({
    id,
    _appId: 'app-1',
    git: { hash: 'hash' },
    trigger: [{ type: 'PATH_MUTATION', pathMutation: { paths: ['car.*'] } }],
  });

  // A manager started with `initial` lambdas watching paths, whose next load waits to be released with `next`
  async function startManager(initial) {
    const { manager, nrp } = createManagerWithNrp();
    sinon.stub(manager, '_setupLambdaFolders');
    sinon.stub(manager, '_setQueueTimeout');
    let lambdas = Promise.resolve(initial);
    sinon.stub(Model, 'getCoreModel').returns({ find: async () => Readable.from(await lambdas) });
    await manager.init();

    let release;
    lambdas = new Promise((resolve) => (release = resolve));
    const rebuild = () => nrp._listeners['rest:worker:rebuild-path-mutation-cache']();
    return { manager, rebuild, release: (next) => release(next) };
  }

  it('keeps the cached lambdas while it loads them again, then uses the new ones', async () => {
    const { manager, rebuild, release } = await startManager([watching('before')]);

    const rebuilding = rebuild();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(manager._pathsMutation.map((l) => l.id), ['before']);

    release([watching('after')]);
    await rebuilding;
    assert.deepStrictEqual(manager._pathsMutation.map((l) => l.id), ['after']);
  });

  it('keeps none once no lambda watches paths', async () => {
    const { manager, rebuild, release } = await startManager([watching('before')]);

    const rebuilding = rebuild();
    release([]);
    await rebuilding;

    assert.deepStrictEqual(manager._pathsMutation, []);
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
