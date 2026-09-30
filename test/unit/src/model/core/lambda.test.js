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
      assert.strictEqual(err.code, 400);
      assert.strictEqual(err.message, message);
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

