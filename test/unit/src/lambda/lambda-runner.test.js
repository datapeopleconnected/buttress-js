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
  async function runFailingLambda(updateById, lambdaTokens = [{ value: 'lambda-token' }]) {
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
        globalThis['lambda_failing'] = class { async execute() { throw new Error('lambda broke'); } };
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
      id: 'lambda-1', name: 'hello-world', trigger: [trigger],
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
