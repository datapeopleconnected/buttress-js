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
import { Readable } from 'node:stream';
import ivm from 'isolated-vm';
import createConfig from '@dpc/node-env-obj';

import LambdaRunner, { LambdaType } from '../../../../dist/lambda/lambda-runner.js';
import Model from '../../../../dist/model/index.js';
import LambdaSchemaModel from '../../../../dist/model/core/lambda.js';
import LambdaExecutionSchemaModel from '../../../../dist/model/core/lambda-execution.js';
import AppSchemaModel from '../../../../dist/model/core/app.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';
import SecureStoreSchemaModel from '../../../../dist/model/core/secure-store.js';
import DeploymentSchemaModel from '../../../../dist/model/core/deployment.js';
import Logging from '../../../../dist/helpers/logging.js';

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
      ['Buttress', 'LambdaSnippet', 'Sugar', 'lambda_lambda-1_abc123'],
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
    assert.deepStrictEqual(names.slice(0, 4), ['Buttress', 'LambdaSnippet', 'Sugar', 'shared_Snippet_abc123']);
    assert.match(names[4], /^lambda_lambda-1_abc123_[0-9a-f]{8}$/);
    const shared = modules[3];
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

    assert.throws(() => runner._getLambdaModulesName(lambda), { code: 400 });
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
  async function createLoggingRunner() {
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
    sinon.stub(runner, '_getLambdaModulesName').returns([{ name: 'lambda_logging' }]);
    sinon.stub(runner, 'bundleLambdaModules').resolves();
    let body = '';
    sinon.stub(runner, '_registerLambdaModules').callsFake(async () => {
      runner._context.evalSync(`
        globalThis.Buttress = { clean() {}, initialised: false, init: async () => {} };
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

  it('keeps each run to its own logs', async function () {
    this.timeout(10000);
    const runner = await createLoggingRunner();
    await runner.complete("lambda.log('first run');");

    const update = await runner.complete("lambda.log('second run');");

    runner.dispose();
    assert.deepStrictEqual(update.$push.logs.$each, [{ log: 'second run', type: 'log' }]);
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
    runner._isolate = {};
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
  async function given(trigger, execution) {
    const { runner, nrp } = createRunner();
    await runner.init();
    const callerToken = { id: 'caller-token', value: 'caller-token-value', type: 'app' };
    stubModel(
      new Map([
        [SecureStoreSchemaModel, { findOne: async () => null }],
        [AppSchemaModel, { createId: (v) => v }],
        [LambdaSchemaModel, { createId: (v) => v }],
        [TokenSchemaModel, {
          createId: (v) => v,
          find: async (query) => Readable.from([query._id ? callerToken : { value: 'lambda-token' }]),
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
          async execute() { lambda.setResult({ userToken: lambdaInfo.userToken ?? null, headers: lambda.req.headers }); }
        };
      `);
    });
    const lambda = {
      id: 'lambda-1', name: 'hello-world', trigger: [].concat(trigger),
      git: { url: 'git@example.com:hello-world.git', hash: 'HEAD', entryFile: 'index.js', entryPoint: 'execute' },
    };
    const headers = JSON.stringify({ authorization: 'Bearer caller-token-value', cookie: 'session=s', 'x-trace': 't' });
    const exec = { id: 'exec-1', lambdaId: 'lambda-1', deploymentId: 'deployment-1', metadata: [], ...execution };

    await runner.execute(lambda, exec, { id: 'app-1', apiPath: 'test' }, 'API_ENDPOINT', { reqId: 'req-1', headers });
    runner._isolate.dispose();
    const resultCall = nrp.emit.getCalls().find((call) => call.args[0] === 'lambda:worker:execution-result');
    return JSON.parse(resultCall.args[1]).res;
  }

  it("gives an endpoint that doesn't use the caller's token neither the token nor its credential headers", async function () {
    this.timeout(10000);
    const seen = await given({ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: false } }, {});

    assert.strictEqual(seen.userToken, null);
    assert.deepStrictEqual(seen.headers, { 'x-trace': 't' });
  });

  it("goes by the endpoint the call was made to, of a lambda's several", async function () {
    this.timeout(10000);
    const triggers = [
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'a', method: 'GET', useCallerToken: false } },
      { type: 'API_ENDPOINT', apiEndpoint: { url: 'b', method: 'POST', useCallerToken: true } },
    ];
    const metadata = [{ key: 'API_ENDPOINT', value: JSON.stringify({ url: 'b', method: 'POST' }) }];

    const seen = await given(triggers, { _tokenId: 'caller-token', metadata });

    assert.strictEqual(seen.userToken, 'caller-token-value');
  });

  it("gives an endpoint that uses the caller's token that token, without the credential headers", async function () {
    this.timeout(10000);
    const seen = await given({ type: 'API_ENDPOINT', apiEndpoint: { url: 'x', useCallerToken: true } }, { _tokenId: 'caller-token' });

    assert.strictEqual(seen.userToken, 'caller-token-value');
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
    bundle('@buttress_snippets', 'var LambdaSnippet = {};');
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
