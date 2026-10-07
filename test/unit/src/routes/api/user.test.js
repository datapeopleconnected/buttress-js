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
import UserSchemaModel, { userAlreadyExists } from '../../../../../dist/model/core/user.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';

import { realQueryParser } from '../../../../query-parser.js';

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
    ...realQueryParser(UserSchemaModel),
    createId: (v) => v,
    findAll: sinon.stub(),
    find: sinon.stub(),
    findById: async () => null,
    // The scoped model finds a user by id with findOne, which answers as findById does, as the datastore would
    async findOne(query) {
      return query && 'id' in query ? this.findById(query.id) : null;
    },
    getByAuthAppId: async () => null,
    add: sinon.stub().resolves({ id: '6abd01000000000000000001', auth: [], tokens: [] }),
    exists: sinon.stub().resolves(true),
    validateUpdate: () => ({ validation: { isValid: true }, body: {} }),
    updateByPath: sinon.stub().resolves(),
    rm: sinon.stub().resolves(),
    rmAll: sinon.stub().resolves(),
    count: sinon.stub().resolves(0),
    ...user,
  };
  const tokenModel = {
    ...realQueryParser(TokenSchemaModel),
    Constants: { Type: { SYSTEM: 'system', USER: 'user' } },
    createId: (v) => v,
    findOne: async () => null,
    exists: sinon.stub().resolves(true),
    findUserAuthTokens: sinon.stub().returns(Readable.from([], { objectMode: true })),
    add: sinon
      .stub()
      .resolves(Readable.from([{ id: '6abd02000000000000000001', value: 'token-value', policyProperties: {} }], { objectMode: true })),
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
  authApp = { id: '6abd05000000000000000001', policyPropertiesList: {} },
  token = { type: 'user' },
} = {}) {
  return { params, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/user:GetUserList', () => {
  it('returns every user for a system token', () => {
    const { userModel } = stubModel();
    const route = createRoute(GetUserList);

    route._exec(createReq({ token: { type: 'system' } }), {}, { appId: '6abd05000000000000000001' });

    assert.ok(userModel.findAll.calledOnce);
  });

  it('scopes the list to the authenticated app for a non-system token', () => {
    const { userModel } = stubModel();
    const route = createRoute(GetUserList);

    route._exec(createReq({ token: { type: 'user' } }), {}, { appId: '6abd05000000000000000001' });

    assert.ok(userModel.find.calledWith({ _appId: '6abd05000000000000000001' }));
  });
});

describe('routes/api/user:GetUser', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(GetUser);

    await assert.rejects(route._validate(createReq({ authApp: null, params: { id: HEX_ID } })), { code: 'internal_error' });
  });

  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetUser);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_field' });
  });

  it('resolves "me" to the token\'s own user id', async () => {
    const { userModel } = stubModel({ user: { findOne: sinon.stub().resolves({ id: '6abd01000000000000000001', auth: [] }) } });
    const route = createRoute(GetUser);
    const req = createReq({ params: { id: 'me' }, token: { type: 'user', _userId: '6abd01000000000000000001' } });

    await route._validate(req);

    const [query] = userModel.findOne.firstCall.args;
    assert.deepStrictEqual(query, { id: '6abd01000000000000000001', _appId: '6abd05000000000000000001' });
  });

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(GetUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), (err) => {
      assert.strictEqual(err.status, 404);
      return true;
    });
  });

  it('includes the mapped auth tokens for the found user', async () => {
    stubModel({
      user: { findOne: async () => ({ id: '6abd01000000000000000001', auth: [] }) },
      token: {
        findUserAuthTokens: sinon
          .stub()
          .returns(
            Readable.from([{ id: '6abd02000000000000000001', value: 'v', policyProperties: { role: 'admin' } }], { objectMode: true }),
          ),
      },
    });
    const route = createRoute(GetUser);

    const result = await route._validate(createReq({ params: { id: HEX_ID } }));

    assert.deepStrictEqual(result.tokens, [{ id: '6abd02000000000000000001', value: 'v', policyProperties: { role: 'admin' } }]);
  });
});

describe('routes/api/user:FindUser', () => {
  it('answers an unrecognised auth provider as not found, as clients add a user they do not find', async () => {
    stubModel();
    const route = createRoute(FindUser);

    await assert.rejects(route._validate(createReq({ params: { app: 'myspace', id: 'ext-1' } })), {
      status: 404,
      code: 'not_found',
    });
  });

  it('accepts a federated "app-" prefixed provider', async () => {
    stubModel({ user: { getByAuthAppId: async () => ({ id: '6abd01000000000000000001', auth: [] }) } });
    const route = createRoute(FindUser);

    const result = await route._validate(createReq({ params: { app: 'app-myapp', id: 'ext-1' } }));

    assert.strictEqual(result.id, '6abd01000000000000000001');
  });

  it('rejects when no matching user is found', async () => {
    stubModel({ user: { getByAuthAppId: async () => null } });
    const route = createRoute(FindUser);

    await assert.rejects(route._validate(createReq({ params: { app: 'google', id: 'ext-1' } })), (err) => {
      assert.strictEqual(err.status, 404);
      return true;
    });
  });
});

describe('routes/api/user:GetUserByToken', () => {
  it('rejects a request with no body', async () => {
    stubModel();
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(Object.assign(createReq(), { body: undefined })), { code: 'missing_field' });
  });

  it('rejects when the token is missing', async () => {
    stubModel();
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(createReq({ body: {} })), { code: 'missing_field' });
  });

  it("looks the token up in the caller's app, or in any app for a system token", async () => {
    const findOne = sinon.stub().resolves(null);
    stubModel({ token: { findOne } });
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(createReq({ body: { token: 'tok' }, token: { type: 'app' } })));
    await assert.rejects(route._validate(createReq({ body: { token: 'tok' }, token: { type: 'system' } })));

    assert.deepStrictEqual(
      findOne.args.map(([query]) => query),
      [{ $and: [{ value: { $eq: 'tok' } }, { _appId: '6abd05000000000000000001' }] }, { value: { $eq: 'tok' } }],
    );
  });

  it('answers a token nobody has as not found', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(createReq({ body: { token: 'bad' } })), {
      status: 404,
      code: 'not_found',
      details: { schema: 'token' },
    });
  });

  it('rejects when no user owns the token', async () => {
    stubModel({
      token: { findOne: async () => ({ _userId: '6abd01000000000000000001', value: 'tok', policyProperties: {} }) },
      user: { findOne: async () => null },
    });
    const route = createRoute(GetUserByToken);

    await assert.rejects(route._validate(createReq({ body: { token: 'tok' } })), (err) => {
      assert.strictEqual(err.status, 404);
      return true;
    });
  });

  it('resolves the user with the matched token value', async () => {
    stubModel({
      token: { findOne: async () => ({ _userId: '6abd01000000000000000001', value: 'tok', policyProperties: { role: 'admin' } }) },
      user: { findOne: async () => ({ id: '6abd01000000000000000001', auth: [] }) },
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

    await assert.rejects(route._validate(createReq({ params: { id: '6abd01000000000000000001' }, body: {} })), { code: 'missing_field' });
  });

  for (const domains of [[null], ['app.example.com', 42], [''], 'app.example.com']) {
    it(`rejects domains of ${JSON.stringify(domains)} with a 400`, async () => {
      stubModel({ user: { findOne: async () => ({ id: '6abd01000000000000000001' }) } });
      const route = createRoute(CreateUserAuthToken);
      const body = { policyProperties: {}, domains };

      await assert.rejects(route._validate(createReq({ params: { id: '6abd01000000000000000001' }, body })), (err) => {
        assert.strictEqual(err.status, 400);
        assert.strictEqual(err.code, 'invalid_domains');
        return true;
      });
    });
  }

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(CreateUserAuthToken);
    const body = { policyProperties: {}, domains: ['*'] };

    await assert.rejects(route._validate(createReq({ params: { id: '6abd01000000000000000001' }, body })), (err) => {
      assert.strictEqual(err.status, 404);
      return true;
    });
  });

  // SR-DPC-001 S14: the caller gives the token's domains and policy properties, and nothing else
  it('makes the token from its domains and policy properties alone', async () => {
    stubModel({ user: { findOne: async () => ({ id: '6abd01000000000000000001' }) } });
    const route = createRoute(CreateUserAuthToken);
    const body = {
      id: '6abd02000000000000000009',
      type: 'system',
      value: 'chosen-value',
      permissions: [{ route: 'app', permission: '*' }],
      tags: ['chosen'],
      _appId: '6abd05000000000000000009',
      domains: ['app.example.com'],
      policyProperties: {},
    };

    const validate = await route._validate(createReq({ params: { id: '6abd01000000000000000001' }, body }));

    assert.deepStrictEqual(validate.token, {
      type: 'user',
      permissions: [{ route: '*', permission: '*' }],
      domains: ['app.example.com'],
      policyProperties: {},
    });
  });

  it('adds a token scoped to the app and user, then busts the route cache', async () => {
    // _exec() converts appId/user.id via the real Datastore ObjectId adapter (not routed through
    // Model.getCoreModel), so these need to look like real 24-char hex ids.
    const { tokenModel } = stubModel({ user: { findOne: async () => ({ id: HEX_ID }) } });
    const nrp = { emit: sinon.spy() };
    const route = createRoute(CreateUserAuthToken, { nrp });

    const token = { type: 'user', permissions: [{ route: '*', permission: '*' }], domains: ['*'], policyProperties: {} };
    const result = await route._exec(
      createReq({ body: { id: HEX_ID, policyProperties: {}, domains: ['*'] } }),
      {},
      { appId: HEX_ID, user: { id: HEX_ID }, token },
    );

    assert.ok(tokenModel.add.calledOnce);
    assert.strictEqual(tokenModel.add.firstCall.args[0], token);
    assert.strictEqual(result.value, 'token-value');
    assert.ok(nrp.emit.calledWith('app-routes:bust-cache', '{}'));
  });
});

describe('routes/api/user:AddUser', () => {
  it('rejects a request with no body', async () => {
    stubModel();
    const route = createRoute(AddUser);

    await assert.rejects(route._validate(Object.assign(createReq(), { body: undefined })), { code: 'missing_user_auth' });
  });

  it('rejects when auth block is missing', async () => {
    stubModel();
    const route = createRoute(AddUser);

    await assert.rejects(route._validate(createReq({ body: {} })), { code: 'missing_user_auth' });
  });

  it('rejects when auth is not a non-empty array', async () => {
    stubModel();
    const route = createRoute(AddUser);

    await assert.rejects(route._validate(createReq({ body: { auth: [] } })), { code: 'invalid_user_auth' });
  });

  it("refuses an auth entry that isn't an object, or whose fields aren't text, before it looks for a duplicate", async () => {
    const findOne = sinon.stub().resolves(null);
    stubModel({ user: { findOne } });
    const route = createRoute(AddUser);
    const body = { auth: [{ app: 'google', email: { $ne: null } }, null, 'x'] };

    await assert.rejects(route._validate(createReq({ body })), {
      status: 400,
      code: 'invalid_value',
      message: 'users: Invalid value: auth.0.email:[object Object][object]',
      details: {
        schema: 'users',
        path: 'auth.0.email',
        issues: [
          { path: 'auth.0.email', code: 'type', expected: 'string', received: 'object' },
          { path: 'auth.1', code: 'type', expected: 'object', received: 'null' },
          { path: 'auth.2', code: 'type', expected: 'object', received: 'string' },
        ],
      },
    });
    assert.strictEqual(findOne.called, false);
  });

  it('rejects when a matching user already exists', async () => {
    stubModel({ user: { findOne: async () => ({ id: 'existing' }) } });
    const route = createRoute(AddUser);
    const body = { auth: [{ app: 'google', appId: 'ext-1', email: 'a@b.com' }] };

    await assert.rejects(route._validate(createReq({ body })), { code: 'user_already_exists_with_that_name' });
  });

  it('looks only for the id or email an auth entry gives, as an empty one would match every entry without one', async () => {
    const findOne = sinon.stub().resolves(null);
    stubModel({ user: { findOne } });
    const route = createRoute(AddUser);
    const body = { auth: [{ app: 'local', appId: '', email: '' }, { app: 'google', appId: 'ext-1', email: '' }] };

    await route._validate(createReq({ body }));

    assert.strictEqual(findOne.callCount, 1);
    // Within the caller's app, which the scoped model adds again
    assert.deepStrictEqual(findOne.firstCall.args[0].$and[0].auth, { $elemMatch: { app: 'google', $or: [{ appId: 'ext-1' }] } });
  });

  it('refuses the user when the model finds another stored with the same auth since it looked', async () => {
    stubModel({ user: { add: sinon.stub().rejects(userAlreadyExists()) } });
    const route = createRoute(AddUser);

    await assert.rejects(route._exec(createReq({ body: { auth: [{ app: 'google', appId: 'ext-1' }] } }), {}, { appId: HEX_ID }), {
      status: 400,
      code: 'user_already_exists_with_that_name',
    });
  });

  for (const domains of [[null], ['app.example.com', {}], null]) {
    it(`rejects token domains of ${JSON.stringify(domains)} with a 400`, async () => {
      stubModel({ user: { findOne: async () => null } });
      const route = createRoute(AddUser);
      const body = {
        auth: [{ app: 'google', appId: 'ext-1', email: 'a@b.com' }],
        token: { domains, policyProperties: {} },
      };

      await assert.rejects(route._validate(createReq({ body })), (err) => {
        assert.strictEqual(err.status, 400);
        assert.strictEqual(err.code, 'invalid_domains');
        return true;
      });
    });
  }

  it('accepts a token with a list of domains', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(AddUser);
    const body = {
      auth: [{ app: 'google', appId: 'ext-1', email: 'a@b.com' }],
      token: { domains: ['app.example.com', '*.example.com'], policyProperties: {} },
    };

    assert.deepStrictEqual(await route._validate(createReq({ body })), { appId: '6abd05000000000000000001' });
  });

  it('resolves the app id once validated', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(AddUser);
    const body = { auth: [{ app: 'google', appId: 'ext-1', email: 'a@b.com' }] };

    const result = await route._validate(createReq({ body }));

    assert.deepStrictEqual(result, { appId: '6abd05000000000000000001' });
  });

  it('adds the user scoped to the app', async () => {
    const { userModel } = stubModel({
      user: { add: sinon.stub().resolves({ id: '6abd01000000000000000001', auth: [], tokens: [] }) },
    });
    const route = createRoute(AddUser);

    const result = await route._exec(createReq({ body: { auth: [] } }), {}, { appId: '6abd05000000000000000001' });

    assert.ok(userModel.add.calledWith({ auth: [] }, { _appId: '6abd05000000000000000001' }));
    assert.strictEqual(result.id, '6abd01000000000000000001');
  });
});

describe('routes/api/user:UpdateUser', () => {
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

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it('updates the user by path', async () => {
    const { userModel } = stubModel();
    const route = createRoute(UpdateUser);

    await route._exec(createReq({ body: { path: 'name', value: 'new' } }), {}, { id: HEX_ID });

    assert.ok(userModel.updateByPath.calledWith({ path: 'name', value: 'new' }, HEX_ID));
  });
});

describe('routes/api/user:SetUserPolicyProperties', () => {
  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(SetUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), { code: 'not_found' });
  });

  it('rejects when no matching token can be found', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(SetUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), { code: 'not_found' });
  });

});

describe('routes/api/user:UpdateUserPolicyProperties', () => {
  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdateUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), { code: 'not_found' });
  });

  it('rejects when no matching token can be found', async () => {
    stubModel({ token: { findOne: async () => null } });
    const route = createRoute(UpdateUserPolicyProperties);

    await assert.rejects(
      route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })),
      { code: 'not_found' },
    );
  });

  it('updates the policy properties on the resolved token', async () => {
    const { tokenModel } = stubModel();
    const route = createRoute(UpdateUserPolicyProperties);
    const token = { id: '6abd02000000000000000001' };

    await route._exec(createReq({ body: { role: 'admin' } }), {}, token);

    assert.ok(tokenModel.updatePolicyProperties.calledWith(token, { role: 'admin' }));
  });
});

describe('routes/api/user:RemoveUserPolicyProperties', () => {
  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(RemoveUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), { code: 'not_found' });
  });

});

describe('routes/api/user:ClearUserPolicyProperties', () => {
  it('rejects when the user does not exist', async () => {
    stubModel({ user: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(ClearUserPolicyProperties);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID, tokenId: HEX_ID } })), { code: 'not_found' });
  });

});


describe('routes/api/user:DeleteUser', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteUser);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_field' });
  });

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(DeleteUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  // The user's tokens, found anew for each look, as the datastore would stream them
  const tokensOf = (tokens) => sinon.stub().callsFake(() => Readable.from(tokens, { objectMode: true }));

  it('rejects when the user has no token', async () => {
    stubModel({ user: { findOne: async () => ({ id: '6abd01000000000000000001' }) }, token: { find: tokensOf([]) } });
    const route = createRoute(DeleteUser);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it('rejects when the requesting token belongs to the user being deleted', async () => {
    stubModel({
      user: { findOne: async () => ({ id: '6abd01000000000000000001' }) },
      token: { find: tokensOf([{ value: 'same-token' }]) },
    });
    const route = createRoute(DeleteUser);
    const req = createReq({ params: { id: HEX_ID }, token: { type: 'user', value: 'same-token' } });

    await assert.rejects(route._validate(req), { code: 'user_can_not_delete_itself' });
  });

  // SR-DPC-001 S10: a user's later tokens are theirs too
  it("rejects when the requesting token is any of the user's tokens, not only the first", async () => {
    stubModel({
      user: { findOne: async () => ({ id: '6abd01000000000000000001' }) },
      token: { find: tokensOf([{ value: 'first-token' }, { value: 'same-token' }]) },
    });
    const route = createRoute(DeleteUser);
    const req = createReq({ params: { id: HEX_ID }, token: { type: 'user', value: 'same-token' } });

    await assert.rejects(route._validate(req), { code: 'user_can_not_delete_itself' });
  });

  it('returns every one of the user\'s tokens to remove', async () => {
    const tokens = [{ id: '6abd02000000000000000001', value: 'a' }, { id: '6abd02000000000000000002', value: 'b' }];
    stubModel({ user: { findOne: async () => ({ id: '6abd01000000000000000001' }) }, token: { find: tokensOf(tokens) } });
    const route = createRoute(DeleteUser);
    const req = createReq({ params: { id: HEX_ID }, token: { type: 'lambda', value: 'caller-token' } });

    const validate = await route._validate(req);

    assert.deepStrictEqual(validate.tokens, tokens);
  });

  it('removes the user and every one of their tokens', async () => {
    const tokens = [{ id: '6abd02000000000000000001' }, { id: '6abd02000000000000000002' }];
    const { userModel, tokenModel } = stubModel({ token: { find: tokensOf(tokens), rmBulk: sinon.stub().resolves() } });
    const route = createRoute(DeleteUser);

    const result = await route._exec(createReq(), {}, { user: { id: '6abd01000000000000000001' }, tokens });

    assert.ok(userModel.rm.calledWith('6abd01000000000000000001'));
    assert.ok(tokenModel.rmBulk.calledOnceWith(['6abd02000000000000000001', '6abd02000000000000000002']));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/user:ClearUserLocalData', () => {
  it('clears every collection when the request has no body', async () => {
    const nrp = { emit: sinon.spy() };
    const route = createRoute(ClearUserLocalData, { nrp });

    await route._exec(Object.assign(createReq(), { body: undefined }), {}, { id: '6abd01000000000000000001' });

    const [, payload] = nrp.emit.firstCall.args;
    assert.strictEqual(JSON.parse(payload).collections, false);
  });

  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(ClearUserLocalData);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_field' });
  });

  it('rejects when the user cannot be found', async () => {
    stubModel({ user: { findOne: async () => null } });
    const route = createRoute(ClearUserLocalData);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it('emits a clearUserLocalData event for the found user', async () => {
    const nrp = { emit: sinon.spy() };
    const route = createRoute(ClearUserLocalData, { nrp });

    await route._exec(createReq({ body: { collections: ['widgets'] } }), {}, { id: '6abd01000000000000000001' });

    assert.ok(nrp.emit.calledWith('clearUserLocalData'));
    const [, payload] = nrp.emit.firstCall.args;
    assert.deepStrictEqual(JSON.parse(payload).collections, ['widgets']);
  });
});

describe('routes/api/user:SearchUserList', () => {
  it('rejects an array body', async () => {
    stubModel();
    const route = createRoute(SearchUserList);

    await assert.rejects(route._validate(createReq({ body: [] })), { code: 'invalid_body' });
  });

  it('rejects when skip is not a number', async () => {
    stubModel();
    const route = createRoute(SearchUserList);

    await assert.rejects(route._validate(createReq({ body: { skip: 'abc' } })), { code: 'invalid_value_skip' });
  });

  it('scopes the search to the authenticated app for a non-system token', async () => {
    const { userModel } = stubModel();
    const route = createRoute(SearchUserList);
    const req = createReq({ token: { type: 'user' } });

    await route._exec(req, {}, await route._validate(req));

    assert.deepStrictEqual(userModel.find.firstCall.args[0], { _appId: '6abd05000000000000000001' });
  });

  it('finds using the built query params', () => {
    const { userModel } = stubModel();
    userModel.find.returns('a-stream');
    const route = createRoute(SearchUserList);
    const validate = { query: { name: { $eq: 'a' } }, skip: 0, limit: 10, sort: {}, project: false };

    const result = route._exec(createReq(), {}, validate);

    assert.strictEqual(result, 'a-stream');
    assert.deepStrictEqual(userModel.find.firstCall.args, [
      { $and: [validate.query, { _appId: '6abd05000000000000000001' }] },
      {},
      10,
      0,
      {},
      false,
    ]);
  });
});

describe('routes/api/user:UserCount', () => {
  it('scopes the count to the authenticated app for a non-system token', async () => {
    const { userModel } = stubModel();
    const route = createRoute(UserCount);

    const req = createReq({ token: { type: 'user' } });
    req.body = undefined;

    await route._exec(req, {}, await route._validate(req));

    assert.ok(userModel.count.calledWith({ _appId: '6abd05000000000000000001' }));
  });

  it('counts using the built query', async () => {
    const { userModel } = stubModel();
    const route = createRoute(UserCount);

    await route._exec(createReq(), {}, { query: { name: { $eq: 'a' } } });

    assert.ok(userModel.count.calledWith({ $and: [{ name: { $eq: 'a' } }, { _appId: '6abd05000000000000000001' }] }));
  });
});
