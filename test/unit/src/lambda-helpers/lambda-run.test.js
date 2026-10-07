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

import { describe, it, before, after, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import ivm from 'isolated-vm';
import createConfig from '@dpc/node-env-obj';

import LambdaHelpers from '../../../../dist/lambda-helpers/helpers.js';
import LambdaRun from '../../../../dist/lambda-helpers/lambda-run.js';
import Logging from '../../../../dist/helpers/logging.js';

const Config = createConfig();

const lambda = { lambdaId: 'lambda-1', lambdaGitHash: null };

describe('lambda-helpers/LambdaRun', () => {
  let isolate;
  let context;
  let other;
  let savedPlugins;
  let tmpDir;
  let run;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-run-'));
    savedPlugins = Config.paths.lambda.plugins;
    Config.paths.lambda.plugins = tmpDir;
    isolate = new ivm.Isolate();
    context = await isolate.createContext();
    await LambdaHelpers._createIsolateContext(isolate, context, context.global);
    other = await isolate.createContext();
  });

  afterEach(() => {
    run?.end();
    sinon.restore();
  });

  after(() => {
    isolate.dispose();
    Config.paths.lambda.plugins = savedPlugins;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is what a host function called from its context acts for, until it ends', () => {
    sinon.stub(Logging, 'logWarn');
    run = LambdaRun.start(context, lambda);

    assert.strictEqual(LambdaRun.in(context, '_log'), run);
    assert.strictEqual(LambdaRun.in(other, '_log'), null);

    run.end();
    assert.strictEqual(LambdaRun.in(context, '_log'), null);
    assert.ok(Logging.logWarn.calledWithMatch(/Refused _log/));
  });

  it('ends the run before it when another starts', () => {
    const first = LambdaRun.start(context, lambda);
    run = LambdaRun.start(context, lambda);

    assert.ok(first.ended);
    assert.strictEqual(LambdaRun.in(context, '_log'), run);
  });

  it('answers the isolate only while it is going', () => {
    run = LambdaRun.start(context, lambda);
    const callback = { applyIgnored: sinon.spy() };
    const answer = run.answer(callback);

    answer.applyIgnored(undefined, ['before']);
    run.end();
    answer.applyIgnored(undefined, ['after']);

    assert.deepStrictEqual(callback.applyIgnored.args, [[undefined, ['before']]]);
  });

  it('cancels the sleeps it leaves when it ends', async () => {
    // Other timers come and go meanwhile, but not 20
    const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    const atStart = timers();
    run = LambdaRun.start(context, lambda);

    context.evalSync('for (let i = 0; i < 20; i++) sleep(60000)');
    for (let turn = 0; turn < 100 && timers() < atStart + 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    const sleeping = timers();
    assert.ok(sleeping >= atStart + 20, `${sleeping - atStart} sleeps`);

    run.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(timers() <= sleeping - 20, `${sleeping - timers()} sleeps cancelled`);
  });

  it("keeps a run's log lines, as text, until they're taken", () => {
    run = LambdaRun.start(context, lambda);

    run.log('a log line', 'debug');
    run.log({ code: 7 }, 'error');

    assert.deepStrictEqual(run.takeLogs(), [
      { log: 'a log line', type: 'debug' },
      { log: '{"code":7}', type: 'error' },
    ]);
    assert.deepStrictEqual(run.takeLogs(), []);
  });
});
