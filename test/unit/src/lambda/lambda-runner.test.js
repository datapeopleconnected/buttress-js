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

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import ivm from 'isolated-vm';
import createConfig from '@dpc/node-env-obj';

import LambdaRunner, { LambdaType } from '../../../../dist/lambda/lambda-runner.js';
import Model from '../../../../dist/model/index.js';
import LambdaSchemaModel from '../../../../dist/model/core/lambda.js';
import LambdaExecutionSchemaModel from '../../../../dist/model/core/lambda-execution.js';
import AppSchemaModel from '../../../../dist/model/core/app.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';
import UserSchemaModel from '../../../../dist/model/core/user.js';
import SecureStoreSchemaModel from '../../../../dist/model/core/secure-store.js';
import DeploymentSchemaModel from '../../../../dist/model/core/deployment.js';
import Logging from '../../../../dist/helpers/logging.js';
import LambdaRun from '../../../../dist/lambda-helpers/lambda-run.js';

const Config = createConfig();

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
      ['Buttress', 'Sugar', 'lambda_lambda-1_abc123'],
    );
    const entry = modules.find((m) => m.name === 'lambda_lambda-1_abc123');
    assert.ok(entry.import.endsWith('/src/index.js'));
  });

  it('adds each shared module ahead of the lambda, named by its hash, and names the lambda for them', () => {
    const { runner } = createRunner();
    const lambda = {
      id: 'lambda-1',
      git: {
        hash: 'abc123',
        entryFile: 'src/index.js',
        sharedModules: [{ name: 'Snippet', entryFile: '_snippets/index.js' }],
      },
    };

    const modules = runner._getLambdaModulesName(lambda);

    const names = modules.map((m) => m.name);
    assert.deepStrictEqual(names.slice(0, 3), ['Buttress', 'Sugar', 'shared_Snippet_abc123']);
    assert.match(names[3], /^lambda_lambda-1_abc123_[0-9a-f]{8}$/);
    const shared = modules[2];
    assert.ok(shared.import.endsWith('/lambda-abc123/./_snippets/index.js'));
    assert.strictEqual(shared.sharedEntryFile, path.resolve(`${Config.paths.lambda.code}/lambda-abc123/_snippets/index.js`));
  });

  it('gives lambdas at different hashes their own copy of a shared module', () => {
    const { runner } = createRunner();
    const sharedModules = [{ name: 'Snippet', entryFile: '_snippets/index.js' }];
    const sharedName = (hash) =>
      runner
        ._getLambdaModulesName({ id: 'lambda-1', git: { hash, entryFile: 'index.js', sharedModules } })
        .find((m) => m.sharedEntryFile).name;

    assert.strictEqual(sharedName('abc123'), 'shared_Snippet_abc123');
    assert.strictEqual(sharedName('def456'), 'shared_Snippet_def456');
  });

  it('builds shared modules again for every run when the lambda is', () => {
    const { runner } = createRunner();
    const lambda = {
      id: 'lambda-1',
      git: { hash: 'HEAD', entryFile: 'index.js', sharedModules: [{ name: 'Snippet', entryFile: 'shared.js' }] },
    };

    const shared = runner._getLambdaModulesName(lambda).find((m) => m.sharedEntryFile);

    assert.strictEqual(shared.reload, true);
  });

  it('refuses a shared module whose entry file is outside the checkout', () => {
    const { runner } = createRunner();
    const lambda = {
      id: 'lambda-1',
      git: { hash: 'abc123', entryFile: 'index.js', sharedModules: [{ name: 'Snippet', entryFile: '../other.js' }] },
    };

    assert.throws(() => runner._getLambdaModulesName(lambda), { status: 400, code: 'invalid_lambda_shared_module' });
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

describe('lambda/LambdaRunner:clean', () => {
  it('stops announcing availability once it is shutting down', async () => {
    const { runner, nrp } = createRunner();
    runner._subscribeToLambdaManager();
    await runner.clean();

    nrp._listeners['lambda:worker:announce'](JSON.stringify({ lambdaType: LambdaType.CRON, executionId: 'exec-1' }));

    assert.strictEqual(nrp.emit.called, false);
  });

  it('releases work it is given once it is shutting down', async () => {
    const { runner, nrp } = createRunner();
    sinon.stub(runner, 'handleLambdaExecutionMessage');
    runner._subscribeToLambdaManager();
    await runner.clean();

    nrp._listeners['lambda:worker:execute'](JSON.stringify({ workerId: runner.id, executionId: 'exec-new' }));

    assert.ok(nrp.emit.calledWith('lambda:worker:overloaded'));
    assert.strictEqual(JSON.parse(nrp.emit.firstCall.args[1]).executionId, 'exec-new');
    assert.strictEqual(runner.handleLambdaExecutionMessage.called, false);
    assert.strictEqual(runner.working, false);
  });

  it('waits for the running lambda to finish', async () => {
    const clock = sinon.useFakeTimers();
    const { runner } = createRunner();
    runner.working = true;

    let cleaned = false;
    const cleaning = runner.clean().then(() => (cleaned = true));
    await clock.tickAsync(1000);
    assert.strictEqual(cleaned, false);

    runner.working = false;
    await clock.tickAsync(100);
    await cleaning;
    assert.strictEqual(cleaned, true);
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

describe("lambda/LambdaRunner:handleLambdaExecutionMessage a lambda that isn't executable", () => {
  // Hands the runner an execution of a disabled lambda, as the manager does
  async function handOver(execution, lambdaType) {
    sinon.stub(Logging, 'logError');
    const { runner, nrp } = createRunner();
    const updateById = sinon.stub().resolves();
    const add = sinon.stub().resolves();
    const lambda = { id: 'lambda-1', _appId: 'app-1', name: 'disabled', executable: false, trigger: [] };
    stubModel(
      new Map([
        [LambdaSchemaModel, { createId: (v) => v, findById: async () => lambda }],
        [AppSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'app-1' }) }],
        [LambdaExecutionSchemaModel, { ...fakeExecutionModel({ findOneResult: execution, updateById }), add }],
        [DeploymentSchemaModel, { createId: (v) => v }],
      ]),
    );
    const execute = sinon.stub(runner, 'execute').resolves();

    runner.working = true;
    await runner.handleLambdaExecutionMessage({ lambdaId: 'lambda-1', lambdaType, executionId: 'exec-1', workerId: 'w1' });
    return { runner, nrp, updateById, add, execute };
  }

  it("doesn't run it, records why, and still queues the next run of its cron", async () => {
    const execution = {
      id: 'exec-1', lambdaId: 'lambda-1', deploymentId: 'd', _appId: 'app-1', metadata: [],
      nextCronExpression: 'in 1 hour',
    };

    const { runner, nrp, updateById, add, execute } = await handOver(execution, 'CRON');

    assert.strictEqual(execute.called, false);
    assert.strictEqual(runner.working, false);
    assert.ok(updateById.calledWithMatch('exec-1', { $set: { status: 'ERROR' } }));
    const logs = updateById.firstCall.args[1].$push.logs.$each;
    assert.ok(logs.some((entry) => /lambda_is_not_executable/.test(entry.log)));
    assert.ok(add.calledOnce);
    assert.strictEqual(add.firstCall.args[0].nextCronExpression, 'in 1 hour');
    assert.ok(nrp.emit.calledWith('lambda:worker:errored'));
  });

  it('answers an API caller waiting on it that the lambda is not executable', async () => {
    const execution = { id: 'exec-1', lambdaId: 'lambda-1', metadata: [{ key: 'REQ_ID', value: 'req-1' }] };

    const { nrp, add } = await handOver(execution, 'API_ENDPOINT');

    const result = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
    assert.deepStrictEqual(JSON.parse(result.args[1]), {
      code: 400,
      err: 'lambda_is_not_executable',
      reqId: 'req-1',
      executionId: 'exec-1',
    });
    assert.strictEqual(add.called, false);
  });
});

describe('lambda/LambdaRunner:handleLambdaExecutionMessage a lambda that fails', () => {
  let savedPlugins;
  let tmpDir;

  beforeEach(() => {
    savedPlugins = Config.paths.lambda.plugins;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-fails-'));
    Config.paths.lambda.plugins = tmpDir;
  });

  afterEach(() => {
    Config.paths.lambda.plugins = savedPlugins;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Runs an API endpoint lambda that throws, in the runner's real isolate, as the manager hands it over
  async function runFailingLambda(updateById, lambdaTokens = [{ value: 'lambda-token' }], body = "throw new Error('lambda broke');") {
    sinon.stub(Logging, 'logError');
    const { runner, nrp } = createRunner();
    await runner.init();
    const lambda = {
      id: 'lambda-1', _appId: 'app-1', name: 'failing', trigger: [],
      git: { url: 'git@example.com:x.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
    };
    const execution = {
      id: 'exec-1', lambdaId: 'lambda-1', deploymentId: 'd', status: 'PENDING',
      metadata: [{ key: 'REQ_ID', value: 'req-1' }],
    };
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'app-1', apiPath: 'app' }) }],
        [LambdaSchemaModel, { createId: (v) => v, findById: async () => lambda }],
        [TokenSchemaModel, { createId: (v) => v, find: async () => Readable.from(lambdaTokens) }],
        [LambdaExecutionSchemaModel, fakeExecutionModel({ findOneResult: execution, updateById })],
      ]),
    );
    sinon.stub(runner, '_getLambdaModulesName').returns([{ name: 'lambda_failing' }]);
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    sinon.stub(runner, '_registerLambdaModules').callsFake(async () => {
      runner._context.evalSync(`
        globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };
        globalThis['lambda_failing'] = class { async execute() { ${body} } };
      `);
    });

    runner.working = true;
    await runner.handleLambdaExecutionMessage({
      lambdaId: 'lambda-1',
      lambdaType: 'API_ENDPOINT',
      executionId: 'exec-1',
      workerId: runner.id,
    });
    runner._isolate.dispose();
    return { runner, nrp };
  }

  it('records the execution as errored once, with why', async function () {
    this.timeout(10000);
    const updateById = sinon.stub().resolves();

    await runFailingLambda(updateById);

    const errorWrites = updateById.getCalls().filter((call) => call.args[1].$set?.status === 'ERROR');
    assert.strictEqual(errorWrites.length, 1);
    const logs = errorWrites[0].args[1].$push.logs.$each;
    assert.ok(logs.some((entry) => entry.type === 'ERROR' && /lambda broke/.test(entry.log)));
  });

  it('still tells the manager and the API caller when recording the failure fails', async function () {
    this.timeout(10000);
    const updateById = sinon.stub().callsFake(async (_id, update) => {
      if (update.$set?.status === 'ERROR') throw new Error('mongo went away');
    });

    const { runner, nrp } = await runFailingLambda(updateById);

    assert.strictEqual(runner.working, false);
    const emitted = (channel) => nrp.emit.getCalls().find((call) => call.args[0] === channel);
    assert.match(JSON.parse(emitted('lambda:worker:execution-result').args[1]).err, /lambda broke/);
    assert.match(JSON.parse(emitted('lambda:worker:errored').args[1]).errMessage, /lambda broke/);
  });

  it('keeps what the lambda logged before it failed, ahead of why it failed', async function () {
    this.timeout(10000);
    sinon.stub(Logging, 'log');
    const updateById = sinon.stub().resolves();

    await runFailingLambda(updateById, undefined, "lambda.log('about to break'); throw new Error('lambda broke');");

    const errorWrite = updateById.getCalls().find((call) => call.args[1].$set?.status === 'ERROR');
    const logs = errorWrite.args[1].$push.logs.$each;
    assert.deepStrictEqual(logs[0], { log: 'about to break', type: 'log' });
    assert.match(logs[1].log, /lambda broke/);
  });

  it('answers the API caller when the execution fails before the lambda runs', async function () {
    this.timeout(10000);
    const updateById = sinon.stub().resolves();

    const { nrp } = await runFailingLambda(updateById, []);

    const result = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
    assert.deepStrictEqual(JSON.parse(result.args[1]), {
      code: 500,
      err: 'lambda_execution_failed',
      reqId: 'req-1',
      executionId: 'exec-1',
    });
    assert.ok(updateById.calledWithMatch('exec-1', { $set: { status: 'ERROR' } }));
    assert.ok(nrp.emit.calledWith('lambda:worker:errored'));
  });
});

describe('lambda/LambdaRunner:execute logs', () => {
  let savedPlugins;
  let tmpDir;

  beforeEach(() => {
    savedPlugins = Config.paths.lambda.plugins;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-logs-'));
    Config.paths.lambda.plugins = tmpDir;
    ['log', 'logDebug', 'logWarn', 'logError'].forEach((level) => sinon.stub(Logging, level));
  });

  afterEach(() => {
    Config.paths.lambda.plugins = savedPlugins;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // A runner that runs a lambda whose entry point is `body` in its real isolate, giving the update that completed it
  async function createLoggingRunner(modules = [{ name: 'lambda_logging' }]) {
    const { runner } = createRunner();
    await runner.init();
    const updateById = sinon.stub().resolves();
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v }],
        [TokenSchemaModel, { createId: (v) => v, find: async () => Readable.from([{ value: 'lambda-token' }]) }],
        [LambdaExecutionSchemaModel, {
          ...fakeExecutionModel({ updateById }),
          findById: async (id) => ({ id, status: 'RUNNING', metadata: [] }),
        }],
      ]),
    );
    sinon.stub(runner, '_getLambdaModulesName').returns(modules);
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    let body = '';
    sinon.stub(runner, '_registerLambdaModules').callsFake(async () => {
      runner._context.evalSync(`
        globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };
        globalThis['shared_Shared_HEAD'] = { answer: 42 };
        globalThis['lambda_logging'] = class { async execute() { ${body} } };
      `);
    });
    const lambda = {
      id: 'lambda-1', name: 'logging', trigger: [],
      git: { url: 'git@example.com:x.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
    };

    const complete = async (lambdaBody) => {
      body = lambdaBody;
      updateById.resetHistory();
      const execution = { id: 'exec-1', lambdaId: 'lambda-1', deploymentId: 'd', metadata: [] };
      await runner.execute(lambda, execution, { id: 'app-1', apiPath: 'app' }, 'CRON', {});
      return updateById.getCalls().find((call) => call.args[1].$set?.status === 'COMPLETE').args[1];
    };
    return { complete, dispose: () => runner._isolate.dispose() };
  }

  async function complete(body) {
    const runner = await createLoggingRunner();
    try {
      return await runner.complete(body);
    } finally {
      runner.dispose();
    }
  }

  it('saves what the lambda logged with its execution, in order', async function () {
    this.timeout(10000);

    const update = await complete("lambda.log('hello'); console.warn('careful'); lambda.logError({ code: 7 });");

    assert.deepStrictEqual(update.$push.logs.$each, [
      { log: 'hello', type: 'log' },
      { log: 'careful', type: 'warn' },
      { log: '{"code":7}', type: 'error' },
    ]);
  });

  it('runs the lambda rather than a shared module listed ahead of it', async function () {
    this.timeout(10000);
    const runner = await createLoggingRunner([
      { name: 'shared_Shared_HEAD', import: '/code/lambda-HEAD/./shared.js', sharedEntryFile: '/code/lambda-HEAD/shared.js' },
      { name: 'lambda_logging' },
    ]);

    try {
      const update = await runner.complete('lambda.log(String(shared_Shared_HEAD.answer));');
      assert.deepStrictEqual(update.$push.logs.$each, [{ log: '42', type: 'log' }]);
    } finally {
      runner.dispose();
    }
  });

  it('keeps each run to its own logs', async function () {
    this.timeout(10000);
    const runner = await createLoggingRunner();
    await runner.complete("lambda.log('first run');");

    const update = await runner.complete("lambda.log('second run');");

    runner.dispose();
    assert.deepStrictEqual(update.$push.logs.$each, [{ log: 'second run', type: 'log' }]);
  });

  it('gives a lambda randomness from the host, as the web crypto functions', async function () {
    this.timeout(10000);

    const update = await complete(`
      const filled = crypto.getRandomValues(new Uint8Array(32));
      lambda.log(String(filled.some((byte) => byte !== 0)));
      lambda.log(crypto.randomUUID());
      lambda.log(crypto.randomUUID());
    `);

    const [filled, first, second] = update.$push.logs.$each.map((entry) => entry.log);
    assert.strictEqual(filled, 'true');
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(second, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notStrictEqual(first, second);
  });

  it('refuses a lambda more random bytes than the web crypto allows at once', async function () {
    this.timeout(10000);

    const update = await complete(`
      try {
        crypto.getRandomValues(new Uint8Array(65537));
      } catch (err) {
        lambda.log(err.message);
      }
    `);

    assert.deepStrictEqual(update.$push.logs.$each, [
      { log: 'getRandomValues: more than 65536 bytes requested', type: 'log' },
    ]);
  });

  it('stops saving logs past 1 MB, and says how many it left out', async function () {
    this.timeout(10000);

    const update = await complete("const line = 'x'.repeat(1024); for (let i = 0; i < 1100; i++) lambda.log(line);");

    const logs = update.$push.logs.$each;
    assert.ok(logs.length < 1100);
    assert.deepStrictEqual(logs.at(-1), { log: `${1100 - (logs.length - 1)} more log lines were left out`, type: 'warn' });
  });
});

describe('lambda/LambdaRunner:_registerLambdaModules dev reload', () => {
  const packageMod = { packageName: '@buttress/api', name: 'Buttress' };
  const ownCodeMod = { name: 'lambda_abc123' };

  function createRunnerWithFakeIsolate() {
    const { runner } = createRunner();
    const runSync = sinon.spy();
    const compileScriptSync = sinon.stub().returns({ runSync });
    runner._isolate = { compileScriptSync };
    runner._context = {};
    return { runner, compileScriptSync, runSync };
  }

  afterEach(() => {
    Config.lambda.devReload = 'FALSE';
  });

  it('registers each module only once across calls when devReload is off (the default)', async () => {
    Config.lambda.devReload = 'FALSE';
    const { runner, compileScriptSync } = createRunnerWithFakeIsolate();
    sinon.stub(fs, 'readFileSync').returns('/* bundle */');

    await runner._registerLambdaModules([packageMod, ownCodeMod]);
    await runner._registerLambdaModules([packageMod, ownCodeMod]);

    assert.strictEqual(compileScriptSync.callCount, 2, 'each module compiled once total, not per call');
  });

  it('re-registers only the lambda’s own code module on every call when devReload is on, leaving shared package bundles cached', async () => {
    Config.lambda.devReload = 'TRUE';
    const { runner, compileScriptSync } = createRunnerWithFakeIsolate();
    sinon.stub(fs, 'readFileSync').returns('/* bundle */');

    await runner._registerLambdaModules([packageMod, ownCodeMod]);
    await runner._registerLambdaModules([packageMod, ownCodeMod]);

    // package: compiled once (first call only). own code: compiled on both calls.
    assert.strictEqual(compileScriptSync.callCount, 3);
    assert.strictEqual(
      runner._registeredBundles.filter((m) => m === ownCodeMod.name).length,
      1,
      'own code module id should not be pushed into the cache list more than once',
    );
  });
});

describe('lambda/LambdaRunner:_registerLambdaModules failure', () => {
  it('loads a bundle again on the next call if it threw the first time', async () => {
    const { runner } = createRunner();
    const runSync = sinon.stub();
    runSync.onFirstCall().throws(new ReferenceError('module is not defined'));
    const compileScriptSync = sinon.stub().returns({ runSync });
    runner._isolate = { compileScriptSync };
    runner._context = {};
    sinon.stub(fs, 'readFileSync').returns('/* bundle */');
    const ownCodeMod = { name: 'lambda_abc123' };

    await assert.rejects(runner._registerLambdaModules([ownCodeMod]), /module is not defined/);
    await runner._registerLambdaModules([ownCodeMod]);

    // Compiled once, and run again
    assert.strictEqual(compileScriptSync.callCount, 1);
    assert.strictEqual(runSync.callCount, 2);
    assert.deepStrictEqual(runner._registeredBundles, [ownCodeMod.name]);
  });
});

describe('lambda/LambdaRunner:bundleLambdaModules', () => {
  let tmpDir;
  let savedPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-bundle-'));
    savedPaths = { ...Config.paths.lambda };
    Config.paths.lambda.code = `${tmpDir}/app_data/lambda/code`;
    Config.paths.lambda.bundles = `${tmpDir}/app_data/lambda/bundles`;
  });

  afterEach(() => {
    Object.assign(Config.paths.lambda, savedPaths);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bundles a CommonJS lambda checked out under a "type": "module" Buttress install so it loads in an isolate', async function () {
    this.timeout(30000);
    // As in the Docker image, where lambda code is checked out under /opt/buttress.
    fs.writeFileSync(`${tmpDir}/package.json`, JSON.stringify({ type: 'module' }));
    const lambdaDir = `${Config.paths.lambda.code}/lambda-abc123`;
    fs.mkdirSync(`${lambdaDir}/lib`, { recursive: true });
    fs.writeFileSync(
      `${lambdaDir}/index.js`,
      `const answer = require('./lib/answer.js');
class HelloWorld {
  execute() {
    return answer;
  }
}
module.exports = HelloWorld;
`,
    );
    fs.writeFileSync(`${lambdaDir}/lib/answer.js`, 'module.exports = 42;\n');
    const { runner } = createRunner();

    await runner.bundleLambdaModules([{ name: 'lambda_abc123', import: `${lambdaDir}/./index.js` }]);

    const isolate = new ivm.Isolate();
    try {
      const context = isolate.createContextSync();
      isolate
        .compileScriptSync(fs.readFileSync(`${Config.paths.lambda.bundles}/lambda_abc123.js`, 'utf8'))
        .runSync(context);
      assert.strictEqual(context.evalSync('new lambda_abc123().execute()'), 42);
    } finally {
      isolate.dispose();
    }
  });
  it('rejects with webpack\'s error when the lambda requires a module that is missing', async function () {
    this.timeout(30000);
    const lambdaDir = `${Config.paths.lambda.code}/lambda-abc123`;
    fs.mkdirSync(lambdaDir, { recursive: true });
    fs.writeFileSync(`${lambdaDir}/index.js`, "module.exports = require('./missing.js');\n");
    const { runner } = createRunner();

    await assert.rejects(
      runner.bundleLambdaModules([{ name: 'lambda_abc123', import: `${lambdaDir}/./index.js` }]),
      /Unable to bundle lambda modules: .*Can't resolve '\.\/missing\.js'/,
    );

    // webpack writes a bundle even when the build has errors, and another worker would skip bundling and load it.
    assert.deepStrictEqual(fs.readdirSync(Config.paths.lambda.bundles), []);
  });

  it('moves a finished bundle into place in one step, leaving no build folder behind', async function () {
    this.timeout(30000);
    const lambdaDir = `${Config.paths.lambda.code}/lambda-abc123`;
    fs.mkdirSync(lambdaDir, { recursive: true });
    fs.writeFileSync(`${lambdaDir}/index.js`, 'module.exports = 42;\n');
    const { runner } = createRunner();
    const renameSync = sinon.spy(fs, 'renameSync');

    try {
      await runner.bundleLambdaModules([{ name: 'lambda_abc123', import: `${lambdaDir}/./index.js` }]);
    } finally {
      renameSync.restore();
    }

    const bundle = path.resolve(`${Config.paths.lambda.bundles}/lambda_abc123.js`);
    assert.ok(renameSync.calledWith(sinon.match.string, bundle), 'the bundle should be renamed into place');
    assert.deepStrictEqual(fs.readdirSync(Config.paths.lambda.bundles), ['lambda_abc123.js']);
  });

  it('bundles a lambda that only causes a webpack warning', async function () {
    this.timeout(30000);
    const lambdaDir = `${Config.paths.lambda.code}/lambda-abc123`;
    fs.mkdirSync(lambdaDir, { recursive: true });
    // A require() of an expression webpack can't follow is a warning, not an error.
    fs.writeFileSync(`${lambdaDir}/index.js`, 'module.exports = (name) => require(name);\n');
    const { runner } = createRunner();

    await runner.bundleLambdaModules([{ name: 'lambda_abc123', import: `${lambdaDir}/./index.js` }]);

    assert.ok(fs.existsSync(`${Config.paths.lambda.bundles}/lambda_abc123.js`));
  });

  it('bundles a lambda that imports a built-in with the node: scheme', async function () {
    this.timeout(30000);
    const lambdaDir = `${Config.paths.lambda.code}/lambda-abc123`;
    fs.mkdirSync(lambdaDir, { recursive: true });
    // @buttress/api imports node:crypto, which webpack can't read for a lambda's target until the scheme is removed
    fs.writeFileSync(`${lambdaDir}/index.js`, "module.exports = require('node:crypto').createHash;\n");
    const { runner } = createRunner();

    await runner.bundleLambdaModules([{ name: 'lambda_abc123', import: `${lambdaDir}/./index.js` }]);

    assert.ok(fs.existsSync(`${Config.paths.lambda.bundles}/lambda_abc123.js`));
  });

  it('gives a bundled lambda crypto.randomUUID, which the browser polyfill lacks', async function () {
    this.timeout(30000);
    const lambdaDir = `${Config.paths.lambda.code}/lambda-abc123`;
    fs.mkdirSync(lambdaDir, { recursive: true });
    // @buttress/api calls randomUUID from node:crypto for a uuid property's default
    fs.writeFileSync(
      `${lambdaDir}/index.js`,
      `const { randomUUID, randomBytes } = require('node:crypto');
module.exports = () => ({ uuid: randomUUID(), bytes: randomBytes(8).length });
`,
    );
    const { runner } = createRunner();
    await runner.init();

    try {
      await runner.bundleLambdaModules([{ name: 'lambda_abc123', import: `${lambdaDir}/./index.js` }]);
      runner._context.evalSync(fs.readFileSync(`${Config.paths.lambda.bundles}/lambda_abc123.js`, 'utf8'));

      const result = JSON.parse(runner._context.evalSync('JSON.stringify(lambda_abc123())'));

      assert.match(result.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.strictEqual(result.bytes, 8);
    } finally {
      runner._isolate.dispose();
    }
  });

  it('bundles a shared module once and has lambdas use its global rather than their own copy', async function () {
    this.timeout(30000);
    const checkoutDir = `${Config.paths.lambda.code}/lambda-abc123`;
    fs.mkdirSync(`${checkoutDir}/_shared/lib`, { recursive: true });
    fs.mkdirSync(`${checkoutDir}/area`, { recursive: true });
    fs.writeFileSync(
      `${checkoutDir}/_shared/index.js`,
      `globalThis.sharedLoads = (globalThis.sharedLoads || 0) + 1;
module.exports = { answer: require('./lib/answer.js'), marker: 'SHARED_MODULE_SOURCE' };
`,
    );
    fs.writeFileSync(`${checkoutDir}/_shared/lib/answer.js`, 'module.exports = 42;\n');
    // Each form a lambda could require the shared entry by
    const requireForms = {
      one: "require('../_shared')",
      two: "require('../_shared/index.js')",
      three: "require('../_shared/')",
    };
    Object.entries(requireForms).forEach(([file, requireCall]) => {
      fs.writeFileSync(
        `${checkoutDir}/area/${file}.js`,
        `const Shared = ${requireCall};
class Lambda {
  execute() {
    return Shared.answer;
  }
}
Lambda.shared = Shared;
module.exports = Lambda;
`,
      );
    });
    const { runner } = createRunner();
    const shared = {
      name: 'shared_Shared_abc123',
      import: `${checkoutDir}/./_shared/index.js`,
      sharedEntryFile: path.resolve(`${checkoutDir}/_shared/index.js`),
    };
    const lambdas = Object.keys(requireForms).map((file) => ({
      name: `lambda_${file}_abc123`,
      import: `${checkoutDir}/./area/${file}.js`,
    }));

    await runner.bundleLambdaModules([shared, ...lambdas]);

    const read = (name) => fs.readFileSync(`${Config.paths.lambda.bundles}/${name}.js`, 'utf8');
    assert.ok(read(shared.name).includes('SHARED_MODULE_SOURCE'));
    lambdas.forEach((l) => assert.ok(!read(l.name).includes('SHARED_MODULE_SOURCE'), `${l.name} has its own copy`));

    const isolate = new ivm.Isolate();
    try {
      const context = isolate.createContextSync();
      [shared, ...lambdas].forEach((m) => isolate.compileScriptSync(read(m.name)).runSync(context));
      lambdas.forEach((l) => assert.strictEqual(context.evalSync(`new ${l.name}().execute()`), 42));
      assert.strictEqual(context.evalSync('sharedLoads'), 1);
      assert.strictEqual(context.evalSync(`${lambdas[0].name}.shared === ${lambdas[1].name}.shared`), true);
    } finally {
      isolate.dispose();
    }
  });
});

describe('lambda/LambdaRunner:execute', () => {
  it('reports the error to the API caller waiting on the result when the lambda fails to load', async () => {
    const { runner, nrp } = createRunner();
    // An isolate with room in its heap, which is all execute() asks of it before it loads the lambda
    runner._isolate = {
      isDisposed: false,
      getHeapStatisticsSync: () => ({ used_heap_size: 0, externally_allocated_size: 0, heap_size_limit: 1000 }),
    };
    runner._context = {};
    runner._jail = { setSync: sinon.spy() };
    sinon.stub(runner, '_useAppContext');
    const updateById = sinon.stub().resolves();
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v }],
        [TokenSchemaModel, { find: async () => Readable.from([{ value: 'lambda-token' }]) }],
        [LambdaExecutionSchemaModel, fakeExecutionModel({ updateById })],
      ]),
    );
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    sinon.stub(runner, '_registerLambdaModules').rejects(new ReferenceError('module is not defined'));
    const lambda = {
      id: 'lambda-1',
      name: 'hello-world',
      git: { url: 'git@example.com:hello-world.git', entryFile: 'index.js', entryPoint: 'execute' },
      trigger: [],
    };

    await assert.rejects(
      runner.execute(lambda, { id: 'exec-1', metadata: [] }, { id: 'app-1', apiPath: 'test' }, 'API_ENDPOINT', {
        reqId: 'req-1',
      }),
      /module is not defined/,
    );

    const resultCall = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
    assert.ok(resultCall, 'the API caller should be sent the result rather than left waiting');
    const message = JSON.parse(resultCall.args[1]);
    assert.strictEqual(message.reqId, 'req-1');
    assert.match(message.err, /module is not defined/);
    assert.ok(updateById.calledWithMatch('exec-1', { $set: { status: 'ERROR' } }));
  });
});

describe('lambda/LambdaRunner:execute timeout', () => {
  let savedTimeout;
  let savedPlugins;
  let tmpDir;

  beforeEach(() => {
    savedTimeout = Config.timeout.lambdasRunner;
    savedPlugins = Config.paths.lambda.plugins;
    Config.timeout.lambdasRunner = '1';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-timeout-'));
    Config.paths.lambda.plugins = tmpDir;
  });

  afterEach(() => {
    Config.timeout.lambdasRunner = savedTimeout;
    Config.paths.lambda.plugins = savedPlugins;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Runs a lambda whose entry point is `entryPoint`, in the runner's real isolate
  async function executeLambda(runner, entryPoint) {
    const updateById = sinon.stub().resolves();
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v }],
        [TokenSchemaModel, { find: async () => Readable.from([{ value: 'lambda-token' }]) }],
        [LambdaExecutionSchemaModel, fakeExecutionModel({ updateById })],
      ]),
    );
    sinon.stub(runner, '_getLambdaModulesName').returns([{ name: 'lambda_lambda-1' }]);
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    sinon.stub(runner, '_registerLambdaModules').callsFake(async () => {
      runner._context.evalSync(`
        globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };
        globalThis['lambda_lambda-1'] = class { async execute() { ${entryPoint} } };
      `);
    });
    const lambda = {
      id: 'lambda-1',
      name: 'hello-world',
      git: { url: 'git@example.com:hello-world.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
      trigger: [],
    };

    const started = Date.now();
    const execution = { id: 'exec-1', lambdaId: 'lambda-1', deploymentId: 'deployment-1', metadata: [] };
    const result = runner.execute(lambda, execution, { id: 'app-1', apiPath: 'test' }, 'API_ENDPOINT', {
      reqId: 'req-1',
    });
    await assert.rejects(result, /lambda_execution_timed_out/);
    return { elapsed: Date.now() - started, updateById };
  }

  for (const [name, entryPoint] of [
    ['runs without awaiting', 'while (true) {}'],
    ['is still running after an await', 'await Promise.resolve(); while (true) {}'],
  ]) {
    it(`stops a lambda that ${name} after the runner timeout, and starts a new isolate`, async function () {
      this.timeout(10000);
      const { runner, nrp } = createRunner();
      await runner.init();
      const firstIsolate = runner._isolate;

      const { elapsed, updateById } = await executeLambda(runner, entryPoint);

      assert.ok(elapsed < 3000, `took ${elapsed}ms`);
      assert.ok(updateById.calledWithMatch('exec-1', { $set: { status: 'ERROR' } }));
      const resultCall = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
      assert.match(JSON.parse(resultCall.args[1]).err, /lambda_execution_timed_out/);

      assert.notStrictEqual(runner._isolate, firstIsolate);
      assert.ok(firstIsolate.isDisposed);
      assert.strictEqual(runner._context.evalSync('typeof getEmailTemplate'), 'function');
      runner._isolate.dispose();
    });
  }
});

describe('lambda/LambdaRunner:execute caller credentials', () => {
  let savedPlugins;
  let tmpDir;

  beforeEach(() => {
    savedPlugins = Config.paths.lambda.plugins;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-caller-'));
    Config.paths.lambda.plugins = tmpDir;
  });

  afterEach(() => {
    Config.paths.lambda.plugins = savedPlugins;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // What a lambda is given of the call, as it reports it from its real isolate
  async function given(trigger, execution, callerTokenType = 'app') {
    const { runner, nrp } = createRunner();
    await runner.init();
    const callerToken = {
      id: 'caller-token', value: 'caller-token-value', type: callerTokenType,
      _userId: 'user-1', _lambdaId: 'lambda-2', _appId: 'app-1',
    };
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [UserSchemaModel, { createId: (v) => v, find: async () => Readable.from([{ id: 'user-1' }]) }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v }],
        [TokenSchemaModel, {
          createId: (v) => v,
          find: async (query) => Readable.from([query._id ? callerToken : { value: 'lambda-token' }]),
          // The caller's token, unless it has been deleted since the call was queued
          findById: async (id) => (id === 'caller-token' ? callerToken : null),
        }],
        [LambdaExecutionSchemaModel, {
          ...fakeExecutionModel({ updateById: sinon.stub().resolves() }),
          findById: async (id) => ({ id, status: 'RUNNING', metadata: [] }),
        }],
      ]),
    );
    sinon.stub(runner, '_getLambdaModulesName').returns([{ name: 'lambda_lambda-1' }]);
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    sinon.stub(runner, '_registerLambdaModules').callsFake(async () => {
      runner._context.evalSync(`
        globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };
        globalThis['lambda_lambda-1'] = class {
          async execute() { lambda.setResult({ userId: lambdaInfo.userId, callerType: lambdaInfo.callerType, callerId: lambdaInfo.callerId, info: lambdaInfo, execution: lambdaExecution, userToken: lambdaInfo.userToken ?? null, appToken: buttressOptions.appToken, headers: lambda.req.headers }); }
        };
      `);
    });
    const lambda = {
      id: 'lambda-1', name: 'hello-world', trigger: [].concat(trigger),
      git: { url: 'git@example.com:hello-world.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
    };
    const headers = JSON.stringify({ authorization: 'Bearer caller-token-value', cookie: 'session=s', 'x-trace': 't' });
    const exec = { id: 'exec-1', lambdaId: 'lambda-1', deploymentId: 'deployment-1', metadata: [], ...execution };

    const savedApp = { protocol: Config.app.protocol, host: Config.app.host };
    Config.app.protocol = 'http';
    Config.app.host = 'buttress.test';
    // The run the lambda's host functions act for, whose caller the host keeps
    const runs = sinon.spy(LambdaRun, 'start');
    try {
      await runner.execute(lambda, exec, { id: 'app-1', apiPath: 'test' }, 'API_ENDPOINT', { reqId: 'req-1', headers });
    } finally {
      Object.assign(Config.app, savedApp);
      runner._isolate.dispose();
    }
    const resultCall = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
    return { ...JSON.parse(resultCall.args[1]).res, hostCaller: runs.returnValues[0].caller };
  }

  it("gives an endpoint that doesn't use the caller's token neither the token nor its credential headers", async function () {
    this.timeout(10000);
    const seen = await given({ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } }, {});

    assert.strictEqual(seen.userToken, null);
    assert.strictEqual(seen.hostCaller, null);
    assert.deepStrictEqual(seen.headers, { 'x-trace': 't' });
  });

  it("tells an endpoint that uses the caller's token who called it, without giving it their token", async function () {
    this.timeout(10000);
    const seen = await given(
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: true } },
      { _tokenId: 'caller-token' },
      'user',
    );

    assert.strictEqual(seen.userId, 'user-1');
    assert.strictEqual(seen.userToken, null);
    assert.strictEqual(seen.hostCaller.token, 'caller-token-value');
    const { hostCaller, ...inIsolate } = seen;
    assert.ok(!JSON.stringify(inIsolate).includes('caller-token-value'));
  });

  it("tells a lambda who called it by the owner of the token, whatever type it is", async function () {
    this.timeout(10000);
    const trigger = { type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } };
    const owners = [];
    for (const type of ['user', 'lambda', 'app']) {
      const seen = await given(trigger, { _callerTokenId: 'caller-token' }, type);
      owners.push([seen.callerType, seen.callerId]);
      sinon.restore();
    }

    assert.deepStrictEqual(owners, [['user', 'user-1'], ['lambda', 'lambda-2'], ['app', 'app-1']]);
  });

  it("tells a lambda who called it when it runs as the caller too", async function () {
    this.timeout(10000);
    const seen = await given(
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: true } },
      { _tokenId: 'caller-token', _callerTokenId: 'caller-token' },
      'user',
    );

    assert.deepStrictEqual([seen.callerType, seen.callerId], ['user', 'user-1']);
  });

  it("gives a lambda who called it, never the token's id or value, when it doesn't run as the caller", async function () {
    this.timeout(10000);
    const seen = await given(
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } },
      { _callerTokenId: 'caller-token' },
      'user',
    );

    assert.strictEqual(seen.hostCaller, null);
    assert.strictEqual(seen.appToken, 'lambda-token');
    const everything = JSON.stringify({ info: seen.info, execution: seen.execution });
    assert.ok(!everything.includes('caller-token'));
    assert.ok(!('_callerTokenId' in seen.execution));
  });

  it("has no caller to tell a lambda that wasn't called by a token of its app", async function () {
    this.timeout(10000);
    const seen = await given({ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } }, {});

    assert.deepStrictEqual([seen.callerType, seen.callerId], [null, null]);
  });

  it("has no caller to tell a lambda when the token that called it has no owner of a type it knows", async function () {
    this.timeout(10000);
    const seen = await given(
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } },
      { _callerTokenId: 'caller-token' },
      'system',
    );

    assert.deepStrictEqual([seen.callerType, seen.callerId], [null, null]);
  });

  it("still runs a lambda whose caller's token has been deleted since it was queued, with no caller to tell it", async function () {
    this.timeout(10000);
    const seen = await given(
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } },
      { _callerTokenId: 'deleted-token' },
      'user',
    );

    assert.deepStrictEqual([seen.callerType, seen.callerId], [null, null]);
  });

  it("has no user to tell an endpoint that doesn't use the caller's token", async function () {
    this.timeout(10000);
    const seen = await given({ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } }, {});

    assert.ok(seen.userId === null || seen.userId === undefined);
  });

  it("has no user to tell an endpoint called with an app token", async function () {
    this.timeout(10000);
    const seen = await given({ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: true } }, { _tokenId: 'caller-token' });

    assert.ok(seen.userId === null || seen.userId === undefined);
  });

  it("goes by the endpoint the call was made to, of a lambda's several", async function () {
    this.timeout(10000);
    const triggers = [
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'a', method: 'GET', useCallerToken: false } },
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'b', method: 'POST', useCallerToken: true } },
    ];
    const metadata = [{ key: 'API_ENDPOINT', value: JSON.stringify({ url: 'b', method: 'POST' }) }];

    const seen = await given(triggers, { _tokenId: 'caller-token', metadata });

    assert.strictEqual(seen.hostCaller.token, 'caller-token-value');
  });

  it("keeps the caller's token on the host for an endpoint that uses it, giving the lambda a placeholder for it", async function () {
    this.timeout(10000);
    const seen = await given({ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: true } }, { _tokenId: 'caller-token' });

    assert.strictEqual(seen.hostCaller.token, 'caller-token-value');
    assert.strictEqual(seen.userToken, null);
    assert.strictEqual(seen.appToken, 'BUTTRESS_CALLER');
    const { hostCaller, ...inIsolate } = seen;
    assert.ok(!JSON.stringify(inIsolate).includes('caller-token-value'));
    assert.deepStrictEqual(seen.headers, { 'x-trace': 't' });
  });
});

describe('lambda/LambdaRunner:execute apps kept apart', () => {
  let savedPaths;
  let tmpDir;

  beforeEach(() => {
    savedPaths = { ...Config.paths.lambda };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-apps-'));
    const bundles = path.join(tmpDir, 'bundles');
    fs.mkdirSync(bundles);
    fs.mkdirSync(path.join(tmpDir, 'plugins'));
    Config.paths.lambda.plugins = path.join(tmpDir, 'plugins');
    Config.paths.lambda.bundles = bundles;
    fs.writeFileSync(path.join(bundles, 'buttress_stub.js'),
      'globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };');
    // App A's lambda puts its own class where app B's lambda module goes
    fs.writeFileSync(path.join(bundles, 'lambda_la.js'), `globalThis['lambda_la'] = class {
      async execute() {
        globalThis['lambda_lb'] = class { async execute() { lambda.setResult({ by: 'app-a' }); } };
        lambda.setResult({ by: 'app-a' });
      }
    };`);
    fs.writeFileSync(path.join(bundles, 'lambda_lb.js'),
      `globalThis['lambda_lb'] = class { async execute() { lambda.setResult({ by: 'app-b' }); } };`);
  });

  afterEach(() => {
    Object.assign(Config.paths.lambda, savedPaths);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs each app's lambdas apart from other apps', so one can't replace another's code", async function () {
    this.timeout(10000);
    const { runner, nrp } = createRunner();
    await runner.init();
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v }],
        [TokenSchemaModel, { createId: (v) => v, find: async () => Readable.from([{ value: 'lambda-token' }]) }],
        [LambdaExecutionSchemaModel, {
          ...fakeExecutionModel({ updateById: sinon.stub().resolves() }),
          findById: async (id) => ({ id, status: 'RUNNING', metadata: [] }),
        }],
      ]),
    );
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    sinon.stub(runner, '_getLambdaModulesName').callsFake((lambda) => [
      { name: 'buttress_stub', packageName: 'buttress_stub' },
      { name: `lambda_${lambda.id}` },
    ]);

    const run = async (lambdaId, appId) => {
      nrp.emit.resetHistory();
      const lambda = {
        id: lambdaId, name: lambdaId, trigger: [],
        git: { url: 'git@example.com:x.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
      };
      const execution = { id: `exec-${lambdaId}`, lambdaId, deploymentId: 'd', metadata: [] };
      await runner.execute(lambda, execution, { id: appId, apiPath: appId }, 'API_ENDPOINT', { reqId: 'r' });
      const resultCall = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
      return JSON.parse(resultCall.args[1]).res.by;
    };

    assert.strictEqual(await run('lb', 'app-b'), 'app-b');
    assert.strictEqual(await run('la', 'app-a'), 'app-a');
    assert.strictEqual(await run('lb', 'app-b'), 'app-b');
    runner._isolate.dispose();
  });
});

describe('lambda/LambdaRunner:execute deployed code', () => {
  let savedPaths;
  let savedDevReload;
  let tmpDir;

  beforeEach(() => {
    savedPaths = { ...Config.paths.lambda };
    savedDevReload = Config.lambda.devReload;
    Config.lambda.devReload = 'FALSE';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-deployed-'));
    Config.paths.lambda.code = path.join(tmpDir, 'code');
    Config.paths.lambda.bundles = path.join(tmpDir, 'bundles');
    Config.paths.lambda.plugins = path.join(tmpDir, 'plugins');
    [Config.paths.lambda.code, Config.paths.lambda.bundles, Config.paths.lambda.plugins].forEach((dir) =>
      fs.mkdirSync(dir),
    );
    // The package bundles are already built, so only the lambda's own code is bundled
    const bundle = (name, source) => fs.writeFileSync(path.join(Config.paths.lambda.bundles, `${name}.js`), source);
    bundle('@buttress_api', 'var Buttress = { clean() {}, initialised: false, init: async () => {} };');
    bundle('sugar', 'var Sugar = {};');
  });

  afterEach(() => {
    Object.assign(Config.paths.lambda, savedPaths);
    Config.lambda.devReload = savedDevReload;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Checks out code at a hash that sets the result to `by`
  function checkout(hash, by) {
    const dir = path.join(Config.paths.lambda.code, `lambda-${hash}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `class Lambda { execute() { lambda.setResult({ by: '${by}' }); } }\nmodule.exports = Lambda;\n`,
    );
  }

  async function createDeployedRunner() {
    const { runner, nrp } = createRunner();
    await runner.init();
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v }],
        [TokenSchemaModel, { createId: (v) => v, find: async () => Readable.from([{ value: 'lambda-token' }]) }],
        [
          LambdaExecutionSchemaModel,
          {
            ...fakeExecutionModel({ updateById: sinon.stub().resolves() }),
            findById: async (id) => ({ id, status: 'RUNNING', metadata: [] }),
          },
        ],
      ]),
    );
    const run = async (hash) => {
      nrp.emit.resetHistory();
      const lambda = {
        id: 'l1',
        name: 'l1',
        trigger: [],
        git: { url: 'git@example.com:x.git', hash, entryFile: 'index.js', entryPoint: 'execute' },
      };
      const execution = { id: 'exec-1', lambdaId: 'l1', deploymentId: 'd', metadata: [] };
      await runner.execute(lambda, execution, { id: 'app-1', apiPath: 'app' }, 'API_ENDPOINT', { reqId: 'r' });
      const resultCall = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
      return JSON.parse(resultCall.args[1]).res.by;
    };
    return { runner, run };
  }

  it("runs a redeployed lambda's new code", async function () {
    this.timeout(60000);
    checkout('aaaaaaa', 'first');
    checkout('bbbbbbb', 'second');
    const { runner, run } = await createDeployedRunner();

    assert.strictEqual(await run('aaaaaaa'), 'first');
    assert.strictEqual(await run('bbbbbbb'), 'second');
    runner._isolate.dispose();
  });

  it("builds a pinned hash's code once, and runs that build after", async function () {
    this.timeout(60000);
    checkout('aaaaaaa', 'first');
    const { runner, run } = await createDeployedRunner();

    assert.strictEqual(await run('aaaaaaa'), 'first');
    // Nothing is left to build it from, so a second build would fail
    fs.rmSync(path.join(Config.paths.lambda.code, 'lambda-aaaaaaa'), { recursive: true });
    assert.strictEqual(await run('aaaaaaa'), 'first');
    runner._isolate.dispose();
  });

  it('builds code deployed at HEAD again for every run, as HEAD moves', async function () {
    this.timeout(60000);
    checkout('HEAD', 'first');
    const { runner, run } = await createDeployedRunner();

    assert.strictEqual(await run('HEAD'), 'first');
    checkout('HEAD', 'second');
    assert.strictEqual(await run('HEAD'), 'second');
    runner._isolate.dispose();
  });
});

describe('lambda/LambdaRunner:_useAppContext', () => {
  let savedPlugins;
  let tmpDir;

  beforeEach(() => {
    savedPlugins = Config.paths.lambda.plugins;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-contexts-'));
    Config.paths.lambda.plugins = tmpDir;
  });

  afterEach(() => {
    Config.paths.lambda.plugins = savedPlugins;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps an app its own context, and lets the least recently used go past the limit', async () => {
    const { runner } = createRunner();
    await runner.init();
    sinon.stub(LambdaRunner, 'Constants').get(() => ({ TIMEOUT: 10000, APP_CONTEXTS: 2 }));

    runner._useAppContext('app-1');
    const first = runner._context;
    runner._useAppContext('app-2');
    runner._useAppContext('app-1');
    assert.strictEqual(runner._context, first);

    runner._useAppContext('app-3');
    assert.deepStrictEqual([...runner._appContexts.keys()], ['app-1', 'app-3']);
    runner._isolate.dispose();
  });
});

describe('lambda/LambdaRunner:execute isolate memory', () => {
  let savedPaths;
  let tmpDir;
  let runners;

  beforeEach(() => {
    savedPaths = { ...Config.paths.lambda };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-memory-'));
    Config.paths.lambda.bundles = path.join(tmpDir, 'bundles');
    Config.paths.lambda.plugins = path.join(tmpDir, 'plugins');
    fs.mkdirSync(Config.paths.lambda.bundles);
    fs.mkdirSync(Config.paths.lambda.plugins);
    fs.writeFileSync(
      path.join(Config.paths.lambda.bundles, 'buttress_stub.js'),
      'globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };',
    );
    ['log', 'logError'].forEach((level) => sinon.stub(Logging, level));
    runners = [];
  });

  afterEach(() => {
    runners.forEach((runner) => {
      if (!runner._isolate.isDisposed) runner._isolate.dispose();
    });
    Object.assign(Config.paths.lambda, savedPaths);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // How much of its heap limit an isolate has in use, as the heap alone and with the memory outside it
  function heapUse(isolate) {
    const { used_heap_size, externally_allocated_size, heap_size_limit } = isolate.getHeapStatisticsSync();
    return {
      heap: used_heap_size / heap_size_limit,
      all: (used_heap_size + externally_allocated_size) / heap_size_limit,
    };
  }

  // A runner whose isolate has `memoryLimit` MB, and whose lambdas are the bundles written to the bundles folder. Tests only
  // allocate in small steps, up to a limit of their own, so an isolate that isn't stopped can't run away with the memory.
  async function createMemoryRunner({ memoryLimit = 32 } = {}) {
    // The runner's constants, which a test can change as it goes
    const constants = LambdaRunner.Constants;
    const limits = { MEMORY_LIMIT: memoryLimit, HEAP_RECYCLE_THRESHOLD: constants.HEAP_RECYCLE_THRESHOLD };
    sinon.stub(LambdaRunner, 'Constants').get(() => ({ ...constants, ...limits }));
    const { runner, nrp } = createRunner();
    await runner.init();
    runners.push(runner);

    // The lambda and execution the runner is handed when told to execute one, for tests that go through its messages
    const handled = { lambda: null, execution: null };
    const updateById = sinon.stub().resolves();
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v, findById: async () => ({ id: 'app-1', apiPath: 'app-1' }) }],
        [LambdaSchemaModel, { createId: (v) => v, findById: async () => handled.lambda }],
        [TokenSchemaModel, { createId: (v) => v, find: async () => Readable.from([{ value: 'lambda-token' }]) }],
        [LambdaExecutionSchemaModel, {
          ...fakeExecutionModel({ updateById }),
          findOne: async () => handled.execution,
          findById: async (id) => ({ id, status: 'RUNNING', metadata: [] }),
        }],
      ]),
    );
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    sinon.stub(runner, '_getLambdaModulesName').callsFake((lambda) => [
      { name: 'buttress_stub', packageName: 'buttress_stub' },
      { name: `lambda_${lambda.id}` },
    ]);
    // Lets a test take over loading a lambda's modules into the isolate
    const hooks = { register: null };
    const registerModules = runner._registerLambdaModules.bind(runner);
    sinon.stub(runner, '_registerLambdaModules').callsFake((modules) =>
      hooks.register ? hooks.register() : registerModules(modules));

    let runs = 0;
    // Runs a new lambda as an app. `entry` is what its entry point does, and `load` runs as its module is loaded into the
    // app's context. Gives what the API caller was told: `res` of a lambda that ran, or `err` of one that didn't.
    const run = async (entry, { appId = 'app-1', load = '' } = {}) => {
      const id = `l${++runs}`;
      fs.writeFileSync(
        path.join(Config.paths.lambda.bundles, `lambda_${id}.js`),
        `${load}\nglobalThis['lambda_${id}'] = class { async execute() { ${entry} } };`,
      );
      const lambda = {
        id, name: id, trigger: [],
        git: { url: 'git@example.com:x.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
      };
      const execution = { id: `exec-${id}`, lambdaId: id, deploymentId: 'd', metadata: [] };

      nrp.emit.resetHistory();
      let thrown;
      await runner.execute(lambda, execution, { id: appId, apiPath: appId }, 'API_ENDPOINT', { reqId: 'r' })
        .catch((err) => { thrown = err; });
      const result = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
      // With no result, it failed before it could be answered
      return result ? JSON.parse(result.args[1]) : { code: 0, err: thrown?.message };
    };
    return { runner, nrp, hooks, limits, handled, run, updateById };
  }

  it('starts a new isolate when a lambda runs the old one out of memory, so the next lambda runs', async function () {
    this.timeout(10000);
    const { runner, hooks, run, updateById } = await createMemoryRunner({ memoryLimit: 8 });
    const first = runner._isolate;
    // Fills the isolate in small steps, as loading module after module into new contexts did. The loop stops short, with an
    // error that isn't the isolate's, if it's never disposed.
    hooks.register = async () => {
      for (let step = 0; step < 400; step++) {
        runner._context.evalSync('(globalThis.kept ||= []).push(new Array(12500).fill(1));');
      }
      throw new Error('the isolate was never run out of memory');
    };

    const failed = await run('lambda.setResult({ ran: true });');

    assert.strictEqual(failed.code, 400);
    assert.match(failed.err, /memory limit/);
    // The failure stays an error, and the lambda isn't run again: it may have had side effects by the time it failed
    const statuses = updateById.getCalls().map((call) => call.args[1].$set?.status).filter(Boolean);
    assert.deepStrictEqual(statuses, ['RUNNING', 'ERROR']);
    assert.ok(first.isDisposed);
    assert.notStrictEqual(runner._isolate, first);
    assert.strictEqual(runner._isolate.isDisposed, false);
    assert.ok(Logging.logError.calledWithMatch(/isolate was disposed/i));

    hooks.register = null;
    const next = await run('lambda.setResult({ ran: true });');
    assert.strictEqual(next.code, 200, next.err);
    assert.deepStrictEqual(next.res, { ran: true });
  });

  it('starts a new isolate if the one it has was disposed between lambdas', async function () {
    this.timeout(10000);
    const { runner, run } = await createMemoryRunner();
    const first = runner._isolate;
    first.dispose();

    const result = await run('lambda.setResult({ ran: true });');

    assert.strictEqual(result.code, 200, result.err);
    assert.deepStrictEqual(result.res, { ran: true });
    assert.notStrictEqual(runner._isolate, first);
    assert.ok(Logging.logError.calledWithMatch(/isolate was disposed/i));
  });

  it('starts a new isolate before a lambda when most of its heap is in use', async function () {
    this.timeout(10000);
    const { runner, limits, run } = await createMemoryRunner({ memoryLimit: 32 });
    const first = runner._isolate;
    // The app's context holds about 24 MB of a 35 MB heap
    const loaded = await run('lambda.setResult({ ran: true });', {
      load: 'globalThis.kept = Array.from({ length: 300 }, () => new Array(10000).fill(1));',
    });
    assert.strictEqual(loaded.code, 200, loaded.err);
    const inUse = heapUse(first).all;
    assert.ok(inUse > limits.HEAP_RECYCLE_THRESHOLD && inUse < 1, `${inUse} of the heap is in use`);

    const next = await run('lambda.setResult({ kept: typeof globalThis.kept });');

    assert.strictEqual(next.code, 200, next.err);
    assert.deepStrictEqual(next.res, { kept: 'undefined' });
    assert.ok(first.isDisposed);
    assert.notStrictEqual(runner._isolate, first);
    assert.ok(Logging.log.calledWithMatch(/heap in use, starting a new one/));
  });

  it("keeps the isolate, and what an app's lambdas loaded into it, while its heap has room", async function () {
    this.timeout(10000);
    const { runner, run } = await createMemoryRunner({ memoryLimit: 32 });
    const first = runner._isolate;
    await run('lambda.setResult({ ran: true });', {
      load: 'globalThis.kept = Array.from({ length: 100 }, () => new Array(10000).fill(1));',
    });

    const next = await run('lambda.setResult({ kept: typeof globalThis.kept });');

    assert.deepStrictEqual(next.res, { kept: 'object' });
    assert.strictEqual(runner._isolate, first);
    assert.strictEqual(first.isDisposed, false);
  });

  // The threshold is set either side of what the isolate really has in use, as an isolate's statistics can't be stubbed
  it('keeps an isolate whose heap use is under the threshold', async function () {
    this.timeout(10000);
    const { runner, limits, run } = await createMemoryRunner();
    const first = runner._isolate;
    limits.HEAP_RECYCLE_THRESHOLD = heapUse(first).all + 0.1;

    const result = await run('lambda.setResult({ ran: true });');

    assert.strictEqual(result.code, 200, result.err);
    assert.strictEqual(runner._isolate, first);
  });

  it('replaces an isolate whose heap use is over the threshold', async function () {
    this.timeout(10000);
    const { runner, limits, run } = await createMemoryRunner();
    const first = runner._isolate;
    limits.HEAP_RECYCLE_THRESHOLD = heapUse(first).all / 2;

    const result = await run('lambda.setResult({ ran: true });');

    assert.strictEqual(result.code, 200, result.err);
    assert.notStrictEqual(runner._isolate, first);
  });

  it('counts memory outside the heap, which also counts against the isolate limit', async function () {
    this.timeout(10000);
    const { runner, limits, run } = await createMemoryRunner();
    const first = runner._isolate;
    await run('lambda.setResult({ ran: true });', { load: 'globalThis.buffer = new ArrayBuffer(4 * 1024 * 1024);' });
    // About 4 MB of a 35 MB heap limit is outside the heap
    const use = heapUse(first);
    assert.ok(use.all - use.heap > 0.1, `${use.all} of the limit is in use, ${use.heap} of it in the heap`);
    // The heap alone is under the threshold, and with the memory outside it the isolate is over it
    limits.HEAP_RECYCLE_THRESHOLD = (use.heap + use.all) / 2;

    const next = await run('lambda.setResult({ ran: true });');

    assert.strictEqual(next.code, 200, next.err);
    assert.notStrictEqual(runner._isolate, first);
  });

  it('cycles through more apps than fit in the heap without a lambda failing', async function () {
    this.timeout(30000);
    const { runner, run } = await createMemoryRunner({ memoryLimit: 32 });
    const createIsolate = sinon.spy(runner, '_createIsolate');
    // An app's context holds about 2 MB, so these 40 are more than twice the heap
    const load = 'globalThis.kept = Array.from({ length: 25 }, () => new Array(10000).fill(1));';

    const failures = [];
    for (let app = 1; app <= 40; app++) {
      const result = await run('lambda.setResult({ ran: true });', { appId: `app-${app}`, load });
      if (result.code !== 200) failures.push({ app, err: result.err });
    }

    assert.deepStrictEqual(failures, []);
    assert.ok(createIsolate.callCount >= 2, `${createIsolate.callCount} new isolates`);
  });

  it("doesn't replace the isolate while a lambda is running in it", async function () {
    this.timeout(10000);
    const { runner, nrp, hooks, limits, handled } = await createMemoryRunner();
    runner._subscribeToLambdaManager();
    const first = runner._isolate;
    handled.lambda = {
      id: 'lambda-1', _appId: 'app-1', name: 'held', trigger: [],
      git: { url: 'git@example.com:x.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
    };
    handled.execution = {
      id: 'exec-1', lambdaId: 'lambda-1', deploymentId: 'd', status: 'PENDING',
      metadata: [{ key: 'REQ_ID', value: 'req-1' }],
    };
    // The lambda runs until the test lets it finish, with nothing loaded into the isolate
    hooks.register = async () => {};
    const running = [];
    sinon.stub(runner, '_runLambdaScript').callsFake(() => new Promise((resolve) => running.push(resolve)));

    const until = async (condition) => {
      for (let turn = 0; turn < 500 && !condition(); turn++) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(condition(), 'timed out waiting');
    };
    const finished = () => nrp.emit.getCalls().filter((call) => call.args[0] === 'lambda:worker:finished').length;
    const offer = (executionId) => nrp._listeners['lambda:worker:execute'](
      JSON.stringify({ workerId: runner.id, lambdaId: 'lambda-1', lambdaType: 'API_ENDPOINT', executionId }),
    );

    offer('exec-1');
    await until(() => running.length === 1);
    // The heap is full by now, so the next lambda would start in a new isolate
    limits.HEAP_RECYCLE_THRESHOLD = 0;
    offer('exec-2');

    assert.ok(nrp.emit.calledWith('lambda:worker:overloaded'));
    assert.strictEqual(runner._isolate, first);
    assert.strictEqual(first.isDisposed, false);

    running[0]();
    await until(() => finished() === 1);
    offer('exec-3');
    await until(() => running.length === 2);

    assert.notStrictEqual(runner._isolate, first);
    assert.ok(first.isDisposed);
    running[1]();
    await until(() => finished() === 2);
  });
});

// One isolate runs every lambda, and an app's context is kept between its runs, so work a lambda leaves running when it
// returns could otherwise go on into a later run and act for it: answer its caller, log into its execution, update its
// lambda's metadata or call this instance with its caller's token.
describe('lambda/LambdaRunner:execute runs kept apart', () => {
  let savedPaths;
  let savedAllowed;
  let savedApp;
  let tmpDir;
  let server;

  beforeEach(async () => {
    savedPaths = { ...Config.paths.lambda };
    savedAllowed = Config.lambda.allowedHosts;
    savedApp = { protocol: Config.app.protocol, host: Config.app.host };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-runs-'));
    Config.paths.lambda.plugins = tmpDir;
    Config.lambda.allowedHosts = '';
    ['log', 'logDebug', 'logWarn', 'logError'].forEach((level) => sinon.stub(Logging, level));

    // This Buttress instance, which records the requests it gets. /slow answers after 300 ms.
    server = await new Promise((resolve) => {
      const requests = [];
      const instance = http.createServer((req, res) => {
        const request = { url: req.url, authorization: req.headers.authorization, closedEarly: false };
        requests.push(request);
        res.on('close', () => (request.closedEarly = !res.writableEnded));
        setTimeout(() => res.end('{}'), req.url === '/slow' ? 300 : 0);
      });
      instance.listen(0, '127.0.0.1', () => resolve({ instance, requests, port: instance.address().port }));
    });
    Config.app.protocol = 'http';
    Config.app.host = `127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    Object.assign(Config.paths.lambda, savedPaths);
    Config.lambda.allowedHosts = savedAllowed;
    Object.assign(Config.app, savedApp);
    server.instance.closeAllConnections();
    server.instance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // A runner whose lambdas' entry points are the bodies they're run with, in its real isolate. run() gives what the API
  // caller was answered and the logs saved with the execution.
  async function createRunsRunner() {
    const { runner, nrp } = createRunner();
    await runner.init();
    const executionUpdates = sinon.stub().resolves();
    const lambdaUpdates = sinon.stub().resolves();
    const callerToken = { id: 'caller-token', value: 'caller-token-value', type: 'app', _appId: 'app-b' };
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v, updateById: lambdaUpdates }],
        [TokenSchemaModel, {
          createId: (v) => v,
          find: async (query) => Readable.from([query._id ? callerToken : { value: 'lambda-token' }]),
          findById: async () => null,
        }],
        [LambdaExecutionSchemaModel, {
          ...fakeExecutionModel({ updateById: executionUpdates }),
          findById: async (id) => ({ id, status: 'RUNNING', metadata: [] }),
        }],
      ]),
    );
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    sinon.stub(runner, '_getLambdaModulesName').callsFake((lambda) => [{ name: `lambda_${lambda.id}` }]);
    let body = '';
    sinon.stub(runner, '_registerLambdaModules').callsFake(async ([mod]) => {
      runner._context.evalSync(`
        globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };
        globalThis['${mod.name}'] = class { async execute() { ${body} } };
      `);
    });

    let runs = 0;
    const run = async ({ lambdaId, appId, lambdaBody, trigger = [], execution = {} }) => {
      body = lambdaBody;
      nrp.emit.resetHistory();
      const lambda = {
        id: lambdaId, name: lambdaId, trigger,
        git: { url: 'git@example.com:x.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
      };
      const exec = { id: `exec-${++runs}`, lambdaId, deploymentId: 'd', metadata: [], ...execution };
      await runner.execute(lambda, exec, { id: appId, apiPath: appId }, 'API_ENDPOINT', { reqId: `req-${runs}` });
      const resultCall = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
      const completed = executionUpdates.getCalls().find((call) => call.args[0] === exec.id && call.args[1].$push);
      return { res: JSON.parse(resultCall.args[1]).res, logs: completed.args[1].$push.logs.$each };
    };
    return { runner, run, lambdaUpdates };
  }

  // Work a lambda leaves running when it returns, which acts 50 ms later
  const leftBehind = `
    sleep(50).then(() => {
      lambda.setResult({ by: 'the first run' });
      lambda.log('logged by the first run');
      updateMetadata({ idx: -1, key: 'by', value: 'the first run' });
      fetch({ url: buttressOptions.buttressUrl + '/x', options: { headers: { Authorization: 'Bearer BUTTRESS_CALLER' } } });
    });
  `;
  const laterRun = "await sleep(200); lambda.log('logged by the second run');";

  for (const [name, first, second] of [
    ["another app's", { lambdaId: 'la', appId: 'app-a' }, { lambdaId: 'lb', appId: 'app-b' }],
    ["the same app's", { lambdaId: 'lb', appId: 'app-b' }, { lambdaId: 'lb', appId: 'app-b' }],
  ]) {
    it(`doesn't let work ${name} last run left running act for the next`, async function () {
      this.timeout(10000);
      const { runner, run, lambdaUpdates } = await createRunsRunner();

      try {
        await run({ ...first, lambdaBody: leftBehind });
        const later = await run({
          ...second,
          lambdaBody: laterRun,
          trigger: [{ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: true } }],
          execution: { _tokenId: 'caller-token' },
        });

        assert.strictEqual(later.res, 'success');
        assert.deepStrictEqual(later.logs, [{ log: 'logged by the second run', type: 'log' }]);
        assert.ok(!lambdaUpdates.calledWith('lb'), "the first run's work shouldn't update the second lambda's metadata");
        assert.deepStrictEqual(server.requests, []);
      } finally {
        runner._isolate.dispose();
      }
    });
  }

  it('aborts a request a lambda leaves running when it returns, rather than answer the next run with it', async function () {
    this.timeout(10000);
    const { runner, run } = await createRunsRunner();

    try {
      await run({
        lambdaId: 'la', appId: 'app-a',
        // Returns once the request has reached the instance, which is still answering it
        lambdaBody: "fetch(buttressOptions.buttressUrl + '/slow').then(() => lambda.setResult({ by: 'app-a' })); await sleep(100);",
      });
      const later = await run({ lambdaId: 'la', appId: 'app-a', lambdaBody: 'await sleep(500);' });

      assert.strictEqual(later.res, 'success');
      assert.deepStrictEqual(server.requests.map(({ url, closedEarly }) => ({ url, closedEarly })), [
        { url: '/slow', closedEarly: true },
      ]);
    } finally {
      runner._isolate.dispose();
    }
  });
});
