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
import createConfig from '@dpc/node-env-obj';

import LambdaRoutes from '../../../../../dist/routes/api/lambda.js';
import Model from '../../../../../dist/model/index.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';
import DeploymentSchemaModel from '../../../../../dist/model/core/deployment.js';
import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';
import StandardModel from '../../../../../dist/model/type/standard.js';

import { realQueryParser } from '../../../../query-parser.js';


// A core model's own update validation, as the route runs it
const realValidateUpdate = (ModelClass) => (body) =>
  StandardModel.prototype.validateUpdate.call({ schemaData: ModelClass.Schema }, body);

const [
  GetLambda,
  GetLambdaList,
  SearchLambdaList,
  AddLambda,
  UpdateLambda,
  BulkUpdateLambda,
  ScheduleLambdaExecution,
  EditLambdaDeployment,
  SetLambdaPolicyProperties,
  UpdateLambdaPolicyProperties,
  ClearLambdaPolicyProperties,
  DeleteLambda,
  LambdaCount,
] = LambdaRoutes;

const HEX_ID = '507f1f77bcf86cd799439011';

const Config = createConfig();

function stubModel({ lambda = {}, token = {}, user = {}, app = {}, deployment = {}, lambdaExecution = {} } = {}) {
  const lambdaModel = {
    schemaData: { name: 'lambdas' },
    ...realQueryParser(LambdaSchemaModel),
    createId: (v) => v,
    adapter: { ID: { new: (v) => v } },
    findById: async () => null,
    // The scoped model finds a lambda by id with findOne, which answers as findById does, as the datastore would
    async findOne(query) {
      return query && 'id' in query ? this.findById(query.id) : null;
    },
    find: sinon.stub(),
    findAll: sinon.stub(),
    add: sinon.stub().resolves({ id: 'lambda-1', trigger: [] }),
    rm: sinon.stub().resolves(),
    count: sinon.stub().resolves(0),
    exists: sinon.stub().resolves(true),
    updateByPath: sinon.stub().resolves(),
    validateUpdate: () => ({ validation: { isValid: true }, body: {} }),
    pullLambdaCode: sinon.stub().resolves(),
    setDeployment: sinon.stub().resolves(),
    ...lambda,
  };
  const tokenModel = {
    Constants: { Type: { SYSTEM: 'system' } },
    createId: (v) => v,
    findOne: async () => null,
    exists: sinon.stub().resolves(true),
    setPolicyPropertiesById: sinon.stub().resolves(),
    updatePolicyProperties: sinon.stub().resolves(),
    clearPolicyPropertiesById: sinon.stub().resolves(),
    rm: sinon.stub().resolves(),
    ...token,
  };
  const userModel = { findById: async () => null, ...user };
  const appModel = { findById: async () => null, createId: (v) => v, ...app };
  const activityModel = { Constants: { Visibility: { PRIVATE: 'PRIVATE' } } };
  const deploymentModel = { findOne: async () => null, createId: (v) => v, ...deployment };
  const lambdaExecutionModel = { add: sinon.stub().resolves({ id: 'exec-1' }), ...lambdaExecution };

  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === LambdaSchemaModel) return lambdaModel;
    if (modelClass === TokenSchemaModel) return tokenModel;
    if (modelClass === UserSchemaModel) return userModel;
    if (modelClass === AppSchemaModel) return appModel;
    if (modelClass === ActivitySchemaModel) return activityModel;
    if (modelClass === DeploymentSchemaModel) return deploymentModel;
    if (modelClass === LambdaExecutionSchemaModel) return lambdaExecutionModel;
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });

  return { lambdaModel, tokenModel, userModel, appModel, deploymentModel, lambdaExecutionModel };
}

function createRoute(RouteClass, { nrp } = {}) {
  const route = Object.create(RouteClass.prototype);
  route.schemaName = 'lambdas';
  route._nrp = nrp || { emit: sinon.spy() };
  return route;
}

function createReq({ params = {}, query = {}, body = {}, authApp = { id: 'app-1' }, token = { type: 'user' } } = {}) {
  return { params, query, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/lambda:GetLambda', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetLambda);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_lambda_id/);
  });

  it('rejects when the id is invalid', async () => {
    stubModel();
    const route = createRoute(GetLambda);

    await assert.rejects(route._validate(createReq({ params: { id: 'bad-id' } })), /invalid_lambda_id/);
  });

  it('rejects when no lambda is found', async () => {
    stubModel({ lambda: { findOne: async () => null } });
    const route = createRoute(GetLambda);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /lambda_does_not_exist/);
  });
});

describe('routes/api/lambda:GetLambdaList', () => {
  it('throws synchronously on an invalid requested id', () => {
    stubModel();
    const route = createRoute(GetLambdaList);

    assert.throws(() => route._validate(createReq({ query: { ids: 'not-an-id' } })), /invalid_id/);
  });

  it('rejects exec when there is no app id in context', async () => {
    stubModel();
    const route = createRoute(GetLambdaList);

    await assert.rejects(route._exec(createReq({ authApp: null }), {}, []), /unable_to_get_app_id/);
  });

  it('returns every lambda for a system token', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(GetLambdaList);

    await route._exec(createReq({ token: { type: 'system' } }), {}, []);

    assert.ok(lambdaModel.findAll.calledOnce);
  });

  it('scopes the list to the authenticated app for a non-system token', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(GetLambdaList);

    await route._exec(createReq({ token: { type: 'user' } }), {}, []);

    assert.ok(lambdaModel.find.calledWith({ _appId: 'app-1' }));
  });
});

describe('routes/api/lambda:SearchLambdaList', () => {
  it('scopes the search to the authenticated app for a non-system token', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(SearchLambdaList);
    const req = createReq({ token: { type: 'user' } });

    await route._exec(req, {}, await route._validate(req));

    assert.deepStrictEqual(lambdaModel.find.firstCall.args[0], { _appId: 'app-1' });
  });

  it('finds using the built query', () => {
    const { lambdaModel } = stubModel();
    lambdaModel.find.returns('a-stream');
    const route = createRoute(SearchLambdaList);

    const result = route._exec(createReq(), {}, { query: { name: { $eq: 'a' } } });

    assert.strictEqual(result, 'a-stream');
    assert.ok(lambdaModel.find.calledWith({ $and: [{ name: { $eq: 'a' } }, { _appId: 'app-1' }] }));
  });
});

describe('routes/api/lambda:AddLambda', () => {
  it('rejects a request with no body', async () => {
    stubModel();
    const route = createRoute(AddLambda);

    await assert.rejects(route._validate(Object.assign(createReq(), { body: undefined })), /missing_field/);
  });

  const validLambdaBody = {
    lambda: {
      name: 'test-lambda',
      trigger: [],
      git: { url: 'https://git', branch: 'main', hash: 'abc123', entryFile: 'index.js', entryPoint: 'main' },
    },
    auth: { domains: ['*'], policyProperties: {} },
  };

  it('rejects when a required lambda field is missing', async () => {
    stubModel();
    const route = createRoute(AddLambda);

    await assert.rejects(route._validate(createReq({ body: { lambda: {} } })), /missing_field/);
  });

  it('rejects when auth is missing entirely', async () => {
    stubModel();
    const route = createRoute(AddLambda);
    const body = { lambda: validLambdaBody.lambda };

    await assert.rejects(route._validate(createReq({ body })), /missing_auth/);
  });

  it('rejects when auth is missing domains/policyProperties', async () => {
    stubModel();
    const route = createRoute(AddLambda);
    const body = { lambda: validLambdaBody.lambda, auth: {} };

    await assert.rejects(route._validate(createReq({ body })), /missing_field/);
  });

  for (const domains of [[null], ['app.example.com', 42], [' '], 'app.example.com']) {
    it(`rejects auth domains of ${JSON.stringify(domains)} with a 400`, async () => {
      stubModel();
      const route = createRoute(AddLambda);
      const body = { lambda: validLambdaBody.lambda, auth: { domains, policyProperties: {} } };

      await assert.rejects(route._validate(createReq({ body })), (err) => {
        assert.strictEqual(err.code, 400);
        assert.strictEqual(err.message, 'invalid_domains');
        return true;
      });
    });
  }

  it('resolves true once fully validated', async () => {
    stubModel();
    const route = createRoute(AddLambda);

    const result = await route._validate(createReq({ body: validLambdaBody }));

    assert.strictEqual(result, true);
  });

  it('adds the lambda scoped to the authenticated app', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(AddLambda);

    await route._exec(createReq({ body: validLambdaBody }), {}, true);

    assert.ok(
      lambdaModel.add.calledWith(validLambdaBody.lambda, { _appId: 'app-1', auth: validLambdaBody.auth, app: { id: 'app-1' } }),
    );
  });

  it('notifies the path-mutation cache when the added lambda has a PATH_MUTATION trigger', async () => {
    const { lambdaModel } = stubModel({
      lambda: { add: sinon.stub().resolves({ id: 'lambda-1', trigger: [{ type: 'PATH_MUTATION' }] }) },
    });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(AddLambda, { nrp });

    await route._exec(createReq({ body: validLambdaBody }), {}, true);

    assert.ok(nrp.emit.calledWith('rest:worker:add-path-mutation'));
    assert.ok(lambdaModel.add.called);
  });
});

describe('routes/api/lambda:UpdateLambda', () => {
  it('rejects when the update path is invalid', async () => {
    stubModel({
      lambda: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: false, invalidPath: 'bad.path' },
          body: {},
        }),
      },
    });
    const route = createRoute(UpdateLambda);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /Update path is invalid/);
  });

  it('rejects when the lambda does not exist', async () => {
    stubModel({ lambda: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdateLambda);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('pulls fresh code when the update touches git.hash', async () => {
    const { lambdaModel } = stubModel({
      lambda: { findById: async () => ({ id: HEX_ID, trigger: [] }) },
    });
    const route = createRoute(UpdateLambda);
    const req = createReq({ body: [{ path: 'git.hash', value: 'new-hash' }] });

    await route._exec(req, {}, { id: HEX_ID });

    assert.ok(lambdaModel.pullLambdaCode.calledOnce);
  });

  it('has the path-mutation cache rebuilt when the updated lambda watches paths', async () => {
    stubModel({ lambda: { findById: async () => ({ id: HEX_ID, trigger: [{ type: 'PATH_MUTATION' }] }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(UpdateLambda, { nrp });

    await route._exec(createReq({ body: [{ path: 'executable', value: false }] }), {}, { id: HEX_ID });

    assert.ok(nrp.emit.calledWith('rest:worker:rebuild-path-mutation-cache'));
  });

  it('has the path-mutation cache rebuilt when the update changes the triggers, which may have watched paths', async () => {
    stubModel({ lambda: { findById: async () => ({ id: HEX_ID, trigger: [] }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(UpdateLambda, { nrp });

    await route._exec(createReq({ body: [{ path: 'trigger', value: [] }] }), {}, { id: HEX_ID });

    assert.ok(nrp.emit.calledWith('rest:worker:rebuild-path-mutation-cache'));
  });

  it("leaves the path-mutation cache alone for a lambda that doesn't watch paths", async () => {
    stubModel({ lambda: { findById: async () => ({ id: HEX_ID, trigger: [{ type: 'CRON' }] }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(UpdateLambda, { nrp });

    await route._exec(createReq({ body: [{ path: 'name', value: 'renamed' }] }), {}, { id: HEX_ID });

    assert.strictEqual(nrp.emit.called, false);
  });

  it('does not pull code when the update does not touch git.hash', async () => {
    const { lambdaModel } = stubModel({
      lambda: { findById: async () => ({ id: HEX_ID, trigger: [] }) },
    });
    const route = createRoute(UpdateLambda);
    const req = createReq({ body: [{ path: 'name', value: 'renamed' }] });

    await route._exec(req, {}, { id: HEX_ID });

    assert.strictEqual(lambdaModel.pullLambdaCode.called, false);
  });
});

describe('routes/api/lambda:BulkUpdateLambda', () => {
  it('says an update in the batch is missing its value, rather than that its path is invalid', async () => {
    stubModel({ lambda: { validateUpdate: realValidateUpdate(LambdaSchemaModel) } });
    const route = createRoute(BulkUpdateLambda);

    await assert.rejects(
      route._validate(createReq({ body: [{ id: HEX_ID, body: [{ path: 'name' }] }] })),
      (err) => err.code === 400 && err.message === 'LAMBDA: Update is missing its value',
    );
  });

  it('rejects a request with no body', async () => {
    stubModel();
    const route = createRoute(BulkUpdateLambda);

    await assert.rejects(route._validate(Object.assign(createReq(), { body: undefined })), /array_required/);
  });

  it('rejects when one item in the batch does not exist', async () => {
    stubModel({ lambda: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(BulkUpdateLambda);

    await assert.rejects(route._validate(createReq({ body: [{ id: HEX_ID, body: { path: 'name' } }] })), /invalid_id/);
  });

  it('has the path-mutation cache rebuilt once when a lambda in the batch watches paths', async () => {
    stubModel({ lambda: { findById: async () => ({ id: HEX_ID, trigger: [{ type: 'PATH_MUTATION' }] }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(BulkUpdateLambda, { nrp });
    const update = { id: HEX_ID, body: [{ path: 'executable', value: false }] };

    await route._exec(createReq(), {}, [update, update]);

    assert.ok(nrp.emit.calledOnceWith('rest:worker:rebuild-path-mutation-cache'));
  });

  it('applies every update in the batch', async () => {
    const { lambdaModel } = stubModel({ lambda: { findById: async () => ({ id: 'lambda-1', trigger: [] }) } });
    const route = createRoute(BulkUpdateLambda);
    const batch = [
      { id: 'lambda-1', body: [{ path: 'name', value: 'a' }] },
      { id: 'lambda-2', body: [{ path: 'name', value: 'b' }] },
    ];

    const result = await route._exec(createReq(), {}, batch);

    assert.strictEqual(lambdaModel.updateByPath.callCount, 2);
    assert.strictEqual(result, true);
  });
});

describe('routes/api/lambda:ScheduleLambdaExecution', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(ScheduleLambdaExecution);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_lambda_id/);
  });

  it('rejects with 404 when the lambda cannot be found', async () => {
    stubModel({ lambda: { findOne: async () => null } });
    const route = createRoute(ScheduleLambdaExecution);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID }, body: {} })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });

  it('rejects with 404 when the deployment cannot be found', async () => {
    stubModel({
      lambda: { findOne: async () => ({ id: 'lambda-1', _appId: 'app-1', trigger: [] }) },
      deployment: { findOne: async () => null },
    });
    const route = createRoute(ScheduleLambdaExecution);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID }, body: {} })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });

  it('rejects when executeAfter is not a valid date expression', async () => {
    stubModel({
      lambda: { findOne: async () => ({ id: 'lambda-1', _appId: 'app-1', trigger: [] }) },
      deployment: { findOne: async () => ({ id: 'deployment-1' }) },
    });
    const route = createRoute(ScheduleLambdaExecution);

    await assert.rejects(
      route._validate(createReq({ params: { id: HEX_ID }, body: { executeAfter: 'not-a-date' } })),
      /invalid_execute_after_date/,
    );
  });

  it('schedules the execution against the resolved deployment', async () => {
    const { lambdaExecutionModel } = stubModel({
      lambda: { findOne: async () => ({ id: 'lambda-1', _appId: 'app-1', trigger: [] }) },
      deployment: { findOne: async () => ({ id: 'deployment-1' }) },
    });
    const route = createRoute(ScheduleLambdaExecution);

    const validate = await route._validate(createReq({ params: { id: HEX_ID }, body: { executeAfter: 'now' } }));
    await route._exec(createReq(), {}, validate);

    assert.ok(lambdaExecutionModel.add.calledWith(validate.execution, { _appId: 'app-1' }));
  });
});

describe('routes/api/lambda:EditLambdaDeployment', () => {
  it('has the path-mutation cache rebuilt when the deployed lambda watches paths, as its hash changed', async () => {
    const { lambdaModel } = stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(EditLambdaDeployment, { nrp });
    const lambda = { id: 'lambda-1', trigger: [{ type: 'PATH_MUTATION' }] };

    await route._exec(createReq(), {}, { hash: 'abc1234', branch: 'main', lambda });

    assert.ok(lambdaModel.setDeployment.calledOnce);
    assert.ok(nrp.emit.calledWith('rest:worker:rebuild-path-mutation-cache'));
  });

  it("answers a deployment that fails with a fixed message, not the failure's detail", async () => {
    const lambda = { id: 'lambda-1', git: { entryFile: 'index.js', entryPoint: 'execute' } };
    const failure = new Error('Command failed: git checkout main\nfatal: /srv/buttress/app_data/lambda/code/lambda-abc');
    stubModel({ lambda: { findOne: async () => lambda, pullLambdaCode: sinon.stub().rejects(failure) } });
    const route = createRoute(EditLambdaDeployment);

    await assert.rejects(
      route._validate(createReq({ params: { id: HEX_ID }, body: { branch: 'main', hash: 'abc1234' } })),
      (err) => err.code === 400 && err.message === 'lambda_deployment_failed',
    );
  });

  it('keeps the message of a deployment refused for a reason of its own', async () => {
    const lambda = { id: 'lambda-1', git: { entryFile: 'index.js', entryPoint: 'execute' } };
    const refusal = Object.assign(new Error('invalid_lambda_git_branch'), { code: 400, name: 'RequestError' });
    const { RequestError } = await import('../../../../../dist/helpers/errors.js');
    stubModel({
      lambda: { findOne: async () => lambda, pullLambdaCode: sinon.stub().rejects(new RequestError(400, refusal.message)) },
    });
    const route = createRoute(EditLambdaDeployment);

    await assert.rejects(
      route._validate(createReq({ params: { id: HEX_ID }, body: { branch: 'main', hash: 'abc1234' } })),
      (err) => err.code === 400 && err.message === 'invalid_lambda_git_branch',
    );
  });

  it('rejects when the branch is missing', async () => {
    stubModel();
    const route = createRoute(EditLambdaDeployment);

    await assert.rejects(route._validate(createReq({ body: { hash: 'abc' } })), /missing_required_deployment_branch/);
  });

  it('rejects when the hash is missing', async () => {
    stubModel();
    const route = createRoute(EditLambdaDeployment);

    await assert.rejects(route._validate(createReq({ body: { branch: 'main' } })), /missing_required_deployment_hash/);
  });

  it('rejects when the lambda cannot be found', async () => {
    stubModel({ lambda: { findOne: async () => null } });
    const route = createRoute(EditLambdaDeployment);

    await assert.rejects(route._validate(createReq({ body: { branch: 'main', hash: 'abc' } })), /invalid_lambda_id/);
  });

  it('resolves with the requested branch and hash', async () => {
    const lambda = { id: 'lambda-1', git: { entryFile: 'index.js', entryPoint: 'execute' } };
    stubModel({ lambda: { findOne: async () => lambda } });
    const route = createRoute(EditLambdaDeployment);

    const result = await route._validate(createReq({ params: { id: HEX_ID }, body: { branch: 'main', hash: 'abc' } }));

    assert.deepStrictEqual(result, { branch: 'main', hash: 'abc', entryFile: 'index.js', entryPoint: 'execute', lambda });
  });

  it('saves a new entry file and point, which the deployment was checked against', async () => {
    const lambda = { id: 'lambda-1', trigger: [], git: { entryFile: 'index.js', entryPoint: 'execute' } };
    const { lambdaModel } = stubModel({ lambda: { findOne: async () => lambda } });
    const route = createRoute(EditLambdaDeployment);
    const body = { branch: 'main', hash: 'abc1234', entryFile: 'src/main.js', entryPoint: 'run' };

    const validated = await route._validate(createReq({ params: { id: HEX_ID }, body }));
    await route._exec(createReq(), {}, validated);

    assert.deepStrictEqual(lambdaModel.pullLambdaCode.firstCall.args[1], {
      branch: 'main',
      hash: 'abc1234',
      entryFilePath: 'src/main.js',
      entryPoint: 'run',
    });
    assert.ok(
      lambdaModel.setDeployment.calledWith('lambda-1', {
        'git.branch': 'main',
        'git.hash': 'abc1234',
        'git.entryFile': 'src/main.js',
        'git.entryPoint': 'run',
      }),
    );
  });

  it('sets the new deployment info on exec', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(EditLambdaDeployment);

    const validated = { branch: 'main', hash: 'abc', entryFile: 'index.js', entryPoint: 'execute' };
    await route._exec(createReq(), {}, { ...validated, lambda: { id: 'lambda-1', trigger: [] } });

    assert.ok(
      lambdaModel.setDeployment.calledWith('lambda-1', {
        'git.branch': 'main',
        'git.hash': 'abc',
        'git.entryFile': 'index.js',
        'git.entryPoint': 'execute',
      }),
    );
  });
});

describe('routes/api/lambda:SetLambdaPolicyProperties', () => {
  it('rejects when no app is associated with the request', async () => {
    stubModel();
    const route = createRoute(SetLambdaPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID }, authApp: null })), /missing_field/);
  });

  it('rejects when the lambda does not exist', async () => {
    stubModel({ lambda: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(SetLambdaPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID }, body: {} })), /invalid_id/);
  });

  it('rejects when no lambda token can be found', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(SetLambdaPolicyProperties);
    const req = createReq({
      params: { id: HEX_ID },
      body: {},
      authApp: { id: 'app-1', policyPropertiesList: {} },
    });

    await assert.rejects(route._validate(req), /can_not_find_lambda_token/);
  });

  it('sets the policy properties on the lambda token', async () => {
    const { tokenModel } = stubModel({ token: { findOne: async () => ({ id: 'token-1' }) } });
    const route = createRoute(SetLambdaPolicyProperties);

    await route._exec(createReq({ body: { role: 'admin' } }), {}, { id: 'token-1' });

    assert.ok(tokenModel.setPolicyPropertiesById.calledWith('token-1', { role: 'admin' }));
  });
});

describe('routes/api/lambda:UpdateLambdaPolicyProperties', () => {
  it('rejects when the lambda does not exist', async () => {
    stubModel({ lambda: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdateLambdaPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID }, body: {} })), /invalid_id/);
  });

  it('updates the policy properties on the lambda token', async () => {
    const { tokenModel } = stubModel({ token: { findOne: async () => ({ id: 'token-1' }) } });
    const route = createRoute(UpdateLambdaPolicyProperties);

    await route._exec(createReq({ body: { role: 'admin' } }), {}, { token: { id: 'token-1' } });

    assert.ok(tokenModel.updatePolicyProperties.calledWith({ id: 'token-1' }, { role: 'admin' }));
  });
});

describe('routes/api/lambda:ClearLambdaPolicyProperties', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(ClearLambdaPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: {}, body: {} })), /missing_required_lambda_id/);
  });

  it('rejects when no lambda token can be found', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(ClearLambdaPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID }, body: {} })), /can_not_find_lambda_token/);
  });

  it("looks the lambda and its token up in the caller's app", async () => {
    const exists = sinon.stub().resolves(true);
    const findOne = sinon.stub().resolves({ id: 'token-1' });
    stubModel({ lambda: { exists }, token: { findOne } });
    const route = createRoute(ClearLambdaPolicyProperties);

    await route._validate(createReq({ params: { id: HEX_ID }, body: {}, token: { type: 'app' } }));

    assert.deepStrictEqual(exists.firstCall.args, [HEX_ID, null, { _appId: 'app-1' }]);
    assert.deepStrictEqual(findOne.firstCall.args[0], { $and: [{ _lambdaId: HEX_ID }, { _appId: 'app-1' }] });
  });

  it('clears the policy properties on the lambda token', async () => {
    const { tokenModel } = stubModel();
    const route = createRoute(ClearLambdaPolicyProperties);

    await route._exec(createReq(), {}, { token: { id: 'token-1' } });

    assert.ok(tokenModel.clearPolicyPropertiesById.calledWith('token-1'));
  });
});

describe('routes/api/lambda:DeleteLambda', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteLambda);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_lambda_id/);
  });

  it('rejects when the lambda cannot be found', async () => {
    stubModel({ lambda: { findOne: async () => null } });
    const route = createRoute(DeleteLambda);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_lambda_id/);
  });

  it('rejects when the lambda has no associated token', async () => {
    stubModel({
      lambda: { findOne: async () => ({ id: 'lambda-1' }) },
      token: { findOne: async () => null },
    });
    const route = createRoute(DeleteLambda);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /could_fetch_lambda_token/);
  });

  describe('code folders', () => {
    let savedCode;
    let tmpDir;
    const folder = (hash) => path.join(Config.paths.lambda.code, `lambda-${hash}`);

    beforeEach(() => {
      savedCode = Config.paths.lambda.code;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-lambda-delete-'));
      Config.paths.lambda.code = tmpDir;
      ['aaaaaaa', 'bbbbbbb', 'ccccccc', 'ddddddd'].forEach((hash) => fs.mkdirSync(folder(hash)));
    });

    afterEach(() => {
      Config.paths.lambda.code = savedCode;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("removes the code of each hash the lambda was deployed at that no other lambda is on, and leaves the rest", async () => {
      // Another lambda, possibly another app's, is on bbbbbbb; ddddddd was never this lambda's
      const { lambdaModel } = stubModel({
        lambda: { findOne: async (query) => (query['git.hash'] === 'bbbbbbb' ? { id: 'other-lambda' } : null) },
        deployment: { find: async () => Readable.from([{ hash: 'bbbbbbb' }, { hash: 'ccccccc' }]) },
      });
      const route = createRoute(DeleteLambda);
      const lambda = { id: 'lambda-1', trigger: [], git: { hash: 'aaaaaaa' } };

      await route._exec(createReq(), {}, { lambda, token: { id: 'token-1' } });

      assert.ok(lambdaModel.rm.calledWith('lambda-1'));
      assert.deepStrictEqual(fs.readdirSync(tmpDir).sort(), ['lambda-bbbbbbb', 'lambda-ddddddd']);
    });
  });
});

describe('routes/api/lambda:LambdaCount', () => {
  it('scopes the count to the authenticated app for a non-system token', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(LambdaCount);

    const req = createReq({ token: { type: 'user' } });
    req.body = undefined;

    await route._exec(req, {}, await route._validate(req));

    assert.ok(lambdaModel.count.calledWith({ _appId: 'app-1' }));
  });

  it('counts using the built query', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(LambdaCount);

    await route._exec(createReq(), {}, { query: { name: { $eq: 'a' } } });

    assert.ok(lambdaModel.count.calledWith({ $and: [{ name: { $eq: 'a' } }, { _appId: 'app-1' }] }));
  });
});
