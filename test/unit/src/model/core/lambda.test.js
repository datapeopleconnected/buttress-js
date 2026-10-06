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
import { execFileSync } from 'node:child_process';
import createConfig from '@dpc/node-env-obj';

import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';

import { createSchemaModel } from '../../../../schema-model.js';

const Config = createConfig();

// Runs the lambda model's git operations against a real local repository. Values that aren't a plain name,
// url, branch or hash are refused before git runs, so the marker file a shell would create never appears.
describe('model/core/LambdaSchemaModel:git source', () => {
  let tmpDir;
  let repo;
  let hash;
  let marker;
  let savedPaths;

  const model = Object.create(LambdaSchemaModel.prototype);
  const codeDir = () => Config.paths.lambda.code;
  const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-git-'));
    repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    gitIn(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'index.js'), 'export function run() {}\n');
    gitIn(repo, 'add', 'index.js');
    gitIn(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init');
    hash = gitIn(repo, 'rev-parse', 'HEAD');
    marker = path.join(tmpDir, 'marker');
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  beforeEach(() => {
    savedPaths = { ...Config.paths.lambda };
    Config.paths.lambda.code = path.join(tmpDir, `code-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(Config.paths.lambda.code);
  });

  afterEach(() => {
    Object.assign(Config.paths.lambda, savedPaths);
  });

  const assertRefused = async (promise, message) => {
    await assert.rejects(promise, (err) => {
      assert.strictEqual(err.status, 400);
      assert.strictEqual(err.code, message);
      return true;
    });
    assert.ok(!fs.existsSync(marker), 'a shell ran the value');
  };

  it('clones a repository and checks out the hash on the branch', async () => {
    await model.gitFolderClone(hash, 'main', 'hello-world', repo);

    assert.strictEqual(gitIn(path.join(codeDir(), 'lambda-hello-world'), 'rev-parse', 'HEAD'), hash);
  });

  it('refuses a branch that is not a plain branch name', async () => {
    await assertRefused(model.gitFolderClone(hash, `main; touch ${marker}`, 'x', repo), 'invalid_lambda_git_branch');
    await assertRefused(model.gitFolderClone(hash, '--output=x', 'x', repo), 'invalid_lambda_git_branch');
    await assertRefused(model.gitFolderClone(hash, { $ne: 1 }, 'x', repo), 'invalid_lambda_git_branch');
  });

  it('refuses a hash that is not a commit hash or HEAD', async () => {
    await assertRefused(model.gitFolderClone(`$(touch ${marker})`, 'main', 'x', repo), 'invalid_lambda_git_hash');
    await assertRefused(model.gitFolderClone('main', 'main', 'x', repo), 'invalid_lambda_git_hash');
  });

  it('refuses a name that is not a plain folder name', async () => {
    await assertRefused(model.gitFolderClone(hash, 'main', `x; touch ${marker}`, repo), 'invalid_lambda_name');
    await assertRefused(model.gitFolderClone(hash, 'main', '../x', repo), 'invalid_lambda_name');
  });

  it('refuses a url that is not a repository address', async () => {
    await assertRefused(model.gitFolderClone(hash, 'main', 'x', `${repo}; touch ${marker}`), 'invalid_lambda_git_url');
    await assertRefused(
      model.gitFolderClone(hash, 'main', 'x', `--upload-pack=touch ${marker}`),
      'invalid_lambda_git_url',
    );
    await assertRefused(
      model.gitFolderClone(hash, 'main', 'x', `ext::sh -c touch% ${marker}`),
      'invalid_lambda_git_url',
    );
  });

  it('refuses a deployment branch that is not a plain branch name for an existing checkout', async () => {
    await model.gitFolderClone(hash, 'main', 'deployed', repo);
    fs.renameSync(path.join(codeDir(), 'lambda-deployed'), path.join(codeDir(), `lambda-${hash}`));
    const lambda = {
      name: 'deployed',
      git: { url: repo, branch: 'main', hash, entryFile: 'index.js', entryPoint: 'run' },
    };

    await assertRefused(
      model.pullLambdaCode(lambda, { branch: `main; touch ${marker}`, hash }),
      'invalid_lambda_git_branch',
    );
    assert.ok(fs.existsSync(path.join(codeDir(), `lambda-${hash}`)));
  });

  it("deploys a new hash into that hash's folder, leaving the deployed hash's folder as it was", async () => {
    fs.writeFileSync(path.join(repo, 'index.js'), 'export function run() { return 2; }\n');
    gitIn(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-am', 'second');
    const nextHash = gitIn(repo, 'rev-parse', 'HEAD');

    await model.gitFolderClone(hash, 'main', 'deployed', repo);
    fs.renameSync(path.join(codeDir(), 'lambda-deployed'), path.join(codeDir(), `lambda-${hash}`));
    const lambda = { id: 'lambda-1', _appId: 'app-1', name: 'deployed', git: { url: repo, branch: 'main', hash } };
    const deployments = { findOne: async () => null, add: async () => {} };
    const deploying = Object.assign(Object.create(model), {
      createId: (id) => id,
      __modelManager: { getCoreModel: () => deployments },
    });

    await deploying.pullLambdaCode(lambda, {
      branch: 'main',
      hash: nextHash,
      entryFilePath: 'index.js',
      entryPoint: 'run',
    });

    assert.ok(fs.existsSync(path.join(codeDir(), `lambda-${nextHash}`)), "the new hash's folder is missing");
    assert.strictEqual(gitIn(path.join(codeDir(), `lambda-${nextHash}`), 'rev-parse', 'HEAD'), nextHash);
    assert.strictEqual(gitIn(path.join(codeDir(), `lambda-${hash}`), 'rev-parse', 'HEAD'), hash);
  });

  // A deployment of `hash` on `branch` into the checkout already deployed for `hash`, with git's config for the test
  describe('deploying a branch to an existing checkout', () => {
    let savedEnv;
    let added;

    beforeEach(() => {
      savedEnv = { ...process.env };
      added = [];
    });

    afterEach(() => {
      process.env = savedEnv;
    });

    const deployedCheckout = async () => {
      await model.gitFolderClone(hash, 'main', 'deployed', repo);
      const checkout = path.join(codeDir(), `lambda-${hash}`);
      fs.renameSync(path.join(codeDir(), 'lambda-deployed'), checkout);
      return checkout;
    };
    const deploy = (branch) => {
      const lambda = { id: 'lambda-1', _appId: 'app-1', name: 'deployed', git: { url: repo, branch: 'main', hash } };
      const deployments = { findOne: async () => null, add: async (body) => added.push(body) };
      const deploying = Object.assign(Object.create(model), {
        createId: (id) => id,
        __modelManager: { getCoreModel: () => deployments },
      });
      return deploying.pullLambdaCode(lambda, { branch, hash, entryFilePath: 'index.js', entryPoint: 'run' });
    };

    it("deploys a branch of the repository that the checkout doesn't set to track it", async () => {
      gitIn(repo, 'branch', '-f', 'untracked', hash);
      const checkout = await deployedCheckout();
      // git prints nothing on stdout for a checkout of a branch with no upstream
      Object.assign(process.env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'branch.autoSetupMerge',
        GIT_CONFIG_VALUE_0: 'false',
      });

      await deploy('untracked');

      assert.deepStrictEqual(added.map((body) => body.branch), ['untracked']);
      assert.strictEqual(gitIn(checkout, 'rev-parse', 'HEAD'), hash);
    });

    it('deploys a branch only in the checkout', async () => {
      const checkout = await deployedCheckout();
      gitIn(checkout, 'branch', '--no-track', 'local-only', hash);

      await deploy('local-only');

      assert.deepStrictEqual(added.map((body) => body.branch), ['local-only']);
      assert.strictEqual(gitIn(checkout, 'rev-parse', 'HEAD'), hash);
    });

    it('refuses a branch neither the repository nor the checkout has with a 400', async () => {
      await deployedCheckout();

      await assert.rejects(deploy('missing'), (err) => {
        assert.strictEqual(err.status, 400);
        assert.strictEqual(err.code, 'branch_not_found');
        return true;
      });
      assert.deepStrictEqual(added, []);
    });
  });
});

describe('model/core/LambdaSchemaModel:add', () => {
  it("refuses an app other than the one it's adding the lambda for, before it clones anything", async () => {
    const model = Object.create(LambdaSchemaModel.prototype);
    model.gitCloneLambda = async () => assert.fail('the lambda was cloned');

    await assert.rejects(
      () => model.add({ name: 'l', git: {} }, { _appId: 'app-a', auth: { policyProperties: {} }, app: { id: 'app-b' } }),
      /isn't the app/,
    );
  });
});

// What's stored for a lambda, through the real model over a datastore in memory; cloning, the lambda's deployment,
// executions and token are other tests'
describe('model/core/LambdaSchemaModel: what a lambda is stored as', () => {
  const APP_ID = '6abd05000000000000000001';

  function createModel() {
    const added = [];
    const services = new Map([
      ['nrp', { on: () => () => {}, emit: () => {} }],
      ['modelManager', { getCoreModel: () => ({ add: async (body) => (added.push(body), { id: '6abd06000000000000000001' }) }) }],
    ]);
    const model = new LambdaSchemaModel(services);
    const { datastore } = createSchemaModel({ name: 'unused', properties: {} });
    model.adapter = datastore;
    model.gitCloneLambda = async () => {};
    model._moveLambdaFolder = () => {};
    return { model, datastore, added };
  }

  it("stores the lambda's own properties, with its deployment and the schema's defaults for the rest", async () => {
    const { model, datastore } = createModel();
    const before = Date.now();

    const lambda = await model.add(
      {
        name: 'hello',
        git: { url: 'https://git', branch: 'main', hash: 'abc123', entryFile: 'index.js', entryPoint: 'run', other: 1 },
        trigger: [{ type: 'API_ENDPOINT', apiEndpoint: { method: 'GET', url: 'hello' } }],
        metadata: [{ key: 'k', value: 'v' }],
        other: 'dropped',
      },
      { _appId: APP_ID, auth: { policyProperties: {} }, app: { id: APP_ID } },
    );

    const [row] = datastore.rows;
    const { deployments, ...rest } = row;
    assert.deepStrictEqual(rest, {
      id: lambda.id,
      name: 'hello',
      type: 'PRIVATE',
      executable: true,
      git: { url: 'https://git', hash: 'abc123', branch: 'main', entryFile: 'index.js', entryPoint: 'run', sharedModules: [] },
      trigger: [
        {
          type: 'API_ENDPOINT',
          cron: { executionTime: null, periodicExecution: null, status: 'PENDING' },
          apiEndpoint: { method: 'GET', url: 'hello', type: 'ASYNC', useCallerToken: false, redirect: false },
          pathMutation: { paths: [] },
        },
      ],
      metadata: [{ key: 'k', value: 'v' }],
      _appId: APP_ID,
    });
    assert.strictEqual(deployments.length, 1);
    assert.strictEqual(deployments[0].hash, 'abc123');
    assert(deployments[0].deployedAt instanceof Date && deployments[0].deployedAt.getTime() >= before);
  });

  it('stores the deployments its git lists before its own, and the type it is given', async () => {
    const { model, datastore } = createModel();
    const deployedAt = new Date('2026-01-01T00:00:00.000Z');

    await model.add(
      {
        name: 'hello',
        type: 'PUBLIC',
        git: { url: 'u', branch: 'main', hash: 'def456', entryFile: 'i.js', entryPoint: 'run', deployments: [{ hash: 'abc123', deployedAt }] },
        trigger: [],
      },
      { _appId: APP_ID, auth: { policyProperties: {} }, app: { id: APP_ID } },
    );

    assert.strictEqual(datastore.rows[0].type, 'PUBLIC');
    assert.deepStrictEqual(datastore.rows[0].deployments.map((d) => d.hash), ['abc123', 'def456']);
    assert.deepStrictEqual(datastore.rows[0].deployments[0].deployedAt, deployedAt);
  });
});
