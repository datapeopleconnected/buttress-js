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

import { describe, it, afterEach, beforeEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';

import Model from '../../../../../dist/model/index.js';
import { Routes } from '../../../../../dist/routes/api/index.js';
import * as Helpers from '../../../../../dist/helpers/index.js';
import AppDataSharingSchemaModel from '../../../../../dist/model/core/app-data-sharing.js';
import DeploymentSchemaModel from '../../../../../dist/model/core/deployment.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';
import PolicySchemaModel from '../../../../../dist/model/core/policy.js';
import SecureStoreSchemaModel from '../../../../../dist/model/core/secure-store.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';

import { createSchemaModel } from '../../../../schema-model.js';

// Every core search and count route, run on its real model over a datastore in memory, so the query each builds is
// the one the datastore answers
const APP = '6abd05000000000000000001';
const OTHER_APP = '6abd05000000000000000002';
const SYSTEM_APP = '6abd05000000000000000003';
const id = (n) => `6abd0a00000000000000000${n}`;

const COLLECTIONS = [
  ['SearchPolicyList', 'PolicyCount', PolicySchemaModel],
  ['SearchLambdaList', 'LambdaCount', LambdaSchemaModel],
  ['SearchDeploymentList', 'DeploymentCount', DeploymentSchemaModel],
  ['SearchExecutionList', 'LambdaExecutionCount', LambdaExecutionSchemaModel],
  ['SearchAppDataSharingAgreement', 'AppDataSharingAgreementCount', AppDataSharingSchemaModel],
  ['SearchSecureStoreList', 'SecureStoreCount', SecureStoreSchemaModel],
  ['SearchUserList', 'UserCount', UserSchemaModel],
];

// Three of the app's rows, one of another app's and one of the system app's, each with a field to project away
const rows = () => [
  { id: id(1), _appId: APP, note: 'n' },
  { id: id(2), _appId: APP, note: 'n' },
  { id: id(3), _appId: APP, note: 'n' },
  { id: id(4), _appId: OTHER_APP, note: 'n' },
  { id: id(5), _appId: SYSTEM_APP, note: 'n' },
];

const appReq = (body) => ({ body, context: { id: 'req', token: { type: 'app', _appId: APP }, authApp: { id: APP } } });
const systemReq = (body) => ({ body, context: { id: 'req', token: { type: 'system', _appId: SYSTEM_APP }, authApp: { id: SYSTEM_APP } } });

describe('routes/api: core searches and counts', () => {
  const models = new Map();
  const routeNamed = (name) => Routes.flat().find((RouteClass) => RouteClass.name === name);
  let services;

  // Stubbed for each test, as other test files restore sinon after every test
  beforeEach(() => {
    for (const [, , ModelClass] of COLLECTIONS) models.set(ModelClass, createSchemaModel(ModelClass.Schema, rows()).model);
    sinon.stub(Model, 'getCoreModel').callsFake((ModelClass) =>
      models.get(ModelClass) ?? { schemaData: ModelClass.Schema, Constants: ModelClass.Constants },
    );
    services = new Map([
      ['nrp', { on: () => {}, emit: () => {} }],
      ['modelManager', Model],
    ]);
  });
  afterEach(() => sinon.restore());

  const search = async (name, req) => {
    const route = new (routeNamed(name))(services);
    return Helpers.streamAll(await route._exec(req, {}, await route._validate(req, {})));
  };
  const count = async (name, req) => {
    const route = new (routeNamed(name))(services);
    return route._exec(req, {}, await route._validate(req, {}));
  };

  for (const [searchName, countName] of COLLECTIONS) {
    describe(`${searchName} and ${countName}`, () => {
      it("finds the app's rows, paged and sorted as asked", async () => {
        const found = await search(searchName, appReq({ query: {}, sort: { id: -1 }, skip: 1, limit: 1 }));

        assert.deepStrictEqual(found.map((row) => row.id), [id(2)]);
      });

      it('gives the properties a projection asks for', async () => {
        const found = await search(searchName, appReq({ query: { id: { $eq: id(1) } }, project: { _appId: 1 } }));

        assert.deepStrictEqual(found, [{ id: id(1), _appId: APP }]);
      });

      it('refuses a list as the body, and a skip or limit that is not a number', async () => {
        await assert.rejects(search(searchName, appReq([{ query: {} }])), { status: 400, code: 'invalid_body' });
        await assert.rejects(search(searchName, appReq({ skip: 'many' })), { status: 400, code: 'invalid_value_skip' });
        await assert.rejects(search(searchName, appReq({ limit: 'many' })), { status: 400, code: 'invalid_value_limit' });
      });

      it('refuses a negative skip or limit', async () => {
        await assert.rejects(search(searchName, appReq({ skip: -1 })), { status: 400, code: 'invalid_value_skip' });
        await assert.rejects(search(searchName, appReq({ limit: '-1' })), { status: 400, code: 'invalid_value_limit' });
      });

      it("counts the app's rows its query matches, a body without a query being the query", async () => {
        assert.strictEqual(await count(countName, appReq({ query: { id: { $ne: id(1) } } })), 2);
        assert.strictEqual(await count(countName, appReq({ id: { $ne: id(1) } })), 2);
        assert.strictEqual(await count(countName, appReq({ actualCount: true })), 3);
        assert.strictEqual(await count(countName, appReq(undefined)), 3);
      });
    });
  }

  it("finds and counts every app's rows for a system token", async () => {
    for (const [searchName, countName] of COLLECTIONS.filter(([name]) => name !== 'SearchSecureStoreList')) {
      assert.strictEqual((await search(searchName, systemReq({}))).length, 5, searchName);
      assert.strictEqual(await count(countName, systemReq({})), 5, countName);
    }
  });

  it("keeps a system token to its own app's secure stores", async () => {
    assert.deepStrictEqual((await search('SearchSecureStoreList', systemReq({}))).map((row) => row.id), [id(5)]);
    assert.strictEqual(await count('SecureStoreCount', systemReq({})), 1);
  });
});
