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

import SecureStoreRoutes from '../../../../../dist/routes/api/secure-store.js';
import Model from '../../../../../dist/model/index.js';
import SecureStoreSchemaModel from '../../../../../dist/model/core/secure-store.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';

const [
  AddSecureStore,
  AddManySecureStore,
  GetSecureStore,
  FindSecureStore,
  UpdateSecureStore,
  BulkUpdateSecureStore,
  SearchSecureStoreList,
  DeleteSecureStore,
  SecureStoreCount,
] = SecureStoreRoutes;

const HEX_ID = '507f1f77bcf86cd799439011';

function stubModel({ secureStore = {}, app = {}, lambda = {}, user = {} } = {}) {
  const secureStoreModel = {
    schemaData: { name: 'secureStore' },
    flatSchemaData: {},
    parseQuery: (q) => q,
    findOne: async () => null,
    find: sinon.stub().returns(Readable.from([], { objectMode: true })),
    add: sinon.stub().resolves({ id: 'secure-store-1' }),
    rm: sinon.stub().resolves(),
    count: sinon.stub().resolves(0),
    updateByPath: sinon.stub().resolves(),
    validateUpdate: () => ({ validation: { isValid: true }, body: {} }),
    createId: (v) => v,
    ...secureStore,
  };
  const appModel = { createId: (v) => v, ...app };
  const activityModel = { Constants: { Visibility: { PRIVATE: 'PRIVATE' } } };
  const lambdaModel = { findById: async () => null, ...lambda };
  const userModel = { findById: async () => null, ...user };

  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === SecureStoreSchemaModel) return secureStoreModel;
    if (modelClass === AppSchemaModel) return appModel;
    if (modelClass === ActivitySchemaModel) return activityModel;
    if (modelClass === LambdaSchemaModel) return lambdaModel;
    if (modelClass === UserSchemaModel) return userModel;
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });

  return { secureStoreModel, appModel, lambdaModel, userModel };
}

function createRoute(RouteClass, { nrp } = {}) {
  const route = Object.create(RouteClass.prototype);
  route.schemaName = 'secureStore';
  route._nrp = nrp || { emit: sinon.spy() };
  return route;
}

function createReq({ params = {}, body = {}, authApp = { id: 'app-1' }, token = { type: 'app' } } = {}) {
  return { params, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/secure-store:AddSecureStore', () => {
  it('rejects when the name field is missing', async () => {
    stubModel();
    const route = createRoute(AddSecureStore);

    await assert.rejects(route._validate(createReq({ body: {} })), /missing_field/);
  });

  it('rejects when a secure store with the same name already exists', async () => {
    stubModel({ secureStore: { findOne: async () => ({ id: 'existing' }) } });
    const route = createRoute(AddSecureStore);

    await assert.rejects(route._validate(createReq({ body: { name: 'test' } })), /already_exist/);
  });

  it('resolves the app id directly from the authenticated app when available', async () => {
    stubModel();
    const route = createRoute(AddSecureStore);

    const result = await route._validate(createReq({ body: { name: 'test' } }));

    assert.deepStrictEqual(result, { appId: 'app-1' });
  });

  it('falls back to the lambda token’s app id when there is no authenticated app', async () => {
    stubModel({ lambda: { findById: async () => ({ _appId: 'app-from-lambda' }) } });
    const route = createRoute(AddSecureStore);
    const req = createReq({ authApp: { id: null }, token: { _lambdaId: 'lambda-1' }, body: { name: 'test' } });

    const result = await route._validate(req);

    assert.strictEqual(result.appId, 'app-from-lambda');
  });

  it('adds the entity scoped to the resolved app id', () => {
    const { secureStoreModel } = stubModel();
    const route = createRoute(AddSecureStore);

    route._exec(createReq({ body: { name: 'test' } }), {}, { appId: 'app-1' });

    assert.ok(secureStoreModel.add.calledWith({ name: 'test' }, 'app-1'));
  });
});

describe('routes/api/secure-store:AddManySecureStore', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(AddManySecureStore);

    await assert.rejects(route._validate(createReq({ authApp: null })), /missing_field/);
  });

  it('rejects when the body is not an array', async () => {
    stubModel();
    const route = createRoute(AddManySecureStore);

    await assert.rejects(route._validate(createReq({ body: {} })), /invalid_body/);
  });

  it('rejects when an item in the batch is missing a name', async () => {
    stubModel();
    const route = createRoute(AddManySecureStore);

    await assert.rejects(route._validate(createReq({ body: [{ name: 'a' }, {}] })), /missing_field/);
  });

  it('rejects when an item in the batch already exists', async () => {
    stubModel({ secureStore: { findOne: async () => ({ id: 'existing' }) } });
    const route = createRoute(AddManySecureStore);

    await assert.rejects(route._validate(createReq({ body: [{ name: 'a' }] })), /already_exist/);
  });
});

describe('routes/api/secure-store:GetSecureStore', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(GetSecureStore);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetSecureStore);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_secure_store_id/);
  });

  it('rejects when the id is not a valid ObjectId', async () => {
    stubModel();
    const route = createRoute(GetSecureStore);

    await assert.rejects(route._validate(createReq({ params: { id: 'bad-id' } })), /invalid_secure_store_id/);
  });

  it('rejects when no secure store matches the id (empty stream)', async () => {
    stubModel({ secureStore: { find: sinon.stub().returns(Readable.from([], { objectMode: true })) } });
    const route = createRoute(GetSecureStore);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /secure_store_does_not_exist/);
  });

  it('resolves the matching secure store', async () => {
    stubModel({
      secureStore: { find: sinon.stub().returns(Readable.from([{ id: HEX_ID, name: 'test' }], { objectMode: true })) },
    });
    const route = createRoute(GetSecureStore);

    const result = await route._validate(createReq({ params: { id: HEX_ID } }));

    assert.strictEqual(result.name, 'test');
  });
});

describe('routes/api/secure-store:FindSecureStore', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(FindSecureStore);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when no name parameter is provided', async () => {
    stubModel();
    const route = createRoute(FindSecureStore);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_field/);
  });

  it('rejects with 404 when no secure store matches the name', async () => {
    stubModel();
    const route = createRoute(FindSecureStore);

    await assert.rejects(route._validate(createReq({ params: { name: 'missing' } })), (err) => {
      assert.strictEqual(err.code, 404);
      assert.strictEqual(err.message, 'not_found');
      return true;
    });
  });

  it('resolves the matching secure store', async () => {
    stubModel({ secureStore: { findOne: async () => ({ name: 'found-it' }) } });
    const route = createRoute(FindSecureStore);

    const result = await route._validate(createReq({ params: { name: 'found-it' } }));

    assert.strictEqual(result.name, 'found-it');
  });
});

describe('routes/api/secure-store:UpdateSecureStore', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(UpdateSecureStore);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when the update path is invalid', async () => {
    stubModel({
      secureStore: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: false, invalidPath: 'bad.path' },
          body: {},
        }),
      },
    });
    const route = createRoute(UpdateSecureStore);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /Update path is invalid/);
  });

  it('rejects when no secure store matches the id', async () => {
    stubModel({ secureStore: { findOne: async () => null } });
    const route = createRoute(UpdateSecureStore);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('updates the secure store by path', async () => {
    const { secureStoreModel } = stubModel();
    const route = createRoute(UpdateSecureStore);

    await route._exec(createReq({ body: { path: 'name', value: 'new' } }), {}, { id: HEX_ID });

    assert.ok(secureStoreModel.updateByPath.calledWith({ path: 'name', value: 'new' }, HEX_ID));
  });
});

describe('routes/api/secure-store:BulkUpdateSecureStore', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(BulkUpdateSecureStore);

    await assert.rejects(route._validate(createReq({ authApp: null, body: [] })), /no_authenticated_app/);
  });

  it('rejects when one item in the batch does not exist', async () => {
    stubModel({ secureStore: { findOne: async () => null } });
    const route = createRoute(BulkUpdateSecureStore);

    await assert.rejects(
      route._validate(createReq({ body: [{ id: HEX_ID, body: { path: 'name', value: 'a' } }] })),
      /invalid_id/,
    );
  });

  it('applies every update in the batch', async () => {
    const { secureStoreModel } = stubModel({ secureStore: { findOne: async () => ({ id: HEX_ID }) } });
    const route = createRoute(BulkUpdateSecureStore);
    const batch = [
      { id: 'ss-1', body: { path: 'name', value: 'a' } },
      { id: 'ss-2', body: { path: 'name', value: 'b' } },
    ];

    const result = await route._exec(createReq(), {}, batch);

    assert.strictEqual(secureStoreModel.updateByPath.callCount, 2);
    assert.strictEqual(result, true);
  });
});

describe('routes/api/secure-store:SearchSecureStoreList', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(SearchSecureStoreList);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when skip is not a number', async () => {
    stubModel();
    const route = createRoute(SearchSecureStoreList);

    await assert.rejects(route._validate(createReq({ body: { skip: 'abc' } })), /invalid_value_skip/);
  });

  it('always scopes the search to the authenticated app', async () => {
    stubModel();
    const route = createRoute(SearchSecureStoreList);

    const result = await route._validate(createReq());

    assert.deepStrictEqual(result.query.$and, [{ _appId: 'app-1' }]);
  });

  it('finds using the built query params', () => {
    const { secureStoreModel } = stubModel();
    secureStoreModel.find.returns('a-stream');
    const route = createRoute(SearchSecureStoreList);
    const validate = { query: { $and: [] }, skip: 0, limit: 10, sort: {}, project: false };

    const result = route._exec(createReq(), {}, validate);

    assert.strictEqual(result, 'a-stream');
    assert.deepStrictEqual(secureStoreModel.find.firstCall.args, [validate.query, {}, 10, 0, {}, false]);
  });
});

describe('routes/api/secure-store:DeleteSecureStore', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(DeleteSecureStore);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteSecureStore);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_secure_store_id/);
  });

  it('rejects with 404 when no secure store matches the id', async () => {
    stubModel();
    const route = createRoute(DeleteSecureStore);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), (err) => {
      assert.strictEqual(err.code, 404);
      return true;
    });
  });

  it('removes the matched secure store', async () => {
    const { secureStoreModel } = stubModel();
    const route = createRoute(DeleteSecureStore);

    const result = await route._exec(createReq(), {}, { id: 'secure-store-1' });

    assert.ok(secureStoreModel.rm.calledWith('secure-store-1'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/secure-store:SecureStoreCount', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(SecureStoreCount);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('always scopes the count to the authenticated app', async () => {
    stubModel();
    const route = createRoute(SecureStoreCount);

    const result = await route._validate(createReq({ body: {} }));

    assert.deepStrictEqual(result.query.$and, [{}, { _appId: 'app-1' }]);
  });

  it('counts using the built query', async () => {
    const { secureStoreModel } = stubModel();
    const route = createRoute(SecureStoreCount);

    await route._exec(createReq(), {}, { query: { $and: [] } });

    assert.ok(secureStoreModel.count.calledWith({ $and: [] }));
  });
});
