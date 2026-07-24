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

import LambdaRunner, { LambdaType } from '../../../../dist/lambda/lambda-runner.js';
import Model from '../../../../dist/model/index.js';
import LambdaSchemaModel from '../../../../dist/model/core/lambda.js';
import LambdaExecutionSchemaModel from '../../../../dist/model/core/lambda-execution.js';
import AppSchemaModel from '../../../../dist/model/core/app.js';

function createNrpFake() {
  return {
    _listeners: {},
    on(evt, cb) {
      this._listeners[evt] = cb;
    },
    emit: sinon.spy(),
  };
}

function createRunner(type = LambdaType.ALL) {
  const nrp = createNrpFake();
  const services = { get: (key) => (key === 'nrp' ? nrp : undefined) };
  const runner = new LambdaRunner(services, type);
  return { runner, nrp };
}

afterEach(() => {
  sinon.restore();
});

describe('lambda/LambdaRunner:_getLambdaModulesName', () => {
  it('builds the standard module list plus the lambda entry point', () => {
    const { runner } = createRunner();
    const lambda = {
      id: 'lambda-1',
      git: { hash: 'abc123', entryFile: 'src/index.js' },
    };

    const modules = runner._getLambdaModulesName(lambda);

    assert.deepStrictEqual(
      modules.map((m) => m.name),
      ['Buttress', 'LambdaSnippet', 'Sugar', 'lambda_lambda-1'],
    );
    const entry = modules.find((m) => m.name === 'lambda_lambda-1');
    assert.ok(entry.import.endsWith('/src/index.js'));
  });
});

describe('lambda/LambdaRunner:_subscribeToLambdaManager announce', () => {
  it('announces availability when idle and lambda type matches', () => {
    const { runner, nrp } = createRunner(LambdaType.API_ENDPOINT);
    runner._subscribeToLambdaManager();

    nrp._listeners['lambda:worker:announce'](
      JSON.stringify({ lambdaType: LambdaType.API_ENDPOINT, executionId: 'exec-1' }),
    );

    assert.ok(nrp.emit.calledWith('lambda:worker:available'));
    const [, payload] = nrp.emit.firstCall.args;
    assert.strictEqual(JSON.parse(payload).workerId, runner.id);
  });

  it('stays silent when already working', () => {
    const { runner, nrp } = createRunner(LambdaType.API_ENDPOINT);
    runner.working = true;
    runner._subscribeToLambdaManager();

    nrp._listeners['lambda:worker:announce'](
      JSON.stringify({ lambdaType: LambdaType.API_ENDPOINT, executionId: 'exec-1' }),
    );

    assert.strictEqual(nrp.emit.called, false);
  });

  it('stays silent when the lambda type does not match this worker (unless ALL)', () => {
    const { runner, nrp } = createRunner(LambdaType.API_ENDPOINT);
    runner._subscribeToLambdaManager();

    nrp._listeners['lambda:worker:announce'](JSON.stringify({ lambdaType: LambdaType.CRON, executionId: 'exec-1' }));

    assert.strictEqual(nrp.emit.called, false);
  });

  it('announces for any lambda type when this worker type is ALL', () => {
    const { runner, nrp } = createRunner(LambdaType.ALL);
    runner._subscribeToLambdaManager();

    nrp._listeners['lambda:worker:announce'](JSON.stringify({ lambdaType: LambdaType.CRON, executionId: 'exec-1' }));

    assert.ok(nrp.emit.calledWith('lambda:worker:available'));
  });
});

describe('lambda/LambdaRunner:_subscribeToLambdaManager execute', () => {
  it('ignores execute messages addressed to a different worker', () => {
    const { runner, nrp } = createRunner();
    sinon.stub(runner, 'handleLambdaExecutionMessage');
    runner._subscribeToLambdaManager();

    nrp._listeners['lambda:worker:execute'](JSON.stringify({ workerId: 'someone-else', executionId: 'exec-1' }));

    assert.strictEqual(runner.handleLambdaExecutionMessage.called, false);
    assert.strictEqual(nrp.emit.called, false);
  });

  it('reports overloaded and refuses new work when already working', () => {
    const { runner, nrp } = createRunner();
    sinon.stub(runner, 'handleLambdaExecutionMessage');
    runner.working = true;
    runner._lambdaExecution = { id: 'exec-current' };
    runner._subscribeToLambdaManager();

    nrp._listeners['lambda:worker:execute'](JSON.stringify({ workerId: runner.id, executionId: 'exec-new' }));

    assert.ok(nrp.emit.calledWith('lambda:worker:overloaded'));
    const [, payload] = nrp.emit.firstCall.args;
    assert.strictEqual(JSON.parse(payload).currentExecutionId, 'exec-current');
    assert.strictEqual(runner.handleLambdaExecutionMessage.called, false);
  });

  it('accepts and marks itself working when addressed and idle', () => {
    const { runner, nrp } = createRunner();
    sinon.stub(runner, 'handleLambdaExecutionMessage');
    runner._subscribeToLambdaManager();

    nrp._listeners['lambda:worker:execute'](JSON.stringify({ workerId: runner.id, executionId: 'exec-new' }));

    assert.strictEqual(runner.working, true);
    assert.ok(runner.handleLambdaExecutionMessage.calledOnce);
    assert.strictEqual(runner.handleLambdaExecutionMessage.firstCall.args[0].executionId, 'exec-new');
  });
});

function stubModel(map) {
  return sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    const fake = map.get(modelClass);
    if (!fake) throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
    return fake;
  });
}

function fakeExecutionModel({ findOneResult = null, updateById = async () => {} } = {}) {
  return {
    createId: (v) => v,
    findOne: async () => findOneResult,
    updateById,
    add: async () => {},
  };
}

describe('lambda/LambdaRunner:handleLambdaExecutionMessage', () => {
  it('errors out and reports lambda:worker:errored when the lambda cannot be found', async () => {
    const { runner, nrp } = createRunner();
    stubModel(new Map([[LambdaSchemaModel, { createId: (v) => v, findById: async () => null }]]));

    await runner.handleLambdaExecutionMessage({ lambdaId: 'missing-lambda', lambdaType: 'CRON', workerId: 'w1' });

    assert.strictEqual(runner.working, false);
    assert.ok(nrp.emit.calledWith('lambda:worker:errored'));
    const [, payload] = nrp.emit.firstCall.args;
    const parsed = JSON.parse(payload);
    assert.match(parsed.errMessage, /Unable to find lambda with id: missing-lambda/);
  });

  it('errors out when the app for the lambda cannot be found', async () => {
    const { runner, nrp } = createRunner();
    stubModel(
      new Map([
        [LambdaSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'lambda-1', _appId: 'app-1' }) }],
        [AppSchemaModel, { createId: (v) => v, findById: async () => null }],
      ]),
    );

    await runner.handleLambdaExecutionMessage({ lambdaId: 'lambda-1', lambdaType: 'CRON', workerId: 'w1' });

    assert.ok(nrp.emit.calledWith('lambda:worker:errored'));
    const [, payload] = nrp.emit.firstCall.args;
    assert.match(JSON.parse(payload).errMessage, /Unable to find app for lambda/);
  });

  it('errors out when there is no pending execution for the given id', async () => {
    const { runner, nrp } = createRunner();
    stubModel(
      new Map([
        [LambdaSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'lambda-1', _appId: 'app-1' }) }],
        [AppSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'app-1' }) }],
        [LambdaExecutionSchemaModel, fakeExecutionModel({ findOneResult: null })],
      ]),
    );

    await runner.handleLambdaExecutionMessage({
      lambdaId: 'lambda-1',
      lambdaType: 'CRON',
      executionId: 'exec-1',
      workerId: 'w1',
    });

    assert.ok(nrp.emit.calledWith('lambda:worker:errored'));
    const [, payload] = nrp.emit.firstCall.args;
    assert.match(JSON.parse(payload).errMessage, /Unable to find pending execution/);
  });

  it('executes the lambda and reports lambda:worker:finished on success', async () => {
    const { runner, nrp } = createRunner();
    const execution = {
      id: 'exec-1',
      metadata: [
        { key: 'BODY', value: '{"a":1}' },
        { key: 'REQ_ID', value: 'req-1' },
      ],
    };
    stubModel(
      new Map([
        [LambdaSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'lambda-1', _appId: 'app-1' }) }],
        [AppSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'app-1' }) }],
        [LambdaExecutionSchemaModel, fakeExecutionModel({ findOneResult: execution })],
      ]),
    );
    sinon.stub(runner, 'execute').resolves();

    await runner.handleLambdaExecutionMessage({
      lambdaId: 'lambda-1',
      lambdaType: 'API_ENDPOINT',
      executionId: 'exec-1',
      workerId: 'w1',
    });

    assert.strictEqual(runner.working, false);
    assert.ok(runner.execute.calledOnce);
    const executeArgs = runner.execute.firstCall.args;
    assert.deepStrictEqual(executeArgs[4], { body: '{"a":1}', query: undefined, headers: undefined, reqId: 'req-1' });
    assert.ok(nrp.emit.calledWith('lambda:worker:finished'));
  });

  it('marks the execution as errored and reports lambda:worker:errored when execute() rejects', async () => {
    const { runner, nrp } = createRunner();
    const execution = { id: 'exec-1', metadata: [] };
    const updateById = sinon.stub().resolves();
    stubModel(
      new Map([
        [LambdaSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'lambda-1', _appId: 'app-1' }) }],
        [AppSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'app-1' }) }],
        [LambdaExecutionSchemaModel, fakeExecutionModel({ findOneResult: execution, updateById })],
      ]),
    );
    sinon.stub(runner, 'execute').rejects(new Error('boom'));

    await runner.handleLambdaExecutionMessage({
      lambdaId: 'lambda-1',
      lambdaType: 'CRON',
      executionId: 'exec-1',
      workerId: 'w1',
    });

    assert.strictEqual(runner.working, false);
    assert.ok(updateById.called, '_updateDBLambdaErrorExecution should have persisted the ERROR status');
    assert.ok(nrp.emit.calledWith('lambda:worker:errored'));
    const [, payload] = nrp.emit.firstCall.args;
    assert.match(JSON.parse(payload).errMessage, /boom/);
  });
});
