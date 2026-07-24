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

import UserRoutes from '../../../../../dist/routes/api/user.js';
import Model from '../../../../../dist/model/index.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';

const [
  GetUserList,
  GetUser,
  FindUser,
  GetUserByToken,
  CreateUserAuthToken,
  AddUser,
  UpdateUser,
  SetUserPolicyProperties,
  UpdateUserPolicyProperties,
  RemoveUserPolicyProperties,
  ClearUserPolicyProperties,
  DeleteAllUsers,
  DeleteUser,
  ClearUserLocalData,
  SearchUserList,
  UserCount,
] = UserRoutes;

const HEX_ID = '507f1f77bcf86cd799439011';

function stubModel({ user = {}, token = {}, app = {} } = {}) {
  const userModel = {
    schemaData: { name: 'users' },
    flatSchemaData: {},
    parseQuery: (q) => q,
    createId: (v) => v,
    findAll: sinon.stub(),
    find: sinon.stub(),
    findById: async () => null,
    findOne: async () => null,
    getByAuthAppId: async () => null,
    add: sinon.stub().resolves({ id: 'user-1', auth: [], tokens: [] }),
    exists: sinon.stub().resolves(true),
    validateUpdate: () => ({ validation: { isValid: true }, body: {} }),
    updateByPath: sinon.stub().resolves(),
    rm: sinon.stub().resolves(),
    rmAll: sinon.stub().resolves(),
    count: sinon.stub().resolves(0),
    ...user,
  };
  const tokenModel = {
    Constants: { Type: { SYSTEM: 'system', USER: 'user' } },
    createId: (v) => v,
    findOne: async () => null,
    findUserAuthTokens: sinon.stub().returns(Readable.from([], { objectMode: true })),
    add: sinon
      .stub()
      .resolves(Readable.from([{ id: 'token-1', value: 'token-value', policyProperties: {} }], { objectMode: true })),
    setPolicyPropertiesById: sinon.stub().resolves(),
    updatePolicyProperties: sinon.stub().resolves(),
    clearPolicyPropertiesById: sinon.stub().resolves(),
    rm: sinon.stub().resolves(),
    ...token,
  };
  const appModel = { createId: (v) => v, ...app };
  const activityModel = { Constants: { Visibility: { PRIVATE: 'PRIVATE' } } };

  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === UserSchemaModel) return userModel;
    if (modelClass === TokenSchemaModel) return tokenModel;
    if (modelClass === AppSchemaModel) return appModel;
    if (modelClass === ActivitySchemaModel) return activityModel;
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });

  return { userModel, tokenModel, appModel };
}

function createRoute(RouteClass, { nrp } = {}) {
  const route = Object.create(RouteClass.prototype);
  route.schemaName = 'users';
  route._nrp = nrp || { emit: sinon.spy() };
  return route;
}

function createReq({
  params = {},
  body = {},
  authApp = { id: 'app-1', policyPropertiesList: {} },
  token = { type: 'user' },
} = {}) {
  return { params, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/user:GetUserList', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(GetUserList);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('returns every user for a system token', () => {
    const { userModel } = stubModel();
    const route = createRoute(GetUserList);

    route._exec(createReq({ token: { type: 'system' } }), {}, { appId: 'app-1' });

    assert.ok(userModel.findAll.calledOnce);
  });

  it('scopes the list to the authenticated app for a non-system token', () => {
    const { userModel } = stubModel();
    const route = createRoute(GetUserList);

    route._exec(createReq({ token: { type: 'user' } }), {}, { appId: 'app-1' });

    assert.ok(userModel.find.calledWith({ _appId: 'app-1' }));
  });
});

describe('routes/api/user:GetUser', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(GetUser);

    await assert.rejects(route._validate(createReq({ authApp: null, params: { id: HEX_ID } })), /no_authenticated_app/);
  });

  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetUser);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_field/);
  });

  it('resolves "me" to the token\'s own user id', async () => {
    const { userModel } = stubModel({ user: { findOne: sinon.stub().resolves({ id: 'user-1', auth: [] }) } });
    const route = createRoute(GetUser);
    const req = createReq({ params: { id: 'me' }, token: { type: 'user', _userId: 'user-1' } });

    await route._validate(req);

    const [query] = userModel.findOne.firstCall.args;
    assert.strictEqual(query.$or[0].id.$eq, 'user-1');
  });

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(GetUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });

  it('includes the mapped auth tokens for the found user', async () => {
    stubModel({
      user: { findOne: async () => ({ id: 'user-1', auth: [] }) },
      token: {
        findUserAuthTokens: sinon
          .stub()
          .returns(
            Readable.from([{ id: 'token-1', value: 'v', policyProperties: { role: 'admin' } }], { objectMode: true }),
          ),
      },
    });
    const route = createRoute(GetUser);

    const result = await route._validate(createReq({ params: { id: HEX_ID } }));

    assert.deepStrictEqual(result.tokens, [{ id: 'token-1', value: 'v', policyProperties: { role: 'admin' } }]);
  });
});

describe('routes/api/user:FindUser', () => {
  it('rejects for an unrecognised auth provider', async () => {
    stubModel();
    const route = createRoute(FindUser);

    await assert.rejects(route._validate(createReq({ params: { app: 'myspace', id: 'ext-1' } })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });

  it('accepts a federated "app-" prefixed provider', async () => {
    stubModel({ user: { getByAuthAppId: async () => ({ id: 'user-1', auth: [] }) } });
    const route = createRoute(FindUser);

    const result = await route._validate(createReq({ params: { app: 'app-myapp', id: 'ext-1' } }));

    assert.strictEqual(result.id, 'user-1');
  });

  it('rejects when no matching user is found', async () => {
    stubModel({ user: { getByAuthAppId: async () => null } });
    const route = createRoute(FindUser);

    await assert.rejects(route._validate(createReq({ params: { app: 'google', id: 'ext-1' } })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });
});

describe('routes/api/user:GetUserByToken', () => {
  it('rejects when the token is missing', async () => {
    stubModel();
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(createReq({ body: {} })), /missing_field/);
  });

  it('rejects when the token is invalid', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(createReq({ body: { token: 'bad' } })), /invalid_token/);
  });

  it('rejects when no user owns the token', async () => {
    stubModel({
      token: { findOne: async () => ({ _userId: 'user-1', value: 'tok', policyProperties: {} }) },
      user: { findById: async () => null },
    });
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(createReq({ body: { token: 'tok' } })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });

  it('resolves the user with the matched token value', async () => {
    stubModel({
      token: { findOne: async () => ({ _userId: 'user-1', value: 'tok', policyProperties: { role: 'admin' } }) },
      user: { findById: async () => ({ id: 'user-1', auth: [] }) },
    });
    const route = createRoute(GetUserByToken);

    const result = await route._validate(createReq({ body: { token: 'tok' } }));

    assert.strictEqual(result.token, 'tok');
    assert.deepStrictEqual(result.policyProperties, { role: 'admin' });
  });
});

describe('routes/api/user:CreateUserAuthToken', () => {
  it('rejects when policyProperties/domains are missing', async () => {
    stubModel();
    const route = createRoute(CreateUserAuthToken);

    await assert.rejects(route._validate(createReq({ params: { id: 'user-1' }, body: {} })), /missing_field/);
  });

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findById: async () => null } });
    const route = createRoute(CreateUserAuthToken);
    const body = { policyProperties: {}, domains: ['*'] };

    await assert.rejects(route._validate(createReq({ params: { id: 'user-1' }, body })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });

  it('adds a token scoped to the app and user, then busts the route cache', async () => {
    // _exec() converts appId/user.id via the real Datastore ObjectId adapter (not routed through
    // Model.getCoreModel), so these need to look like real 24-char hex ids.
    const { tokenModel } = stubModel({ user: { findById: async () => ({ id: HEX_ID }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(CreateUserAuthToken, { nrp });

    const result = await route._exec(
      createReq({ body: { policyProperties: {}, domains: ['*'] } }),
      {},
      { appId: HEX_ID, user: { id: HEX_ID } },
    );

    assert.ok(tokenModel.add.calledOnce);
    assert.strictEqual(result.value, 'token-value');
    assert.ok(nrp.emit.calledWith('app-routes:bust-cache', '{}'));
  });
});

describe('routes/api/user:AddUser', () => {
  it('rejects when auth block is missing', async () => {
    stubModel();
    const route = createRoute(AddUser);

    await assert.rejects(route._validate(createReq({ body: {} })), /missing_user_auth/);
  });

  it('rejects when auth is not a non-empty array', async () => {
    stubModel();
    const route = createRoute(AddUser);

    await assert.rejects(route._validate(createReq({ body: { auth: [] } })), /invalid_user_auth/);
  });

  it('rejects when a matching user already exists', async () => {
    stubModel({ user: { findOne: async () => ({ id: 'existing' }) } });
    const route = createRoute(AddUser);
    const body = { auth: [{ app: 'google', appId: 'ext-1', email: 'a@b.com' }] };

    await assert.rejects(route._validate(createReq({ body })), /user_already_exists_with_that_name/);
  });

  it('resolves the app id once validated', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(AddUser);
    const body = { auth: [{ app: 'google', appId: 'ext-1', email: 'a@b.com' }] };

    const result = await route._validate(createReq({ body }));

    assert.deepStrictEqual(result, { appId: 'app-1' });
  });

  it('adds the user scoped to the app', async () => {
    const { userModel } = stubModel({
      user: { add: sinon.stub().resolves({ id: 'user-1', auth: [], tokens: [] }) },
    });
    const route = createRoute(AddUser);

    const result = await route._exec(createReq({ body: { auth: [] } }), {}, { appId: 'app-1' });

    assert.ok(userModel.add.calledWith({ auth: [] }, { _appId: 'app-1' }));
    assert.strictEqual(result.id, 'user-1');
  });
});

describe('routes/api/user:UpdateUser', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(UpdateUser);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_field/);
  });

  it('rejects when the update path is invalid', async () => {
    stubModel({
      user: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: false, invalidPath: 'bad.path' },
          body: {},
        }),
      },
    });
    const route = createRoute(UpdateUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /Update path is invalid/);
  });

  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdateUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('updates the user by path', async () => {
    const { userModel } = stubModel();
    const route = createRoute(UpdateUser);

    await route._exec(createReq({ body: { path: 'name', value: 'new' } }), {}, { id: HEX_ID });

    assert.ok(userModel.updateByPath.calledWith({ path: 'name', value: 'new' }, HEX_ID));
  });
});

describe('routes/api/user:SetUserPolicyProperties', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(SetUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_field/);
  });

  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(SetUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), /invalid_id/);
  });

  it('rejects when no matching token can be found', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(SetUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), /user_not_found/);
  });

  it('sets the policy properties on the resolved token', async () => {
    const { tokenModel } = stubModel();
    const route = createRoute(SetUserPolicyProperties);

    await route._exec(createReq({ body: { role: 'admin' } }), {}, { tokenId: 'token-1' });

    assert.ok(tokenModel.setPolicyPropertiesById.calledWith('token-1', { role: 'admin' }));
  });
});

describe('routes/api/user:UpdateUserPolicyProperties', () => {
  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdateUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), /invalid_id/);
  });

  it('rejects when no matching token can be found', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(UpdateUserPolicyProperties);

    await assert.rejects(
      route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })),
      /user_token_not_found/,
    );
  });

  it('updates the policy properties on the resolved token', async () => {
    const { tokenModel } = stubModel();
    const route = createRoute(UpdateUserPolicyProperties);
    const token = { id: 'token-1' };

    await route._exec(createReq({ body: { role: 'admin' } }), {}, token);

    assert.ok(tokenModel.updatePolicyProperties.calledWith(token, { role: 'admin' }));
  });
});

describe('routes/api/user:RemoveUserPolicyProperties', () => {
  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(RemoveUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), /invalid_id/);
  });

  it('removes only the policy-property keys whose value matches the request', async () => {
    const { tokenModel } = stubModel();
    const route = createRoute(RemoveUserPolicyProperties);
    const userToken = { id: 'token-1', policyProperties: { role: 'admin', department: 'sales' } };

    await route._exec(
      createReq({ params: { id: 'user-1' }, body: { role: 'admin' } }),
      {},
      { appId: 'app-1', userToken },
    );

    assert.ok(tokenModel.updatePolicyProperties.calledWith(userToken, { department: 'sales' }));
  });
});

describe('routes/api/user:ClearUserPolicyProperties', () => {
  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(ClearUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), /invalid_id/);
  });

  it('clears the policy properties on the resolved token and notifies sockets', async () => {
    const { tokenModel } = stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(ClearUserPolicyProperties, { nrp });
    const validate = { userId: 'user-1', appId: 'app-1', userToken: { id: 'token-1' } };

    await route._exec(createReq({ params: { id: 'user-1' } }), {}, validate);

    assert.ok(tokenModel.clearPolicyPropertiesById.calledWith('token-1'));
    assert.ok(nrp.emit.calledWith('worker:socket:evaluateUserRooms'));
  });
});

describe('routes/api/user:DeleteAllUsers', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(DeleteAllUsers);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('removes every user scoped to the app', async () => {
    const { userModel } = stubModel();
    const route = createRoute(DeleteAllUsers);

    const result = await route._exec(createReq(), {}, { appId: 'app-1' });

    assert.ok(userModel.rmAll.calledWith({ _appId: 'app-1' }));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/user:DeleteUser', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteUser);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_field/);
  });

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findById: async () => null } });
    const route = createRoute(DeleteUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('rejects when the user has no token', async () => {
    stubModel({ user: { findById: async () => ({ id: 'user-1' }) }, token: { findOne: async () => null } });
    const route = createRoute(DeleteUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /user_not_found/);
  });

  it('rejects when the requesting token belongs to the user being deleted', async () => {
    stubModel({
      user: { findById: async () => ({ id: 'user-1' }) },
      token: { findOne: async () => ({ value: 'same-token' }) },
    });
    const route = createRoute(DeleteUser);
    const req = createReq({ params: { id: HEX_ID }, token: { type: 'user', value: 'same-token' } });

    await assert.rejects(route._validate(req), /user_can_not_delete_itself/);
  });

  it('removes the user and their token', async () => {
    const { userModel, tokenModel } = stubModel();
    const route = createRoute(DeleteUser);
    const validate = { user: { id: 'user-1' }, token: { id: 'token-1' } };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(userModel.rm.calledWith('user-1'));
    assert.ok(tokenModel.rm.calledWith('token-1'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/user:ClearUserLocalData', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(ClearUserLocalData);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_field/);
  });

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findById: async () => null } });
    const route = createRoute(ClearUserLocalData);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('emits a clearUserLocalData event for the found user', async () => {
    const nrp = { emit: sinon.spy() };
    const route = createRoute(ClearUserLocalData, { nrp });

    await route._exec(createReq({ body: { collections: ['widgets'] } }), {}, { id: 'user-1' });

    assert.ok(nrp.emit.calledWith('clearUserLocalData'));
    const [, payload] = nrp.emit.firstCall.args;
    assert.deepStrictEqual(JSON.parse(payload).collections, ['widgets']);
  });
});

describe('routes/api/user:SearchUserList', () => {
  it('rejects when skip is not a number', async () => {
    stubModel();
    const route = createRoute(SearchUserList);

    await assert.rejects(route._validate(createReq({ body: { skip: 'abc' } })), /invalid_value_skip/);
  });

  it('scopes the search to the authenticated app for a non-system token', async () => {
    stubModel();
    const route = createRoute(SearchUserList);

    const result = await route._validate(createReq({ token: { type: 'user' } }));

    assert.deepStrictEqual(result.query.$and, [{ _appId: 'app-1' }]);
  });

  it('finds using the built query params', () => {
    const { userModel } = stubModel();
    userModel.find.returns('a-stream');
    const route = createRoute(SearchUserList);
    const validate = { query: { $and: [] }, skip: 0, limit: 10, sort: {}, project: false };

    const result = route._exec(createReq(), {}, validate);

    assert.strictEqual(result, 'a-stream');
    assert.deepStrictEqual(userModel.find.firstCall.args, [validate.query, {}, 10, 0, {}, false]);
  });
});

describe('routes/api/user:UserCount', () => {
  it('scopes the count to the authenticated app for a non-system token', async () => {
    stubModel();
    const route = createRoute(UserCount);

    const result = await route._validate(createReq({ token: { type: 'user' }, body: {} }));

    assert.deepStrictEqual(result.query.$and, [{}, { _appId: 'app-1' }]);
  });

  it('counts using the built query', async () => {
    const { userModel } = stubModel();
    const route = createRoute(UserCount);

    await route._exec(createReq(), {}, { query: { $and: [] } });

    assert.ok(userModel.count.calledWith({ $and: [] }));
  });
});
