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

import AppRoutes from '../../../../../dist/routes/api/app.js';
import Model from '../../../../../dist/model/index.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';
import { ApiError } from '../../../../../dist/helpers/errors.js';

import { realQueryParser } from '../../../../query-parser.js';

const [
  GetAppList,
  SearchAppList,
  AddApp,
  DeleteApp,
  DeleteAllApps,
  GetAppSchema,
  ,
  GetAppPolicyPropertyList,
  SetAppPolicyPropertyList,
  AppCount,
  AppUpdateOAuth,
  AppUpdate,
  GetApp,
] = AppRoutes;

function stubModel({ app = {}, token = {} } = {}) {
  const appModel = {
    schemaData: { name: 'apps' },
    localSchema: [],
    ...realQueryParser(AppSchemaModel),
    validate: () => ({ isValid: true }),
    isDuplicate: async () => false,
    apiPathProblem: async () => null,
    add: async () => ({ app: { id: '6abd05000000000000000001', apiPath: 'test-app' }, token: { value: 'token-value' } }),
    findById: async () => null,
    findOne: async () => null,
    find: sinon.stub(),
    findAll: sinon.stub(),
    rm: sinon.stub().resolves(),
    count: sinon.stub().resolves(0),
    isValidId: () => true,
    exists: async () => true,
    updateByPath: sinon.stub().resolves(),
    validateUpdate: () => ({ validation: { isValid: true }, body: {} }),
    setPolicyPropertiesList: sinon.stub().resolves(),
    updateOAuth: sinon.stub().resolves(),
    createId: (v) => v,
    ...app,
  };
  const tokenModel = {
    Constants: { Type: { SYSTEM: 'system' } },
    createId: (v) => v,
    findById: sinon.stub().resolves(null),
    find: sinon.stub(),
    ...token,
  };
  const activityModel = { Constants: { Visibility: { PRIVATE: 'PRIVATE' } } };

  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === AppSchemaModel) return appModel;
    if (modelClass === TokenSchemaModel) return tokenModel;
    if (modelClass === ActivitySchemaModel) return activityModel;
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });

  return { appModel, tokenModel };
}

function createRoute(RouteClass, { nrp } = {}) {
  const route = Object.create(RouteClass.prototype);
  route.schemaName = 'apps';
  route._nrp = nrp || { emit: sinon.spy() };
  return route;
}

function createReq({ params = {}, body = {}, authApp = { id: '6abd05000000000000000001' }, token = { type: 'user' } } = {}) {
  return { params, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/app:GetAppList', () => {
  it('scopes the list to the authenticated app for a non-system token', () => {
    const { appModel } = stubModel();
    const route = createRoute(GetAppList);

    route._exec(createReq({ token: { type: 'user' } }), {}, true);

    assert.ok(appModel.find.calledWith({ id: '6abd05000000000000000001' }));
  });

  it('returns every app for a system token', () => {
    const { appModel } = stubModel();
    const route = createRoute(GetAppList);

    route._exec(createReq({ token: { type: 'system' } }), {}, true);

    assert.ok(appModel.findAll.calledOnce);
  });

  it('rejects when there is no app id on the token', () => {
    stubModel();
    const route = createRoute(GetAppList);

    assert.throws(
      () => route._exec(createReq({ authApp: null }), {}, true),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.code, 'internal_error');
        return true;
      },
    );
  });
});

describe('routes/api/app:SearchAppList', () => {
  it('scopes the search to the authenticated app for a non-system token', async () => {
    const { appModel, tokenModel } = stubModel();
    appModel.find.returns(Readable.from([], { objectMode: true }));
    tokenModel.find.returns(Readable.from([], { objectMode: true }));
    const route = createRoute(SearchAppList);
    const req = createReq({ token: { type: 'user' } });

    await route._exec(req, {}, await route._validate(req));

    assert.deepStrictEqual(appModel.find.firstCall.args[0], { id: '6abd05000000000000000001' });
  });

  it('scopes the search to the authenticated app when there is no body', async () => {
    const { appModel, tokenModel } = stubModel();
    appModel.find.returns(Readable.from([], { objectMode: true }));
    tokenModel.find.returns(Readable.from([], { objectMode: true }));
    const route = createRoute(SearchAppList);

    const req = createReq({ token: { type: 'app' } });
    req.body = undefined;

    await route._exec(req, {}, await route._validate(req));

    assert.deepStrictEqual(appModel.find.firstCall.args[0], { id: '6abd05000000000000000001' });
  });

  it('does not scope the search for a system token', async () => {
    stubModel();
    const route = createRoute(SearchAppList);

    const result = await route._validate(createReq({ token: { type: 'system' } }));

    assert.deepStrictEqual(result.query, {});
  });

  it("gives an app token only its own app's token value", async () => {
    const appsDB = [
      { id: '6abd05000000000000000001', _tokenId: '6abd02000000000000000001' },
      { id: '6abd05000000000000000002', _tokenId: '6abd02000000000000000002' },
    ];
    const { appModel, tokenModel } = stubModel();
    appModel.find.returns(Readable.from(appsDB, { objectMode: true }));
    tokenModel.find.returns(
      Readable.from(
        [
          { id: '6abd02000000000000000001', value: 'value-1' },
          { id: '6abd02000000000000000002', value: 'value-2' },
        ],
        { objectMode: true },
      ),
    );
    const route = createRoute(SearchAppList);

    const result = await route._exec(createReq({ token: { type: 'app' } }), {}, { query: {} });

    assert.strictEqual(result.find((a) => a.id === '6abd05000000000000000001').tokenValue, 'value-1');
    assert.ok(!('tokenValue' in result.find((a) => a.id === '6abd05000000000000000002')));
    assert.deepStrictEqual(tokenModel.find.firstCall.args[0], { $and: [{ id: { $in: ['6abd02000000000000000001'] } }, { _appId: '6abd05000000000000000001' }] });
  });

  it('gives a system token each returned app with its token value', async () => {
    const appsDB = [
      { id: '6abd05000000000000000001', _tokenId: '6abd02000000000000000001' },
      { id: '6abd05000000000000000002', _tokenId: '6abd02000000000000000002' },
      { id: '6abd05000000000000000003', _tokenId: '6abd02000000000000000003' },
    ];
    const { appModel, tokenModel } = stubModel();
    appModel.find.returns(Readable.from(appsDB, { objectMode: true }));
    tokenModel.find.returns(
      Readable.from(
        [
          { id: '6abd02000000000000000001', value: 'value-1' },
          { id: '6abd02000000000000000002', value: 'value-2' },
        ],
        { objectMode: true },
      ),
    );
    const route = createRoute(SearchAppList);

    const result = await route._exec(createReq({ token: { type: 'system' } }), {}, { query: {} });

    assert.strictEqual(result.find((a) => a.id === '6abd05000000000000000001').tokenValue, 'value-1');
    assert.strictEqual(result.find((a) => a.id === '6abd05000000000000000002').tokenValue, 'value-2');
    assert.strictEqual(result.find((a) => a.id === '6abd05000000000000000003').tokenValue, undefined);
  });
});

describe('routes/api/app:GetApp', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetApp);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_id' });
  });

  it('rejects when the id is not a valid id format', async () => {
    stubModel({ app: { isValidId: () => false } });
    const route = createRoute(GetApp);

    await assert.rejects(route._validate(createReq({ params: { id: 'bad-id' } })), { code: 'invalid_id' });
  });

  it('rejects when no app is found for the id', async () => {
    stubModel({ app: { findById: async () => null } });
    const route = createRoute(GetApp);

    await assert.rejects(route._validate(createReq({ params: { id: '6abd05000000000000000001' } })), { code: 'not_found' });
  });

  it('attaches the app token value on exec', async () => {
    stubModel({ token: { findById: sinon.stub().resolves({ value: 'the-token' }) } });
    const route = createRoute(GetApp);

    const result = await route._exec(createReq(), {}, { id: '6abd05000000000000000001', _tokenId: '6abd02000000000000000001' });

    assert.strictEqual(result.tokenValue, 'the-token');
  });
});

describe('routes/api/app:AddApp', () => {
  for (const [label, body] of [['no body', undefined], ['an array', []]]) {
    it(`rejects ${label} instead of an app`, async () => {
      stubModel();
      const route = createRoute(AddApp);

      await assert.rejects(route._validate(Object.assign(createReq(), { body })), { code: 'invalid_body' });
    });
  }

  it('rejects with the first missing field', async () => {
    stubModel({ app: { validate: () => ({ isValid: false, missing: ['name'], invalid: [] }) } });
    const route = createRoute(AddApp);

    await assert.rejects(route._validate(createReq()), /Missing field: name/);
  });

  it('rejects with the first invalid value when nothing is missing', async () => {
    stubModel({ app: { validate: () => ({ isValid: false, missing: [], invalid: ['name:1[number]'] }) } });
    const route = createRoute(AddApp);

    await assert.rejects(route._validate(createReq()), /Invalid value: name:1\[number\]/);
  });

  it('rejects when a policyPropertiesList value is not an array', async () => {
    stubModel();
    const route = createRoute(AddApp);

    await assert.rejects(
      route._validate(createReq({ body: { policyPropertiesList: { role: 'not-an-array' } } })),
      { code: 'invalid_field' },
    );
  });

  it('rejects duplicate apps', async () => {
    stubModel({ app: { isDuplicate: async () => true } });
    const route = createRoute(AddApp);

    await assert.rejects(route._validate(createReq({ body: { name: 'test' } })), { code: 'duplicate' });
  });

  it('resolves true for a valid, non-duplicate app', async () => {
    stubModel();
    const route = createRoute(AddApp);

    const result = await route._validate(createReq({ body: { name: 'test' } }));

    assert.strictEqual(result, true);
  });

  it('adds the app, emits the lambda-endpoint config event, and returns the app with its token', async () => {
    stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(AddApp, { nrp });

    const result = await route._exec(createReq({ body: { name: 'test' } }), {}, true);

    assert.ok(nrp.emit.calledWith('app:configure-lambda-endpoints', 'test-app'));
    assert.strictEqual(result.token, 'token-value');
    assert.strictEqual(result.id, '6abd05000000000000000001');
  });
});

describe('routes/api/app:DeleteApp', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteApp);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_id' });
  });

  it('rejects when the app cannot be found', async () => {
    stubModel({ app: { findById: async () => null } });
    const route = createRoute(DeleteApp);

    await assert.rejects(route._validate(createReq({ params: { id: '6abd05000000000000000001' } })), { code: 'not_found' });
  });

  it('removes the app and resolves true', async () => {
    const { appModel } = stubModel();
    const route = createRoute(DeleteApp);
    const app = { id: '6abd05000000000000000001' };

    const result = await route._exec(createReq(), {}, app);

    assert.ok(appModel.rm.calledWith(app));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app:DeleteAllApps', () => {
  it('deletes every app except ones owned by a system token', async () => {
    const systemAppId = 'system-app';
    const regularApp = { id: { toString: () => 'regular-app' } };
    const { appModel, tokenModel } = stubModel();
    tokenModel.find.returns(Readable.from([{ _appId: { toString: () => systemAppId } }], { objectMode: true }));
    appModel.find.returns(Readable.from([regularApp], { objectMode: true }));

    const route = createRoute(DeleteAllApps);
    await route._exec(createReq(), {}, true);

    assert.ok(appModel.rm.calledWith(regularApp));
  });

  it('does not delete an app that belongs to a system token even if returned by the query', async () => {
    const systemAppId = 'system-app';
    const systemOwnedApp = { id: { toString: () => systemAppId } };
    const { appModel, tokenModel } = stubModel();
    tokenModel.find.returns(Readable.from([{ _appId: { toString: () => systemAppId } }], { objectMode: true }));
    appModel.find.returns(Readable.from([systemOwnedApp], { objectMode: true }));

    const route = createRoute(DeleteAllApps);
    await route._exec(createReq(), {}, true);

    assert.strictEqual(appModel.rm.called, false);
  });
});

describe('routes/api/app:AppCount', () => {
  it('scopes the count to the authenticated app for a non-system token', async () => {
    const { appModel } = stubModel();
    const route = createRoute(AppCount);
    const req = createReq({ token: { type: 'user' }, body: {} });

    await route._exec(req, {}, await route._validate(req));

    // The queryless body itself is the query, then the scoped model limits it to the authenticated app
    assert.deepStrictEqual(appModel.count.firstCall.args[0], { $and: [{ $and: [{}] }, { id: '6abd05000000000000000001' }] });
  });

  it('counts using the built query', async () => {
    const { appModel } = stubModel();
    const route = createRoute(AppCount);

    await route._exec(createReq(), {}, { query: { name: { $eq: 'a' } } });

    assert.ok(appModel.count.calledWith({ $and: [{ name: { $eq: 'a' } }, { id: '6abd05000000000000000001' }] }));
  });
});

describe('routes/api/app:AppUpdateOAuth', () => {
  it('rejects when no body is posted', async () => {
    stubModel();
    const route = createRoute(AppUpdateOAuth);

    await assert.rejects(route._validate({ ...createReq(), body: undefined }), { code: 'missing_field' });
  });

  it('rejects when the app cannot be found', async () => {
    stubModel({ app: { exists: async () => false } });
    const route = createRoute(AppUpdateOAuth);

    await assert.rejects(route._validate(createReq({ params: { id: '6abd05000000000000000009' }, body: { value: {} } })), {
      status: 404,
      code: 'not_found',
    });
  });

  it('wraps a single oauth value into an array before updating', async () => {
    const { appModel } = stubModel();
    const route = createRoute(AppUpdateOAuth);

    await route._exec(createReq({ params: { id: '6abd05000000000000000001' }, body: { value: { provider: 'google' } } }), {}, true);

    assert.deepStrictEqual(appModel.updateOAuth.firstCall.args, ['6abd05000000000000000001', [{ provider: 'google' }]]);
  });
});

describe('routes/api/app:AppUpdate', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(AppUpdate);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_id' });
  });

  it('rejects when the update path is invalid', async () => {
    stubModel({
      app: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: false, invalidPath: 'bad.path' },
          body: {},
        }),
      },
    });
    const route = createRoute(AppUpdate);

    await assert.rejects(route._validate(createReq({ params: { id: '6abd05000000000000000001' } })), /Update path is invalid/);
  });

  it('rejects when the update value is invalid', async () => {
    stubModel({
      app: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: true, isValueValid: false, invalidValue: 'nope' },
          body: {},
        }),
      },
    });
    const route = createRoute(AppUpdate);

    await assert.rejects(route._validate(createReq({ params: { id: '6abd05000000000000000001' } })), /Update value is invalid/);
  });

  it('rejects when the app does not exist', async () => {
    stubModel({ app: { exists: async () => false } });
    const route = createRoute(AppUpdate);

    await assert.rejects(route._validate(createReq({ params: { id: '6abd05000000000000000001' } })), { code: 'not_found' });
  });

  it("refuses another app's id for a non-system token, as it does an unknown id", async () => {
    const exists = sinon.stub().resolves(true);
    stubModel({ app: { exists } });
    const route = createRoute(AppUpdate);

    for (const type of ['app', 'user', 'lambda']) {
      await assert.rejects(route._validate(createReq({ params: { id: '6abd05000000000000000002' }, token: { type } })), {
        status: 404,
        code: 'not_found',
      });
    }
    assert.strictEqual(exists.callCount, 0);
  });

  it("accepts the caller's own app, and any app for a system token", async () => {
    stubModel();
    const route = createRoute(AppUpdate);

    assert.deepStrictEqual(await route._validate(createReq({ params: { id: '6abd05000000000000000001' }, token: { type: 'app' } })), {
      id: '6abd05000000000000000001',
    });
    assert.deepStrictEqual(await route._validate(createReq({ params: { id: '6abd05000000000000000002' }, token: { type: 'system' } })), {
      id: '6abd05000000000000000002',
    });
  });

  it('updates the app by path once validated', async () => {
    const { appModel } = stubModel();
    const route = createRoute(AppUpdate);

    await route._exec(createReq({ body: [{ path: 'name', value: 'new' }] }), {}, { id: '6abd05000000000000000001' });

    assert.ok(appModel.updateByPath.calledWith([{ path: 'name', value: 'new' }], '6abd05000000000000000001'));
  });
});

describe('routes/api/app:GetAppPolicyPropertyList', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(GetAppPolicyPropertyList);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects fetching another app’s list without a system token', async () => {
    stubModel();
    const route = createRoute(GetAppPolicyPropertyList);
    const req = createReq({ authApp: { id: '6abd05000000000000000001', apiPath: 'app-one' }, params: { apiPath: 'app-two' } });

    await assert.rejects(route._validate(req), { code: 'cannot_fetch_list_for_another_app' });
  });

  it('allows a system token to fetch another app’s list', async () => {
    stubModel({ app: { findOne: async () => ({ policyPropertiesList: { role: ['admin'] } }) } });
    const route = createRoute(GetAppPolicyPropertyList);
    const req = createReq({
      authApp: { id: '6abd05000000000000000001', apiPath: 'app-one' },
      params: { apiPath: 'app-two' },
      token: { type: 'system' },
    });

    const app = await route._validate(req);
    const result = await route._exec(req, {}, app);

    assert.deepStrictEqual(result, { role: ['admin'] });
  });
});

describe('routes/api/app:SetAppPolicyPropertyList', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(SetAppPolicyPropertyList);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects when the body is an array rather than an object', async () => {
    stubModel();
    const route = createRoute(SetAppPolicyPropertyList);

    await assert.rejects(route._validate(createReq({ body: ['not-an-object'] })), { code: 'invalid_type' });
  });

  it('rejects when a list value is not an array', async () => {
    stubModel();
    const route = createRoute(SetAppPolicyPropertyList);

    await assert.rejects(route._validate(createReq({ body: { role: 'not-an-array' } })), { code: 'invalid_field' });
  });

  it('merges new values into the existing list when update=true', async () => {
    stubModel();
    const route = createRoute(SetAppPolicyPropertyList);
    const req = createReq({
      params: { update: 'true' },
      authApp: { id: '6abd05000000000000000001', policyPropertiesList: { role: ['admin'] } },
      body: { role: ['user'] },
    });

    await route._validate(req);

    assert.deepStrictEqual(req.body.role.sort(), ['admin', 'user']);
  });

  it('persists the update, stripping any stray query key', async () => {
    const { appModel } = stubModel();
    const route = createRoute(SetAppPolicyPropertyList);

    const result = await route._exec(createReq(), {}, { appId: '6abd05000000000000000001' });

    assert.ok(appModel.setPolicyPropertiesList.calledWith('6abd05000000000000000001'));
    assert.strictEqual('query' in result, false);
  });
});

describe('routes/api/app:GetAppSchema ?core=', () => {
  const coreModels = {
    User: { isCoreAPI: true, schemaData: { name: 'users', type: 'collection', properties: {} } },
    AppDataSharing: { isCoreAPI: true, schemaData: { name: 'appDataSharing', type: 'collection', properties: {} } },
  };

  const coreNames = async (core) => {
    sinon.stub(Model, 'getCoreModelByName').callsFake((name) => coreModels[name]);
    const route = createRoute(GetAppSchema);
    const req = { query: { core }, context: { id: 'req-1', authApp: { id: '6abd05000000000000000001', __schema: '[]' } } };

    const schema = await route._validate(req, {});
    return schema.map((s) => s.name);
  };

  it("accepts core model names, as before", async () => {
    assert.deepStrictEqual(await coreNames('user,app-data-sharing'), ['users', 'appDataSharing']);
  });

  it("accepts the core schemas' own names", async () => {
    assert.deepStrictEqual(await coreNames('users,appDataSharing'), ['users', 'appDataSharing']);
  });

  it('returns each core schema once, however many times it is named', async () => {
    assert.deepStrictEqual(await coreNames('user,users,appDataSharing,app-data-sharing'), ['users', 'appDataSharing']);
  });

  it('refuses an unknown name with a 400 that names it', async () => {
    await assert.rejects(
      () => coreNames('users,widgets'),
      (err) => err instanceof ApiError && err.status === 400 && err.message === 'Unknown core schema: widgets',
    );
  });
});
