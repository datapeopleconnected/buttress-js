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
import StandardModel from '../../../../../dist/model/type/standard.js';

import { realQueryParser } from '../../../../query-parser.js';


// A core model's own update validation, as the route runs it
const realValidateUpdate = (ModelClass) => (body) =>
  StandardModel.prototype.validateUpdate.call({ schemaData: ModelClass.Schema }, body);

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

// A find that answers the scoped model's lookup of rows by id, as the datastore would when they're all the app's,
// and gives `rows` for any other query
const findRows = (rows = []) =>
  sinon.stub().callsFake(async (query) => {
    const byId = query?.$and?.find((part) => part.id?.$in);
    return Readable.from(byId ? byId.id.$in.map((id) => ({ id })) : rows);
  });

function stubModel({ policy = {}, token = {}, app = {} } = {}) {
  const policyModel = {
    schemaData: { name: 'policies' },
    ...realQueryParser(PolicySchemaModel),
    createId: (v) => v,
    findById: async () => null,
    findOne: async () => null,
    find: sinon.stub(),
    findAll: sinon.stub(),
    add: sinon.stub().resolves({ id: '6abd04000000000000000001' }),
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

function createReq({ params = {}, query = {}, body = {}, authApp = { id: '6abd05000000000000000001' }, token = { type: 'user' } } = {}) {
  return { params, query, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/policy:GetPolicy', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetPolicy);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_id' });
  });

  it('rejects when the id is not a valid ObjectId', async () => {
    stubModel();
    const route = createRoute(GetPolicy);

    await assert.rejects(route._validate(createReq({ params: { id: 'not-an-id' } })), { code: 'invalid_id' });
  });

  it('rejects when no policy is found', async () => {
    stubModel({ policy: { findOne: async () => null } });
    const route = createRoute(GetPolicy);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it("looks the policy up in the caller's app, or in any app for a system token", async () => {
    const findOne = sinon.stub().resolves({ id: HEX_ID });
    const findById = sinon.stub().resolves({ id: HEX_ID });
    stubModel({ policy: { findOne, findById } });
    const route = createRoute(GetPolicy);

    await route._validate(createReq({ params: { id: HEX_ID }, token: { type: 'app' } }));
    await route._validate(createReq({ params: { id: HEX_ID }, token: { type: 'system' } }));

    assert.deepStrictEqual(findOne.args, [[{ id: HEX_ID, _appId: '6abd05000000000000000001' }]]);
    assert.deepStrictEqual(findById.args, [[HEX_ID]]);
  });

  it('resolves and returns the found policy unchanged', async () => {
    stubModel({ policy: { findOne: async () => ({ id: HEX_ID, name: 'test-policy' }) } });
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

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects when a requested id is not a valid ObjectId', () => {
    stubModel();
    const route = createRoute(GetPolicyList);

    // Unlike the other guards in this route, the id-format check throws synchronously from
    // inside a forEach rather than rejecting a promise (_validate isn't declared async).
    assert.throws(() => route._validate(createReq({ query: { ids: 'not-an-id' } })), { code: 'invalid_id' });
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

    route._exec(createReq({ token: { type: 'system' } }), {}, { appId: '6abd05000000000000000001', ids: [] });

    assert.ok(policyModel.findAll.calledOnce);
  });

  it('scopes the list to the authenticated app for a non-system token', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(GetPolicyList);

    route._exec(createReq({ token: { type: 'user' } }), {}, { appId: '6abd05000000000000000001', ids: [] });

    assert.ok(policyModel.find.calledWith({ _appId: '6abd05000000000000000001' }));
  });
});

describe('routes/api/policy:SearchPolicyList', () => {
  it('rejects an array body', async () => {
    stubModel();
    const route = createRoute(SearchPolicyList);

    await assert.rejects(route._validate(createReq({ body: [] })), { code: 'invalid_body' });
  });

  it('rejects when skip is not a number', async () => {
    stubModel();
    const route = createRoute(SearchPolicyList);

    await assert.rejects(route._validate(createReq({ body: { skip: 'abc' } })), { code: 'invalid_value_skip' });
  });

  it('scopes the search to the authenticated app for a non-system token', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(SearchPolicyList);
    const req = createReq({ token: { type: 'user' } });

    await route._exec(req, {}, await route._validate(req));

    assert.deepStrictEqual(policyModel.find.firstCall.args[0], { _appId: '6abd05000000000000000001' });
  });

  it('finds using the built query params', async () => {
    const { policyModel } = stubModel();
    policyModel.find.returns('a-stream');
    const route = createRoute(SearchPolicyList);
    const validate = { query: { name: { $eq: 'a' } }, skip: 0, limit: 10, sort: {}, project: false };

    const result = route._exec(createReq(), {}, validate);

    assert.strictEqual(result, 'a-stream');
    assert.deepStrictEqual(policyModel.find.firstCall.args, [
      { $and: [validate.query, { _appId: '6abd05000000000000000001' }] },
      {},
      10,
      0,
      {},
      false,
    ]);
  });
});

describe('routes/api/policy:AddPolicy', () => {
  it('rejects a request with no body', async () => {
    stubModel();
    const route = createRoute(AddPolicy);

    await assert.rejects(route._validate(Object.assign(createReq(), { body: undefined })), { code: 'missing_field' });
  });

  it('rejects when a required field is missing', async () => {
    stubModel();
    const route = createRoute(AddPolicy);

    await assert.rejects(route._validate(createReq({ body: {} })), { code: 'missing_field' });
  });

  it('rejects when a policy with the same name already exists', async () => {
    stubModel({ policy: { findOne: async () => ({ id: 'existing' }) } });
    const route = createRoute(AddPolicy);
    const body = { name: 'test', selection: {}, config: [{}], version: 1 };

    await assert.rejects(route._validate(createReq({ body })), { code: 'policy_with_name_already_exists' });
  });

  it('rejects when the version property is missing', async () => {
    stubModel();
    const route = createRoute(AddPolicy);
    const body = { name: 'test', selection: {}, config: [{}] };
    const authApp = { id: '6abd05000000000000000001', policyPropertiesList: {} };

    await assert.rejects(route._validate(createReq({ body, authApp })), { code: 'invalid_policy_no_version' });
  });

  it('resolves with the app id once validated', async () => {
    stubModel();
    const route = createRoute(AddPolicy);
    const body = { name: 'test', selection: {}, config: [{}], version: 1 };
    const authApp = { id: '6abd05000000000000000001', policyPropertiesList: {} };

    const result = await route._validate(createReq({ body, authApp }));

    assert.deepStrictEqual(result, { appId: '6abd05000000000000000001' });
  });

  it('adds the policy and busts the policy cache', async () => {
    const { policyModel } = stubModel({ policy: { add: sinon.stub().resolves({ id: '6abd04000000000000000001' }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(AddPolicy, { nrp });

    const result = await route._exec(createReq(), {}, { appId: '6abd05000000000000000001' });

    assert.ok(policyModel.add.calledWith({}, { _appId: '6abd05000000000000000001' }));
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache', JSON.stringify({ appId: '6abd05000000000000000001' })));
    assert.deepStrictEqual(result, { id: '6abd04000000000000000001' });
  });
});

describe('routes/api/policy:UpdatePolicy', () => {
  it('says an update is missing its value, rather than that its path is invalid', async () => {
    stubModel({ policy: { validateUpdate: realValidateUpdate(PolicySchemaModel) } });
    const route = createRoute(UpdatePolicy);

    await assert.rejects(
      route._validate(createReq({ body: [{ path: 'name' }] })),
      (err) => err.status === 400 && err.code === 'invalid_update' && err.message.endsWith(': Update is missing its value'),
    );
  });

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

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it("checks the policy exists in the caller's app", async () => {
    const exists = sinon.stub().resolves(true);
    stubModel({ policy: { exists } });
    const route = createRoute(UpdatePolicy);

    await route._validate(createReq({ params: { id: HEX_ID }, token: { type: 'app' } }));

    assert.deepStrictEqual(exists.firstCall.args, [HEX_ID, null, { _appId: '6abd05000000000000000001' }]);
  });

  it('updates the policy by path', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(UpdatePolicy);

    await route._exec(createReq({ params: { id: HEX_ID }, body: { path: 'name' } }), {}, true);

    assert.ok(policyModel.updateByPath.calledWith({ path: 'name' }, HEX_ID));
  });
});

describe('routes/api/policy:BulkUpdatePolicy', () => {
  for (const [label, body] of [
    ['no body', undefined],
    ['an object', {}],
    ['a null item', [null]],
  ]) {
    it(`rejects ${label} instead of an array of updates`, async () => {
      stubModel();
      const route = createRoute(BulkUpdatePolicy);

      await assert.rejects(route._validate(Object.assign(createReq(), { body })), { code: 'array_required' });
    });
  }

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

    await assert.rejects(route._validate(createReq({ body: [{ id: HEX_ID, body: { path: 'name' } }] })), { code: 'not_found' });
  });

  it('applies every update in the batch', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(BulkUpdatePolicy);
    const batch = [
      { id: '6abd04000000000000000001', body: { path: 'name', value: 'a' } },
      { id: '6abd04000000000000000002', body: { path: 'name', value: 'b' } },
    ];

    const result = await route._exec(createReq(), {}, batch);

    assert.strictEqual(policyModel.updateByPath.callCount, 2);
    assert.strictEqual(result, true);
  });
});

describe('routes/api/policy:PolicyCount', () => {
  it("doesn't match on actualCount, which a queryless body may carry", async () => {
    stubModel();
    const route = createRoute(PolicyCount);

    const result = await route._validate(createReq({ body: { actualCount: true, name: 'readers' } }));

    assert.ok(!JSON.stringify(result.query).includes('actualCount'), JSON.stringify(result.query));
    assert.ok(JSON.stringify(result.query).includes('readers'));
  });

  it('counts using the built query', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(PolicyCount);

    await route._exec(createReq(), {}, { query: { name: { $eq: 'a' } } });

    assert.ok(policyModel.count.calledWith({ $and: [{ name: { $eq: 'a' } }, { _appId: '6abd05000000000000000001' }] }));
  });

  it('scopes the count to the authenticated app for a non-system token', async () => {
    const { policyModel } = stubModel();
    const route = createRoute(PolicyCount);

    const req = createReq({ token: { type: 'user' } });
    req.body = undefined;

    await route._exec(req, {}, await route._validate(req));

    assert.ok(policyModel.count.calledWith({ _appId: '6abd05000000000000000001' }));
  });
});

describe('routes/api/policy:SyncPolicies', () => {
  it('rejects when the body is not an array', async () => {
    stubModel();
    const route = createRoute(SyncPolicies);

    await assert.rejects(route._validate(createReq({ body: { not: 'an array' } })), { code: 'invalid_field' });
  });

  it('rejects when a policy in the batch is missing required fields', async () => {
    stubModel();
    const route = createRoute(SyncPolicies);

    await assert.rejects(route._validate(createReq({ body: [{ name: 'test' }] })), { code: 'missing_field' });
  });

  const validPolicy = (name) => ({ name, selection: { role: { '@eq': 'admin' } }, config: [{ verbs: ['GET'] }], version: '1' });
  const app = { id: '6abd05000000000000000001', policyPropertiesList: { role: ['admin', 'user'] } };

  it('checks each policy as adding one does: its version, its selection, and a name of its own', async () => {
    stubModel();
    const route = createRoute(SyncPolicies);
    const sync = (body) => route._validate(createReq({ body, authApp: app }));

    await sync([validPolicy('a'), validPolicy('b')]);
    await assert.rejects(sync([{ ...validPolicy('a'), version: undefined }]), { code: 'invalid_policy_no_version' });
    await assert.rejects(sync([{ ...validPolicy('a'), selection: { role: { '@eq': 'owner' } } }]), { code: 'invalid_policy_selection' });
    await assert.rejects(sync([{ ...validPolicy('a'), config: [] }]), { code: 'missing_field' });
    await assert.rejects(sync([validPolicy('a'), validPolicy('a')]), { code: 'policy_with_name_already_exists' });
  });

  const oldPolicies = [
    { id: 'old-1', name: 'x', selection: {}, config: [], version: '1' },
    { id: 'old-2', name: 'y', selection: {}, config: [], version: '1' },
  ];

  it("replaces the app's policies by id, so the policy cache lets the old ones go, and busts the cache", async () => {
    const { policyModel } = stubModel({ policy: { find: findRows(oldPolicies) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(SyncPolicies, { nrp });

    const result = await route._exec(createReq({ body: [validPolicy('a'), validPolicy('b')] }), {}, { appId: '6abd05000000000000000001' });

    assert.ok(policyModel.find.calledWith({ $and: [{ _appId: '6abd05000000000000000001' }, { _appId: '6abd05000000000000000001' }] }));
    assert.ok(policyModel.rmBulk.calledOnceWith(['old-1', 'old-2']));
    assert.strictEqual(policyModel.rmAll.called, false);
    assert.deepStrictEqual(policyModel.add.getCalls().map((call) => call.args[0].name), ['a', 'b']);
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache'));
    assert.strictEqual(result, true);
  });

  it('puts the old policies back when adding the new ones fails part-way', async () => {
    const add = sinon.stub();
    add.onFirstCall().resolves({ id: 'new-1' });
    add.onSecondCall().rejects(new Error('mongo went away'));
    add.resolves({ id: 'restored' });
    const { policyModel } = stubModel({ policy: { find: findRows(oldPolicies), add } });
    const route = createRoute(SyncPolicies);

    await assert.rejects(
      route._exec(createReq({ body: [validPolicy('a'), validPolicy('b')] }), {}, { appId: '6abd05000000000000000001' }),
      /mongo went away/,
    );

    assert.deepStrictEqual(policyModel.rmBulk.secondCall.args[0], ['new-1']);
    assert.deepStrictEqual(add.getCalls().slice(2).map((call) => call.args[0].id), ['old-1', 'old-2']);
  });
});

describe('routes/api/policy:DeleteTransientPolicy', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(DeleteTransientPolicy);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects when the name field is missing', async () => {
    stubModel();
    const route = createRoute(DeleteTransientPolicy);

    await assert.rejects(route._validate(createReq({ body: {} })), { code: 'missing_field' });
  });

  it('rejects when no policy matches the given name', async () => {
    stubModel({ policy: { find: sinon.stub().returns(Readable.from([], { objectMode: true })) } });
    const route = createRoute(DeleteTransientPolicy);

    await assert.rejects(route._validate(createReq({ body: { name: 'missing' } })), { code: 'not_found' });
  });

  it('only looks the name up within the authenticated app', async () => {
    const policy = { id: '6abd04000000000000000001', name: 'transient' };
    const find = sinon.stub().returns(Readable.from([policy], { objectMode: true }));
    stubModel({ policy: { find } });
    const route = createRoute(DeleteTransientPolicy);

    const result = await route._validate(createReq({ body: { name: 'transient' } }));

    assert.ok(find.calledWith({ $and: [{ name: 'transient', _appId: '6abd05000000000000000001' }, { _appId: '6abd05000000000000000001' }] }));
    assert.deepStrictEqual(result, { appId: '6abd05000000000000000001', policy });
  });

  it('removes the matched transient policy and notifies dependents', async () => {
    const { policyModel } = stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(DeleteTransientPolicy, { nrp });
    const validate = { appId: '6abd05000000000000000001', policy: { id: { toString: () => '6abd04000000000000000001' } } };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(policyModel.rm.calledWith('6abd04000000000000000001'));
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache'));
    assert.ok(nrp.emit.calledWith('worker:socket:evaluateUserRooms'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/policy:DeletePolicy', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeletePolicy);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_field' });
  });

  it('rejects when the policy cannot be found', async () => {
    stubModel({ policy: { findOne: async () => null } });
    const route = createRoute(DeletePolicy);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it('removes the policy and busts the cache', async () => {
    const { policyModel } = stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(DeletePolicy, { nrp });
    const validate = { appId: '6abd05000000000000000001', policy: { id: { toString: () => '6abd04000000000000000001' } } };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(policyModel.rm.calledWith('6abd04000000000000000001'));
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/policy:DeleteAppPolicies', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(DeleteAppPolicies);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('scopes the deletion to the ids of the authenticated app’s own policies', async () => {
    stubModel({
      policy: {
        find: sinon.stub().returns(
          Readable.from([{ id: { toString: () => '6abd04000000000000000001' } }, { id: { toString: () => '6abd04000000000000000002' } }], {
            objectMode: true,
          }),
        ),
      },
    });
    const route = createRoute(DeleteAppPolicies);

    const ids = await route._validate(createReq({ token: { type: 'user' } }));

    assert.deepStrictEqual(ids, ['6abd04000000000000000001', '6abd04000000000000000002']);
  });

  it('bulk-removes the collected policy ids', async () => {
    const { policyModel } = stubModel({ policy: { find: findRows() } });
    const route = createRoute(DeleteAppPolicies);

    const result = await route._exec(createReq(), {}, ['6abd04000000000000000001', '6abd04000000000000000002']);

    assert.ok(policyModel.rmBulk.calledWith(['6abd04000000000000000001', '6abd04000000000000000002']));
    assert.strictEqual(result, true);
  });
});
