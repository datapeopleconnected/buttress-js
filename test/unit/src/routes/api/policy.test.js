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
import { Readable } from 'stream';

import PolicyRoutes from '../../../../../dist/routes/api/policy.js';
import Model from '../../../../../dist/model/index.js';
import PolicySchemaModel from '../../../../../dist/model/core/policy.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';

const [
  GetPolicy,
  GetPolicyList,
  SearchPolicyList,
  AddPolicy,
  UpdatePolicy,
  BulkUpdatePolicy,
  PolicyCount,
  SyncPolicies,
  DeleteTransientPolicy,
  DeletePolicy,
  DeleteAppPolicies,
] = PolicyRoutes;

const HEX_ID = '507f1f77bcf86cd799439011';

function stubModel({ policy = {}, token = {}, app = {} } = {}) {
  const policyModel = {
    schemaData: { name: 'policies' },
    flatSchemaData: {},
    parseQuery: (q) => q,
    findById: async () => null,
    findOne: async () => null,
    find: sinon.stub(),
    findAll: sinon.stub(),
    add: sinon.stub().resolves({ id: 'policy-1' }),
    rm: sinon.stub().resolves(),
    rmAll: sinon.stub().resolves(),
    rmBulk: sinon.stub().resolves(),
    count: sinon.stub().resolves(0),
    exists: sinon.stub().resolves(true),
    updateByPath: sinon.stub().resolves(),
    validateUpdate: () => ({ validation: { isValid: true }, body: {} }),
    ...policy,
  };
  const tokenModel = {
    Constants: { Type: { SYSTEM: 'system' } },
    ...token,
  };
  const appModel = {
    createId: (v) => v,
    adapter: { ID: { new: (v) => v } },
    ...app,
  };
  const activityModel = { Constants: { Visibility: { PRIVATE: 'PRIVATE' } } };

  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === PolicySchemaModel) return policyModel;
    if (modelClass === TokenSchemaModel) return tokenModel;
    if (modelClass === AppSchemaModel) return appModel;
    if (modelClass === ActivitySchemaModel) return activityModel;
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });

  return { policyModel, tokenModel, appModel };
}

function createRoute(RouteClass, { nrp } = {}) {
  const route = Object.create(RouteClass.prototype);
  route.schemaName = 'policies';
  route._nrp = nrp || { emit: sinon.spy() };
  return route;
}

function createReq({ params = {}, query = {}, body = {}, authApp = { id: 'app-1' }, token = { type: 'user' } } = {}) {
  return { params, query, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/policy:GetPolicy', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetPolicy);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_policy_id/);
  });

  it('rejects when the id is not a valid ObjectId', async () => {
    stubModel();
    const route = createRoute(GetPolicy);

    await assert.rejects(route._validate(createReq({ params: { id: 'not-an-id' } })), /invalid_policy_id/);
  });

  it('rejects when no policy is found', async () => {
    stubModel({ policy: { findById: async () => null } });
    const route = createRoute(GetPolicy);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /policy_does_not_exist/);
  });

  it('resolves and returns the found policy unchanged', async () => {
    stubModel({ policy: { findById: async () => ({ id: HEX_ID, name: 'test-policy' }) } });
    const route = createRoute(GetPolicy);

    const policy = await route._validate(createReq({ params: { id: HEX_ID } }));
    const result = route._exec(createReq(), {}, policy);

    assert.strictEqual(result.name, 'test-policy');
  });
});

describe('routes/api/policy:GetPolicyList', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(GetPolicyList);

    await assert.rejects(route._validate(createReq({ authApp: null })), /missing_app_id/);
  });

  it('rejects when a requested id is not a valid ObjectId', () => {
    stubModel();
    const route = createRoute(GetPolicyList);

    // Unlike the other guards in this route, the id-format check throws synchronously from
    // inside a forEach rather than rejecting a promise (_validate isn't declared async).
    assert.throws(() => route._validate(createReq({ query: { ids: 'not-an-id' } })), /invalid_id/);
  });

  it('parses a comma-separated ids query string', async () => {
    stubModel();
    const route = createRoute(GetPolicyList);

    const result = await route._validate(createReq({ query: { ids: `${HEX_ID},${HEX_ID}` } }));

    assert.strictEqual(result.ids.length, 2);
  });

  it('returns every policy for a system token', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(GetPolicyList);

    route._exec(createReq({ token: { type: 'system' } }), {}, { appId: 'app-1', ids: [] });

    assert.ok(policyModel.findAll.calledOnce);
  });

  it('scopes the list to the authenticated app for a non-system token', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(GetPolicyList);

    route._exec(createReq({ token: { type: 'user' } }), {}, { appId: 'app-1', ids: [] });

    assert.ok(policyModel.find.calledWith({ _appId: 'app-1' }));
  });
});

describe('routes/api/policy:SearchPolicyList', () => {
  it('rejects when skip is not a number', async () => {
    stubModel();
    const route = createRoute(SearchPolicyList);

    await assert.rejects(route._validate(createReq({ body: { skip: 'abc' } })), /invalid_value_skip/);
  });

  it('scopes the search to the authenticated app for a non-system token', async () => {
    stubModel();
    const route = createRoute(SearchPolicyList);

    const result = await route._validate(createReq({ token: { type: 'user' } }));

    assert.deepStrictEqual(result.query.$and, [{ _appId: 'app-1' }]);
  });

  it('finds using the built query params', async () => {
    const { policyModel } = stubModel();
    policyModel.find.returns('a-stream');
    const route = createRoute(SearchPolicyList);
    const validate = { query: { $and: [] }, skip: 0, limit: 10, sort: {}, project: false };

    const result = route._exec(createReq(), {}, validate);

    assert.strictEqual(result, 'a-stream');
    assert.deepStrictEqual(policyModel.find.firstCall.args, [validate.query, {}, 10, 0, {}, false]);
  });
});

describe('routes/api/policy:AddPolicy', () => {
  it('rejects when a required field is missing', async () => {
    stubModel();
    const route = createRoute(AddPolicy);

    await assert.rejects(route._validate(createReq({ body: {} })), /missing_field/);
  });

  it('rejects when a policy with the same name already exists', async () => {
    stubModel({ policy: { findOne: async () => ({ id: 'existing' }) } });
    const route = createRoute(AddPolicy);
    const body = { name: 'test', selection: {}, config: [{}], version: 1 };

    await assert.rejects(route._validate(createReq({ body })), /policy_with_name_already_exists/);
  });

  it('rejects when the version property is missing', async () => {
    stubModel();
    const route = createRoute(AddPolicy);
    const body = { name: 'test', selection: {}, config: [{}] };
    const authApp = { id: 'app-1', policyPropertiesList: {} };

    await assert.rejects(route._validate(createReq({ body, authApp })), /invalid_policy_no_version/);
  });

  it('resolves with the app id once validated', async () => {
    stubModel();
    const route = createRoute(AddPolicy);
    const body = { name: 'test', selection: {}, config: [{}], version: 1 };
    const authApp = { id: 'app-1', policyPropertiesList: {} };

    const result = await route._validate(createReq({ body, authApp }));

    assert.deepStrictEqual(result, { appId: 'app-1' });
  });

  it('adds the policy and busts the policy cache', async () => {
    const { policyModel } = stubModel({ policy: { add: sinon.stub().resolves({ id: 'policy-1' }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(AddPolicy, { nrp });

    const result = await route._exec(createReq(), {}, { appId: 'app-1' });

    assert.ok(policyModel.add.calledWith({}, 'app-1'));
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache', JSON.stringify({ appId: 'app-1' })));
    assert.deepStrictEqual(result, { id: 'policy-1' });
  });
});

describe('routes/api/policy:UpdatePolicy', () => {
  it('rejects when the update path is invalid', async () => {
    stubModel({
      policy: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: false, invalidPath: 'bad.path' },
          body: {},
        }),
      },
    });
    const route = createRoute(UpdatePolicy);

    await assert.rejects(route._validate(createReq()), /Update path is invalid/);
  });

  it('rejects when the policy does not exist', async () => {
    stubModel({ policy: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdatePolicy);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('updates the policy by path', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(UpdatePolicy);

    await route._exec(createReq({ params: { id: HEX_ID }, body: { path: 'name' } }), {}, true);

    assert.ok(policyModel.updateByPath.calledWith({ path: 'name' }, HEX_ID));
  });
});

describe('routes/api/policy:BulkUpdatePolicy', () => {
  it('rejects when one update in the batch has an invalid path', async () => {
    stubModel({
      policy: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: false, invalidPath: 'bad.path' },
          body: {},
        }),
      },
    });
    const route = createRoute(BulkUpdatePolicy);

    await assert.rejects(
      route._validate(createReq({ body: [{ id: HEX_ID, body: { path: 'bad.path' } }] })),
      /Update path is invalid/,
    );
  });

  it('rejects when one item in the batch does not exist', async () => {
    stubModel({ policy: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(BulkUpdatePolicy);

    await assert.rejects(route._validate(createReq({ body: [{ id: HEX_ID, body: { path: 'name' } }] })), /invalid_id/);
  });

  it('applies every update in the batch', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(BulkUpdatePolicy);
    const batch = [
      { id: 'policy-1', body: { path: 'name', value: 'a' } },
      { id: 'policy-2', body: { path: 'name', value: 'b' } },
    ];

    const result = await route._exec(createReq(), {}, batch);

    assert.strictEqual(policyModel.updateByPath.callCount, 2);
    assert.strictEqual(result, true);
  });
});

describe('routes/api/policy:PolicyCount', () => {
  it('counts using the built query', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(PolicyCount);

    await route._exec(createReq(), {}, { query: { $and: [] } });

    assert.ok(policyModel.count.calledWith({ $and: [] }));
  });

  it('scopes the count to the authenticated app for a non-system token', async () => {
    stubModel();
    const route = createRoute(PolicyCount);

    const result = await route._validate(createReq({ token: { type: 'user' }, body: {} }));

    assert.deepStrictEqual(result.query.$and, [{}, { _appId: 'app-1' }]);
  });
});

describe('routes/api/policy:SyncPolicies', () => {
  it('rejects when the body is not an array', async () => {
    stubModel();
    const route = createRoute(SyncPolicies);

    await assert.rejects(route._validate(createReq({ body: { not: 'an array' } })), /invalid_field/);
  });

  it('rejects when a policy in the batch is missing required fields', async () => {
    stubModel();
    const route = createRoute(SyncPolicies);

    await assert.rejects(route._validate(createReq({ body: [{ name: 'test' }] })), /missing_field/);
  });

  it('replaces every policy for the app and busts the cache', async () => {
    const { policyModel } = stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(SyncPolicies, { nrp });
    const body = [
      { name: 'a', selection: {} },
      { name: 'b', selection: {} },
    ];

    const result = await route._exec(createReq({ body }), {}, { appId: 'app-1' });

    assert.ok(policyModel.rmAll.calledWith({ _appId: 'app-1' }));
    assert.strictEqual(policyModel.add.callCount, 2);
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/policy:DeleteTransientPolicy', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(DeleteTransientPolicy);

    await assert.rejects(route._validate(createReq({ authApp: null })), /missing_app_id/);
  });

  it('rejects when the name field is missing', async () => {
    stubModel();
    const route = createRoute(DeleteTransientPolicy);

    await assert.rejects(route._validate(createReq({ body: {} })), /missing_field/);
  });

  it('rejects when no policy matches the given name', async () => {
    stubModel({ policy: { find: sinon.stub().returns(Readable.from([], { objectMode: true })) } });
    const route = createRoute(DeleteTransientPolicy);

    await assert.rejects(route._validate(createReq({ body: { name: 'missing' } })), /policy_does_not_exist/);
  });

  it('removes the matched transient policy and notifies dependents', async () => {
    const { policyModel } = stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(DeleteTransientPolicy, { nrp });
    const validate = { appId: 'app-1', policy: { id: { toString: () => 'policy-1' } } };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(policyModel.rm.calledWith('policy-1'));
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache'));
    assert.ok(nrp.emit.calledWith('worker:socket:evaluateUserRooms'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/policy:DeletePolicy', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeletePolicy);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_field/);
  });

  it('rejects when the policy cannot be found', async () => {
    stubModel({ policy: { findById: async () => null } });
    const route = createRoute(DeletePolicy);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('removes the policy and busts the cache', async () => {
    const { policyModel } = stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(DeletePolicy, { nrp });
    const validate = { appId: 'app-1', policy: { id: { toString: () => 'policy-1' } } };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(policyModel.rm.calledWith('policy-1'));
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/policy:DeleteAppPolicies', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(DeleteAppPolicies);

    await assert.rejects(route._validate(createReq({ authApp: null })), /missing_app_id/);
  });

  it('scopes the deletion to the ids of the authenticated app’s own policies', async () => {
    stubModel({
      policy: {
        find: sinon.stub().returns(
          Readable.from([{ id: { toString: () => 'policy-1' } }, { id: { toString: () => 'policy-2' } }], {
            objectMode: true,
          }),
        ),
      },
    });
    const route = createRoute(DeleteAppPolicies);

    const ids = await route._validate(createReq({ token: { type: 'user' } }));

    assert.deepStrictEqual(ids, ['policy-1', 'policy-2']);
  });

  it('bulk-removes the collected policy ids', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(DeleteAppPolicies);

    const result = await route._exec(createReq(), {}, ['policy-1', 'policy-2']);

    assert.ok(policyModel.rmBulk.calledWith(['policy-1', 'policy-2']));
    assert.strictEqual(result, true);
  });
});
