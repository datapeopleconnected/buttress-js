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

import AppDataSharingRoutes from '../../../../../dist/routes/api/app-data-sharing.js';
import Model from '../../../../../dist/model/index.js';
import AppDataSharingSchemaModel from '../../../../../dist/model/core/app-data-sharing.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';

const [
  GetAppDataSharing,
  AddDataSharing,
  UpdateAppDataSharing,
  BulkUpdateAppDataSharing,
  UpdateAppDataSharingPolicy,
  ActivateAppDataSharing,
  ReactivateAppDataSharing,
  DeactivateAppDataSharing,
  StatusAppDataSharing,
  GetAllAppDataSharing,
  SearchAppDataSharingAgreement,
  AppDataSharingAgreementCount,
  DeleteDataSharingAgreement,
  DeleteAllDataSharingAgreement,
] = AppDataSharingRoutes;

const HEX_ID = '507f1f77bcf86cd799439011';

function stubModel({ ds = {}, token = {} } = {}) {
  const dsModel = {
    schemaData: { name: 'appDataSharing' },
    flatSchemaData: {},
    parseQuery: (q) => q,
    createId: (v) => v,
    validate: () => ({ isValid: true }),
    isDuplicate: async () => false,
    findById: async () => null,
    find: sinon.stub(),
    findAll: sinon.stub(),
    add: sinon.stub().resolves({
      dataSharing: { id: 'ds-1', remoteApp: {} },
      token: { id: 'token-1', value: 'reg-token-value' },
    }),
    exists: sinon.stub().resolves(true),
    validateUpdate: () => ({ validation: { isValid: true }, body: {} }),
    updateByPath: sinon.stub().resolves(),
    updatePolicy: sinon.stub().resolves(),
    activate: sinon.stub().resolves(),
    deactivate: sinon.stub().resolves(),
    rm: sinon.stub().resolves(),
    rmBulk: sinon.stub().resolves(),
    count: sinon.stub().resolves(0),
    ...ds,
  };
  const tokenModel = {
    Constants: { Type: { SYSTEM: 'system', DATA_SHARING: 'dataSharing' } },
    createTokenString: () => 'new-token-string',
    findById: async () => null,
    updateById: sinon.stub().resolves(),
    rm: sinon.stub().resolves(),
    rmBulk: sinon.stub().resolves(),
    ...token,
  };
  const activityModel = { Constants: { Visibility: { PRIVATE: 'PRIVATE' } } };

  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === AppDataSharingSchemaModel) return dsModel;
    if (modelClass === TokenSchemaModel) return tokenModel;
    if (modelClass === ActivitySchemaModel) return activityModel;
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });

  return { dsModel, tokenModel };
}

function createRoute(RouteClass, { nrp } = {}) {
  const route = Object.create(RouteClass.prototype);
  route.schemaName = 'appDataSharing';
  route._nrp = nrp || { emit: sinon.spy() };
  return route;
}

function createReq({ params = {}, body = {}, authApp = { id: 'app-1' }, token = { type: 'app' } } = {}) {
  return { params, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/app-data-sharing:GetAppDataSharing', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(GetAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_app_data_sharing_id/);
  });

  it('rejects when no data sharing agreement is found', async () => {
    stubModel({ ds: { findById: async () => null } });
    const route = createRoute(GetAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /app_data_sharing_does_not_exist/);
  });
});

describe('routes/api/app-data-sharing:AddDataSharing', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects with the first missing field', async () => {
    stubModel({ ds: { validate: () => ({ isValid: false, missing: ['name'], invalid: [] }) } });
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq()), /Missing field: name/);
  });

  it('rejects when policyConfig is missing', async () => {
    stubModel();
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq({ body: {} })), /missing_policy/);
  });

  it('rejects duplicate agreements', async () => {
    stubModel({ ds: { isDuplicate: async () => true } });
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq({ body: { policyConfig: {} } })), /duplicate/);
  });

  it('scopes appId to the token’s app when not a system token', async () => {
    stubModel();
    const route = createRoute(AddDataSharing);
    const req = createReq({ token: { type: 'app', _appId: 'app-from-token' }, body: { policyConfig: {} } });

    await route._validate(req);

    assert.strictEqual(req.body.appId, 'app-from-token');
  });

  it('adds the agreement and returns a registration token when not auto-activating', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(AddDataSharing);

    const result = await route._exec(createReq({ body: { policyConfig: {} } }), {}, true);

    assert.ok(dsModel.add.calledWith({ policyConfig: {} }));
    assert.strictEqual(result.registrationToken, 'reg-token-value');
  });
});

describe('routes/api/app-data-sharing:UpdateAppDataSharing', () => {
  it('rejects when no data sharing id is provided', async () => {
    stubModel();
    const route = createRoute(UpdateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_data_sharing_id/);
  });

  it('rejects when the agreement does not exist', async () => {
    stubModel({ ds: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), /invalid_id/);
  });

  it('rejects when the update path is invalid', async () => {
    stubModel({
      ds: {
        validateUpdate: () => ({
          validation: { isValid: false, isPathValid: false, invalidPath: 'bad.path' },
          body: {},
        }),
      },
    });
    const route = createRoute(UpdateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), /Update path is invalid/);
  });

  it('updates the agreement by path', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(UpdateAppDataSharing);

    await route._exec(createReq({ body: { path: 'name', value: 'new' } }), {}, { dataSharingId: HEX_ID });

    assert.ok(dsModel.updateByPath.calledWith({ path: 'name', value: 'new' }, HEX_ID));
  });
});

describe('routes/api/app-data-sharing:BulkUpdateAppDataSharing', () => {
  it('rejects when one item in the batch does not exist', async () => {
    stubModel({ ds: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(BulkUpdateAppDataSharing);

    await assert.rejects(route._validate(createReq({ body: [{ id: HEX_ID, body: { path: 'name' } }] })), /invalid_id/);
  });

  it('applies every update in the batch', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(BulkUpdateAppDataSharing);
    const body = [
      { id: 'ds-1', body: { path: 'name', value: 'a' } },
      { id: 'ds-2', body: { path: 'name', value: 'b' } },
    ];

    const result = await route._exec(createReq({ body }), {}, true);

    assert.strictEqual(dsModel.updateByPath.callCount, 2);
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:UpdateAppDataSharingPolicy', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(UpdateAppDataSharingPolicy);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when no data sharing id is provided', async () => {
    stubModel();
    const route = createRoute(UpdateAppDataSharingPolicy);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_data_sharing_id/);
  });

  it('rejects when the agreement is not scoped to the authenticated app', async () => {
    stubModel({ ds: { exists: sinon.stub().resolves(false) } });
    const route = createRoute(UpdateAppDataSharingPolicy);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), /unknown_data_sharing/);
  });

  it('updates the local policy for the agreement', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(UpdateAppDataSharingPolicy);

    const result = await route._exec(
      createReq({ params: { dataSharingId: HEX_ID }, body: { some: 'policy' } }),
      {},
      { appId: 'app-1' },
    );

    assert.ok(dsModel.updatePolicy.calledWith('app-1', HEX_ID, 'local', { some: 'policy' }));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:ActivateAppDataSharing', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when there is no authenticated token', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ token: null })), /no_authenticated_token/);
  });

  it('rejects when the token is not a dataSharing token', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ token: { type: 'user' } })), /invalid_token_type/);
  });

  it('rejects when newToken is missing from the body', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(
      route._validate(createReq({ token: { type: 'dataSharing' }, body: {} })),
      /missing_data_token/,
    );
  });

  it('rejects when no matching data sharing agreement is found', async () => {
    stubModel({ ds: { findById: async () => null } });
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(
      route._validate(
        createReq({ token: { type: 'dataSharing', _appDataSharingId: 'ds-1' }, body: { newToken: 'x' } }),
      ),
      /no_datasharing/,
    );
  });

  it('does nothing and returns true when already active', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    const result = await route._exec(createReq(), {}, { token: { id: 'token-1' }, dataSharing: { active: true } });

    assert.strictEqual(result, true);
  });

  it('activates the agreement and cycles the token when not yet active', async () => {
    const { dsModel, tokenModel } = stubModel();
    const route = createRoute(ActivateAppDataSharing);
    const req = createReq({ body: { newToken: 'remote-token-value' } });

    const result = await route._exec(req, {}, { token: { id: 'token-1' }, dataSharing: { id: 'ds-1', active: false } });

    assert.ok(dsModel.activate.calledWith('ds-1', 'remote-token-value'));
    assert.ok(tokenModel.updateById.calledWith('token-1', { $set: { value: 'new-token-string' } }));
    assert.strictEqual(result.status, true);
    assert.strictEqual(result.token, 'new-token-string');
  });
});

describe('routes/api/app-data-sharing:ReactivateAppDataSharing', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(ReactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ authApp: null })), /no_authenticated_app/);
  });

  it('rejects when no data sharing id param is provided', async () => {
    stubModel();
    const route = createRoute(ReactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_data_id/);
  });

  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findById: async () => null } });
    const route = createRoute(ReactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), /no_datasharing/);
  });

  it('deactivates and resolves true (route name notwithstanding)', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(ReactivateAppDataSharing);

    const result = await route._exec(createReq(), {}, { id: 'ds-1' });

    assert.ok(dsModel.deactivate.calledWith('ds-1'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:DeactivateAppDataSharing', () => {
  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findById: async () => null } });
    const route = createRoute(DeactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), /no_datasharing/);
  });

  it('deactivates the agreement', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(DeactivateAppDataSharing);

    const result = await route._exec(createReq(), {}, { id: 'ds-1' });

    assert.ok(dsModel.deactivate.calledWith('ds-1'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:StatusAppDataSharing', () => {
  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findById: async () => null } });
    const route = createRoute(StatusAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), /no_datasharing/);
  });

  it('always reports not connected', async () => {
    stubModel();
    const route = createRoute(StatusAppDataSharing);

    const result = await route._exec(createReq(), {});

    assert.deepStrictEqual(result, { connected: false });
  });
});

describe('routes/api/app-data-sharing:GetAllAppDataSharing', () => {
  it('scopes the list to the authenticated app for a non-system token', () => {
    const { dsModel } = stubModel();
    const route = createRoute(GetAllAppDataSharing);

    route._exec(createReq({ token: { type: 'app' } }), {});

    assert.ok(dsModel.find.calledWith({ _appId: 'app-1' }));
  });

  it('returns every agreement for a system token', () => {
    const { dsModel } = stubModel();
    const route = createRoute(GetAllAppDataSharing);

    route._exec(createReq({ token: { type: 'system' } }), {});

    assert.ok(dsModel.findAll.calledOnce);
  });
});

describe('routes/api/app-data-sharing:SearchAppDataSharingAgreement', () => {
  it('rejects when skip is not a number', async () => {
    stubModel();
    const route = createRoute(SearchAppDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ body: { skip: 'abc' } })), /invalid_value_skip/);
  });

  it('scopes the search to the authenticated app for a non-system token', async () => {
    stubModel();
    const route = createRoute(SearchAppDataSharingAgreement);

    const result = await route._validate(createReq({ token: { type: 'app' } }));

    assert.deepStrictEqual(result.query.$and, [{ _appId: 'app-1' }]);
  });

  it('finds using the built query params', () => {
    const { dsModel } = stubModel();
    dsModel.find.returns('a-stream');
    const route = createRoute(SearchAppDataSharingAgreement);
    const validate = { query: { $and: [] }, skip: 0, limit: 10, sort: {}, project: false };

    const result = route._exec(createReq(), {}, validate);

    assert.strictEqual(result, 'a-stream');
    assert.deepStrictEqual(dsModel.find.firstCall.args, [validate.query, {}, 10, 0, {}, false]);
  });
});

describe('routes/api/app-data-sharing:AppDataSharingAgreementCount', () => {
  it('scopes the count to the authenticated app for a non-system token', async () => {
    stubModel();
    const route = createRoute(AppDataSharingAgreementCount);

    const result = await route._validate(createReq({ token: { type: 'app' }, body: {} }));

    assert.deepStrictEqual(result.query.$and, [{}, { _appId: 'app-1' }]);
  });

  it('counts using the built query', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(AppDataSharingAgreementCount);

    await route._exec(createReq(), {}, { query: { $and: [] } });

    assert.ok(dsModel.count.calledWith({ $and: [] }));
  });
});

describe('routes/api/app-data-sharing:DeleteDataSharingAgreement', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ params: {} })), /missing_required_id/);
  });

  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findById: async () => null } });
    const route = createRoute(DeleteDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /invalid_id/);
  });

  it('rejects when the agreement token cannot be found', async () => {
    stubModel({
      ds: { findById: async () => ({ id: 'ds-1', _tokenId: 'token-1' }) },
      token: { findById: async () => null },
    });
    const route = createRoute(DeleteDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), /could_not_fetch_data_sharing_token/);
  });

  it('removes the agreement and its token', async () => {
    const { dsModel, tokenModel } = stubModel();
    const route = createRoute(DeleteDataSharingAgreement);
    const validate = { appDataSharing: { id: 'ds-1' }, token: { id: 'token-1' } };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(dsModel.rm.calledWith('ds-1'));
    assert.ok(tokenModel.rm.calledWith('token-1'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:DeleteAllDataSharingAgreement', () => {
  it('collects the ids of every agreement and their tokens', async () => {
    const docs = [
      { id: 'ds-1', _tokenId: 'token-1' },
      { id: 'ds-2', _tokenId: 'token-2' },
    ];
    stubModel({ ds: { find: sinon.stub().resolves(Readable.from(docs, { objectMode: true })) } });
    const route = createRoute(DeleteAllDataSharingAgreement);

    const result = await route._validate(createReq());

    assert.deepStrictEqual(result, { dsIds: ['ds-1', 'ds-2'], tokenIds: ['token-1', 'token-2'] });
  });

  it('bulk-removes every collected agreement and token id', async () => {
    const { dsModel, tokenModel } = stubModel();
    const route = createRoute(DeleteAllDataSharingAgreement);
    const validate = { dsIds: ['ds-1', 'ds-2'], tokenIds: ['token-1', 'token-2'] };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(dsModel.rmBulk.calledWith(['ds-1', 'ds-2']));
    assert.ok(tokenModel.rmBulk.calledWith(['token-1', 'token-2']));
    assert.strictEqual(result, true);
  });
});
