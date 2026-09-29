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

    assert.strictEqual(compileScriptSync.callCount, 2);
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
