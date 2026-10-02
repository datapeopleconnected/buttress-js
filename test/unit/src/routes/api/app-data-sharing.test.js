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
import StandardModel from '../../../../../dist/model/type/standard.js';

import { realQueryParser } from '../../../../query-parser.js';
import createConfig from '@dpc/node-env-obj';

const Config = createConfig();


// A core model's own update validation, as the route runs it
const realValidateUpdate = (ModelClass) => (body) =>
  StandardModel.prototype.validateUpdate.call({ schemaData: ModelClass.Schema }, body);

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
    ...realQueryParser(AppDataSharingSchemaModel),
    createId: (v) => v,
    validate: () => ({ isValid: true }),
    isDuplicate: async () => false,
    findById: async () => null,
    // The scoped model finds an agreement by id with findOne, which answers as findById does, as the datastore would
    async findOne(query) {
      return query && 'id' in query ? this.findById(query.id) : null;
    },
    find: sinon.stub(),
    findAll: sinon.stub(),
    add: sinon.stub().resolves({
      dataSharing: { id: '6abd08000000000000000001', remoteApp: {} },
      token: { id: '6abd02000000000000000001', value: 'reg-token-value' },
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
    ...realQueryParser(TokenSchemaModel),
    Constants: { Type: { SYSTEM: 'system', DATA_SHARING: 'dataSharing' } },
    createTokenString: () => 'new-token-string',
    findById: async () => null,
    async findOne(query) {
      return query && 'id' in query ? this.findById(query.id) : null;
    },
    exists: sinon.stub().resolves(true),
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

function createReq({ params = {}, body = {}, authApp = { id: '6abd05000000000000000001' }, token = { type: 'app' } } = {}) {
  return { params, body, context: { id: 'req-1', authApp, token } };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api/app-data-sharing:GetAppDataSharing', () => {
  it('rejects when no data sharing agreement is found', async () => {
    stubModel({ ds: { findOne: async () => null } });
    const route = createRoute(GetAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });
});

describe('routes/api/app-data-sharing:AddDataSharing', () => {
  describe('with a data sharing allow-list', () => {
    let saved;
    beforeEach(() => {
      saved = Config.dataSharing.allowedHosts;
      Config.dataSharing.allowedHosts = '93.184.216.34';
    });
    afterEach(() => {
      Config.dataSharing.allowedHosts = saved;
    });

    it("refuses a remote app at a host that isn't on it, or without a scheme", async () => {
      for (const [remoteApp, message] of [
        [{ endpoint: 'https://8.8.8.8', apiPath: 'x' }, 'data_sharing_host_not_allowed'],
        [{ endpoint: 'http://169.254.169.254', apiPath: 'x' }, 'data_sharing_host_not_allowed'],
        [{ endpoint: '93.184.216.34', apiPath: 'x' }, 'data_sharing_invalid_url'],
        [{ endpoint: 'https://93.184.216.34', ws: 'ws://127.0.0.1:8010', apiPath: 'x' }, 'data_sharing_host_not_allowed'],
      ]) {
        stubModel();
        const route = createRoute(AddDataSharing);
        await assert.rejects(route._validate(createReq({ body: { policyConfig: {}, remoteApp } })), (err) => err.code === message, JSON.stringify(remoteApp));
        sinon.restore();
      }
    });
  });

  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects with the first missing field', async () => {
    stubModel({ ds: { validate: () => ({ isValid: false, missing: ['name'], invalid: [] }) } });
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq()), /Missing field: name/);
  });

  it('rejects when policyConfig is missing', async () => {
    stubModel();
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq({ body: {} })), { code: 'missing_policy' });
  });

  it('rejects duplicate agreements', async () => {
    stubModel({ ds: { isDuplicate: async () => true } });
    const route = createRoute(AddDataSharing);

    await assert.rejects(route._validate(createReq({ body: { policyConfig: {} } })), { code: 'duplicate' });
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

    assert.ok(dsModel.add.calledWith({ policyConfig: {} }, { _appId: '6abd05000000000000000001' }));
    assert.strictEqual(result.registrationToken, 'reg-token-value');
  });

  it('adds the agreement for the app a system token names', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(AddDataSharing);

    await route._exec(createReq({ token: { type: 'system' }, body: { policyConfig: {}, appId: '6abd05000000000000000002' } }), {}, true);

    assert.ok(dsModel.add.calledWith(sinon.match.any, { _appId: '6abd05000000000000000002' }));
  });
});

describe('routes/api/app-data-sharing:UpdateAppDataSharing', () => {
  it('says an update is missing its value, rather than that its path is invalid', async () => {
    stubModel({ ds: { validateUpdate: realValidateUpdate(AppDataSharingSchemaModel) } });
    const route = createRoute(UpdateAppDataSharing);

    await assert.rejects(
      route._validate(createReq({ params: { dataSharingId: HEX_ID }, body: [{ path: 'name' }] })),
      (err) => err.status === 400 && err.code === 'invalid_update' && err.message.endsWith(': Update is missing its value'),
    );
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

});

describe('routes/api/app-data-sharing:BulkUpdateAppDataSharing', () => {
  it('rejects a request with no body', async () => {
    stubModel();
    const route = createRoute(BulkUpdateAppDataSharing);

    await assert.rejects(route._validate(Object.assign(createReq(), { body: undefined })), { code: 'array_required' });
  });

});

describe('routes/api/app-data-sharing:UpdateAppDataSharingPolicy', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(UpdateAppDataSharingPolicy);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects when no data sharing id is provided', async () => {
    stubModel();
    const route = createRoute(UpdateAppDataSharingPolicy);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_id' });
  });

  it('rejects when the agreement is not scoped to the authenticated app', async () => {
    const findOne = sinon.stub().resolves(null);
    stubModel({ ds: { findOne } });
    const route = createRoute(UpdateAppDataSharingPolicy);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), { status: 404, code: 'not_found' });
    assert.deepStrictEqual(findOne.firstCall.args[0], {
      $and: [{ id: HEX_ID, _appId: '6abd05000000000000000001' }, { _appId: '6abd05000000000000000001' }],
    });
  });

  it('updates the local policy for the agreement', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(UpdateAppDataSharingPolicy);

    const result = await route._exec(
      createReq({ params: { dataSharingId: HEX_ID }, body: { some: 'policy' } }),
      {},
      { appId: '6abd05000000000000000001' },
    );

    assert.ok(dsModel.updatePolicy.calledWith('6abd05000000000000000001', HEX_ID, 'local', { some: 'policy' }));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:ActivateAppDataSharing', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects when there is no authenticated token', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ token: null })), { code: 'internal_error' });
  });

  it('rejects when the token is not a dataSharing token', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ token: { type: 'user' } })), { code: 'invalid_token_type' });
  });

  it('rejects when newToken is missing from the body', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(
      route._validate(createReq({ token: { type: 'dataSharing' }, body: {} })),
      { code: 'missing_data_token' },
    );
  });

  // The agreement is the token's own, so one that's gone is a fault
  it('rejects when no matching data sharing agreement is found, as an internal error', async () => {
    stubModel({ ds: { findById: async () => null } });
    const route = createRoute(ActivateAppDataSharing);

    await assert.rejects(
      route._validate(
        createReq({ token: { type: 'dataSharing', _appDataSharingId: '6abd08000000000000000001' }, body: { newToken: 'x' } }),
      ),
      { code: 'internal_error' },
    );
  });

  it('does nothing and returns true when already active', async () => {
    stubModel();
    const route = createRoute(ActivateAppDataSharing);

    const result = await route._exec(createReq(), {}, { token: { id: '6abd02000000000000000001' }, dataSharing: { active: true } });

    assert.strictEqual(result, true);
  });

  it('activates the agreement and cycles the token when not yet active', async () => {
    const { dsModel, tokenModel } = stubModel();
    const route = createRoute(ActivateAppDataSharing);
    const req = createReq({ body: { newToken: 'remote-token-value' } });

    const result = await route._exec(req, {}, { token: { id: '6abd02000000000000000001' }, dataSharing: { id: '6abd08000000000000000001', active: false } });

    assert.ok(dsModel.activate.calledWith('6abd08000000000000000001', 'remote-token-value'));
    assert.ok(tokenModel.updateById.calledWith('6abd02000000000000000001', { $set: { value: 'new-token-string' } }));
    assert.strictEqual(result.status, true);
    assert.strictEqual(result.token, 'new-token-string');
  });
});

describe('routes/api/app-data-sharing:ReactivateAppDataSharing', () => {
  it('rejects when there is no authenticated app', async () => {
    stubModel();
    const route = createRoute(ReactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ authApp: null })), { code: 'internal_error' });
  });

  it('rejects when no data sharing id param is provided', async () => {
    stubModel();
    const route = createRoute(ReactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_id' });
  });

  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findOne: async () => null } });
    const route = createRoute(ReactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), { code: 'not_found' });
  });

  it('activates the agreement and resolves true', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(ReactivateAppDataSharing);

    const result = await route._exec(createReq(), {}, { id: '6abd08000000000000000001' });

    assert.ok(dsModel.activate.calledWith('6abd08000000000000000001'));
    assert.ok(dsModel.deactivate.notCalled);
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:DeactivateAppDataSharing', () => {
  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findOne: async () => null } });
    const route = createRoute(DeactivateAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), { code: 'not_found' });
  });

  it('deactivates the agreement', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(DeactivateAppDataSharing);

    const result = await route._exec(createReq(), {}, { id: '6abd08000000000000000001' });

    assert.ok(dsModel.deactivate.calledWith('6abd08000000000000000001'));
    assert.strictEqual(result, true);
  });
});

describe('routes/api/app-data-sharing:StatusAppDataSharing', () => {
  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findOne: async () => null } });
    const route = createRoute(StatusAppDataSharing);

    await assert.rejects(route._validate(createReq({ params: { dataSharingId: HEX_ID } })), { code: 'not_found' });
  });

  it('always reports not connected', async () => {
    stubModel();
    const route = createRoute(StatusAppDataSharing);

    const result = await route._exec(createReq(), {});

    assert.deepStrictEqual(result, { connected: false });
  });
});


describe('routes/api/app-data-sharing:SearchAppDataSharingAgreement', () => {
  it('rejects an array body', async () => {
    stubModel();
    const route = createRoute(SearchAppDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ body: [] })), { code: 'invalid_body' });
  });

  it('rejects when skip is not a number', async () => {
    stubModel();
    const route = createRoute(SearchAppDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ body: { skip: 'abc' } })), { code: 'invalid_value_skip' });
  });

  it('scopes the search to the authenticated app for a non-system token', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(SearchAppDataSharingAgreement);
    const req = createReq({ token: { type: 'app' } });

    await route._exec(req, {}, await route._validate(req));

    assert.deepStrictEqual(dsModel.find.firstCall.args[0], { _appId: '6abd05000000000000000001' });
  });

  it('finds using the built query params', () => {
    const { dsModel } = stubModel();
    dsModel.find.returns('a-stream');
    const route = createRoute(SearchAppDataSharingAgreement);
    const validate = { query: { name: { $eq: 'a' } }, skip: 0, limit: 10, sort: {}, project: false };

    const result = route._exec(createReq(), {}, validate);

    assert.strictEqual(result, 'a-stream');
    assert.deepStrictEqual(dsModel.find.firstCall.args, [
      { $and: [validate.query, { _appId: '6abd05000000000000000001' }] },
      {},
      10,
      0,
      {},
      false,
    ]);
  });
});

describe('routes/api/app-data-sharing:AppDataSharingAgreementCount', () => {
  it('scopes the count to the authenticated app for a non-system token', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(AppDataSharingAgreementCount);

    const req = createReq({ token: { type: 'app' } });
    req.body = undefined;

    await route._exec(req, {}, await route._validate(req));

    assert.ok(dsModel.count.calledWith({ _appId: '6abd05000000000000000001' }));
  });

  it('counts using the built query', async () => {
    const { dsModel } = stubModel();
    const route = createRoute(AppDataSharingAgreementCount);

    await route._exec(createReq(), {}, { query: { name: { $eq: 'a' } } });

    assert.ok(dsModel.count.calledWith({ $and: [{ name: { $eq: 'a' } }, { _appId: '6abd05000000000000000001' }] }));
  });
});

describe('routes/api/app-data-sharing:DeleteDataSharingAgreement', () => {
  it('rejects when no id is provided', async () => {
    stubModel();
    const route = createRoute(DeleteDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ params: {} })), { code: 'missing_id' });
  });

  it('rejects when the agreement cannot be found', async () => {
    stubModel({ ds: { findOne: async () => null } });
    const route = createRoute(DeleteDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it('rejects when the agreement token cannot be found', async () => {
    stubModel({
      ds: { findOne: async () => ({ id: '6abd08000000000000000001', _tokenId: '6abd02000000000000000001' }) },
      token: { findById: async () => null },
    });
    const route = createRoute(DeleteDataSharingAgreement);

    await assert.rejects(route._validate(createReq({ params: { id: HEX_ID } })), { code: 'not_found' });
  });

  it('removes the agreement and its token', async () => {
    const { dsModel, tokenModel } = stubModel();
    const route = createRoute(DeleteDataSharingAgreement);
    const validate = { appDataSharing: { id: '6abd08000000000000000001' }, token: { id: '6abd02000000000000000001' } };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(dsModel.rm.calledWith('6abd08000000000000000001'));
    assert.ok(tokenModel.rm.calledWith('6abd02000000000000000001'));
    assert.strictEqual(result, true);
  });

  it('has the Socket processes close its connection to the partner', async () => {
    stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(DeleteDataSharingAgreement, { nrp });

    await route._exec(createReq(), {}, { appDataSharing: { id: '6abd08000000000000000001' }, token: { id: '6abd02000000000000000001' } });

    assert.ok(nrp.emit.calledWith('dataShare:deactivated', JSON.stringify({ appDataSharingId: '6abd08000000000000000001' })));
  });
});

describe('routes/api/app-data-sharing:DeleteAllDataSharingAgreement', () => {
  it('collects the ids of every agreement and their tokens', async () => {
    const docs = [
      { id: '6abd08000000000000000001', _tokenId: '6abd02000000000000000001' },
      { id: '6abd08000000000000000002', _tokenId: '6abd02000000000000000002' },
    ];
    stubModel({ ds: { find: sinon.stub().resolves(Readable.from(docs, { objectMode: true })) } });
    const route = createRoute(DeleteAllDataSharingAgreement);

    const result = await route._validate(createReq());

    assert.deepStrictEqual(result, { dsIds: ['6abd08000000000000000001', '6abd08000000000000000002'], tokenIds: ['6abd02000000000000000001', '6abd02000000000000000002'] });
  });

  it('bulk-removes every collected agreement and token id', async () => {
    const { dsModel, tokenModel } = stubModel();
    const route = createRoute(DeleteAllDataSharingAgreement);
    const validate = { dsIds: ['6abd08000000000000000001', '6abd08000000000000000002'], tokenIds: ['6abd02000000000000000001', '6abd02000000000000000002'] };

    const result = await route._exec(createReq(), {}, validate);

    assert.ok(dsModel.rmBulk.calledWith(['6abd08000000000000000001', '6abd08000000000000000002']));
    assert.ok(tokenModel.rmBulk.calledWith(['6abd02000000000000000001', '6abd02000000000000000002']));
    assert.strictEqual(result, true);
  });

  it('has the Socket processes close the connection of every agreement', async () => {
    stubModel();
    const nrp = { emit: sinon.spy() };
    const route = createRoute(DeleteAllDataSharingAgreement, { nrp });

    await route._exec(createReq(), {}, { dsIds: ['6abd08000000000000000001', '6abd08000000000000000002'], tokenIds: ['6abd02000000000000000001', '6abd02000000000000000002'] });

    assert.deepStrictEqual(
      nrp.emit.getCalls().map((call) => call.args),
      ['6abd08000000000000000001', '6abd08000000000000000002'].map((id) => ['dataShare:deactivated', JSON.stringify({ appDataSharingId: id })]),
    );
  });
});
