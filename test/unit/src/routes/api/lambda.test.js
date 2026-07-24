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

import LambdaRoutes from '../../../../../dist/routes/api/lambda.js';
import Model from '../../../../../dist/model/index.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';
import DeploymentSchemaModel from '../../../../../dist/model/core/deployment.js';
import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';

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

function stubModel({ lambda = {}, token = {}, user = {}, app = {}, deployment = {}, lambdaExecution = {} } = {}) {
  const lambdaModel = {
    schemaData: { name: 'lambdas' },
    flatSchemaData: {},
    parseQuery: (q) => q,
    createId: (v) => v,
    adapter: { ID: { new: (v) => v } },
    findById: async () => null,
    findOne: async () => null,
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
    stubModel({ lambda: { findById: async () => null } });
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
    stubModel();
    const route = createRoute(SearchLambdaList);

    const result = await route._validate(createReq({ token: { type: 'user' } }));

    assert.deepStrictEqual(result.query.$and, [{ _appId: 'app-1' }]);
  });

  it('finds using the built query', () => {
    const { lambdaModel } = stubModel();
    lambdaModel.find.returns('a-stream');
    const route = createRoute(SearchLambdaList);

    const result = route._exec(createReq(), {}, { query: { $and: [] } });

    assert.strictEqual(result, 'a-stream');
    assert.ok(lambdaModel.find.calledWith({ $and: [] }));
  });
});

describe('routes/api/lambda:AddLambda', () => {
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

  it('resolves true once fully validated', async () => {
    stubModel();
    const route = createRoute(AddLambda);

    const result = await route._validate(createReq({ body: validLambdaBody }));

    assert.strictEqual(result, true);
  });

  it('adds the lambda scoped to the authenticated app', async () => {
    const { lambdaModel, appModel } = stubModel({ app: { findById: sinon.stub().resolves({ id: 'app-1' }) } });
    const route = createRoute(AddLambda);

    await route._exec(createReq({ body: validLambdaBody }), {}, true);

    assert.ok(appModel.findById.calledWith('app-1'));
    assert.ok(lambdaModel.add.calledWith(validLambdaBody.lambda, { auth: validLambdaBody.auth, app: { id: 'app-1' } }));
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
  it('rejects when one item in the batch does not exist', async () => {
    stubModel({ lambda: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(BulkUpdateLambda);

    await assert.rejects(route._validate(createReq({ body: [{ id: HEX_ID, body: { path: 'name' } }] })), /invalid_id/);
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

    assert.ok(lambdaExecutionModel.add.calledWith(validate.execution, 'app-1'));
  });
});

describe('routes/api/lambda:EditLambdaDeployment', () => {
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
    stubModel({ lambda: { findById: async () => null } });
    const route = createRoute(EditLambdaDeployment);

    await assert.rejects(route._validate(createReq({ body: { branch: 'main', hash: 'abc' } })), /invalid_lambda_id/);
  });

  it('sets the new deployment info on exec', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(EditLambdaDeployment);

    await route._exec(createReq(), {}, { branch: 'main', hash: 'abc', lambda: { id: 'lambda-1' } });

    assert.ok(lambdaModel.setDeployment.calledWith('lambda-1', { 'git.branch': 'main', 'git.hash': 'abc' }));
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

  it('clears the policy properties on the lambda token', async () => {
    const { tokenModel } = stubModel();
    const route = createRoute(ClearLambdaPolicyProperties);

    await route._exec(createReq(), {}, { token: { id: 'token-1' } });

    assert.ok(tokenModel.clearPolicyPropertiesById.calledWith({ id: 'token-1' }));
  });
});

describe('routes/api/lambda:DeleteLambda', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteLambda);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_lambda_id/);
  });

  it('rejects when the lambda cannot be found', async () => {
    stubModel({ lambda: { findById: async () => null } });
    const route = createRoute(DeleteLambda);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_lambda_id/);
  });

  it('rejects when the lambda has no associated token', async () => {
    stubModel({
      lambda: { findById: async () => ({ id: 'lambda-1' }) },
      token: { findOne: async () => null },
    });
    const route = createRoute(DeleteLambda);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /could_fetch_lambda_token/);
  });

  // _exec() shells out to `rm -rf` against the real lambda code path (via child_process.exec bound
  // at module load time, not interceptable without proxyquire-style module mocking), so it's left
  // to e2e coverage rather than faked here in a way that would just be testing a reimplementation.
});

describe('routes/api/lambda:LambdaCount', () => {
  it('scopes the count to the authenticated app for a non-system token', async () => {
    stubModel();
    const route = createRoute(LambdaCount);

    const result = await route._validate(createReq({ token: { type: 'user' }, body: {} }));

    assert.deepStrictEqual(result.query.$and, [{}, { _appId: 'app-1' }]);
  });

  it('counts using the built query', async () => {
    const { lambdaModel } = stubModel();
    const route = createRoute(LambdaCount);

    await route._exec(createReq(), {}, { query: { $and: [] } });

    assert.ok(lambdaModel.count.calledWith({ $and: [] }));
  });
});
