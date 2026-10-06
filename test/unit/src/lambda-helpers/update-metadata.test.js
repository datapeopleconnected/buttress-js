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

import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sinon from 'sinon';
import ivm from 'isolated-vm';
import createConfig from '@dpc/node-env-obj';

import LambdaHelpers from '../../../../dist/lambda-helpers/helpers.js';
import LambdaRun from '../../../../dist/lambda-helpers/lambda-run.js';
import Model from '../../../../dist/model/index.js';
import LambdaSchemaModel from '../../../../dist/model/core/lambda.js';

const Config = createConfig();

const LAMBDA_ID = '507f1f77bcf86cd799439011';
const OTHER_LAMBDA_ID = '507f1f77bcf86cd799439012';

// What a call the host doesn't answer comes to: its promise never settles
const answered = (promise) =>
  Promise.race([
    promise.then(() => 'answered', () => 'answered'),
    new Promise((resolve) => setTimeout(() => resolve('unanswered'), 100)),
  ]);

// Calls updateMetadata from inside a live isolate, as a lambda does. It only ever updates the executing lambda.
describe('lambda-helpers/Helpers:updateMetadata', () => {
  let tmpDir;
  let savedPaths;
  let isolate;
  let context;
  let updateById;
  let run;

  const update = (data) =>
    context.eval(`updateMetadata(${JSON.stringify(data)})`, { promise: true, copy: true, timeout: 5000 });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-update-metadata-'));
    savedPaths = { ...Config.paths.lambda };
    Config.paths.lambda.plugins = tmpDir;

    isolate = new ivm.Isolate();
    context = await isolate.createContext();
    await LambdaHelpers._createIsolateContext(isolate, context, context.global);
  });

  after(() => {
    isolate.dispose();
    Object.assign(Config.paths.lambda, savedPaths);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    updateById = sinon.stub().resolves();
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass !== LambdaSchemaModel) throw new Error(`Unexpected core model ${modelClass?.name}`);
      return { createId: (v) => v, updateById };
    });
    run = LambdaRun.start(context, { lambdaId: LAMBDA_ID, lambdaGitHash: null });
  });

  afterEach(() => {
    run.end();
    sinon.restore();
  });

  it("adds and sets the executing lambda's metadata", async () => {
    await update({ id: LAMBDA_ID, idx: -1, key: 'cursor', value: 'a' });
    await update({ id: LAMBDA_ID, idx: 0, key: 'cursor', value: 'b' });

    assert.deepStrictEqual(updateById.args, [
      [LAMBDA_ID, { $push: { metadata: { key: 'cursor', value: 'a' } } }],
      [LAMBDA_ID, { $set: { 'metadata.0.value': 'b' } }],
    ]);
  });

  it('refuses to update another lambda', async () => {
    await assert.rejects(update({ id: OTHER_LAMBDA_ID, idx: -1, key: 'cursor', value: 'a' }), /invalid_lambda_id/);
    await assert.rejects(update({ id: OTHER_LAMBDA_ID, idx: 0, key: 'cursor', value: 'a' }), /invalid_lambda_id/);

    assert.strictEqual(updateById.callCount, 0);
  });

  it('refuses an index that is not a whole number from -1 up', async () => {
    for (const idx of [-2, 1.5, '0', '0.key', null]) {
      await assert.rejects(update({ id: LAMBDA_ID, idx, key: 'cursor', value: 'a' }), /invalid_metadata_index/);
    }

    assert.strictEqual(updateById.callCount, 0);
  });

  it('refuses a call once the run has ended, leaving it unanswered', async () => {
    run.end();

    assert.strictEqual(await answered(update({ idx: -1, key: 'cursor', value: 'a' })), 'unanswered');
    assert.strictEqual(updateById.callCount, 0);
  });

  it('refuses a call from a context other than the run\'s', async () => {
    const other = await isolate.createContext();
    await LambdaHelpers._createIsolateContext(isolate, other, other.global);

    const call = other.eval(`updateMetadata({ idx: -1, key: 'cursor', value: 'a' })`, { promise: true, timeout: 5000 });

    assert.strictEqual(await answered(call), 'unanswered');
    assert.strictEqual(updateById.callCount, 0);
    other.release();
  });
});

// fetch() from a live isolate, as a lambda calls it
describe('lambda-helpers/Helpers:fetch destinations', () => {
  let isolate;
  let context;
  let savedPlugins;
  let savedAllowed;
  let tmpDir;
  let run;

  const fetchFromLambda = (url) =>
    context.eval(`fetch(${JSON.stringify(url)}).then(() => 'fetched', (err) => 'refused: ' + (err && err.message))`, {
      promise: true, copy: true, timeout: 5000,
    });

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-fetch-'));
    savedPlugins = Config.paths.lambda.plugins;
    savedAllowed = Config.lambda.allowedHosts;
    Config.paths.lambda.plugins = tmpDir;
    isolate = new ivm.Isolate();
    context = await isolate.createContext();
    await LambdaHelpers._createIsolateContext(isolate, context, context.global);
    run = LambdaRun.start(context, { lambdaId: LAMBDA_ID, lambdaGitHash: null });
  });

  after(() => {
    run.end();
    isolate.dispose();
    Config.paths.lambda.plugins = savedPlugins;
    Config.lambda.allowedHosts = savedAllowed;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses a host that isn't on the lambda allow-list, or is at a private address", async () => {
    Config.lambda.allowedHosts = 'api.example.com, 127.0.0.1';

    assert.match(await fetchFromLambda('http://127.0.0.1:1/x'), /fetch_address_not_allowed/);
    assert.match(await fetchFromLambda('http://169.254.169.254/latest/meta-data'), /fetch_host_not_allowed/);
  });

  it('goes anywhere, as before, with no allow-list', async () => {
    Config.lambda.allowedHosts = '';

    const outcome = await fetchFromLambda('http://127.0.0.1:1/x');
    assert.doesNotMatch(outcome, /not_allowed/);
  });
});
