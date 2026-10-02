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
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';
import AppDataSharingSchemaModel from '../../../../../dist/model/core/app-data-sharing.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';
import PolicySchemaModel from '../../../../../dist/model/core/policy.js';
import SecureStoreSchemaModel from '../../../../../dist/model/core/secure-store.js';
import TrackingSchemaModel from '../../../../../dist/model/core/tracking.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';

import { createSchemaModel } from '../../../../schema-model.js';

// Every core get-one, get-list and delete-all route on the shared bases, run on its real model over a datastore in
// memory
const APP = '6abd05000000000000000001';
const OTHER_APP = '6abd05000000000000000002';
const SYSTEM_APP = '6abd05000000000000000003';
const MINE = '6abd0a000000000000000001';
const MINE_TOO = '6abd0a000000000000000002';
const THEIRS = '6abd0a000000000000000003';
const SYSTEMS = '6abd0a000000000000000004';
const NOBODYS = '6abd0a000000000000000009';

const MODELS = [
  ActivitySchemaModel,
  AppDataSharingSchemaModel,
  LambdaSchemaModel,
  LambdaExecutionSchemaModel,
  PolicySchemaModel,
  SecureStoreSchemaModel,
  TrackingSchemaModel,
  UserSchemaModel,
];

const rows = () => [
  { id: MINE, _appId: APP, body: { mine: 1 } },
  { id: MINE_TOO, _appId: APP, body: {} },
  { id: THEIRS, _appId: OTHER_APP, body: {} },
  { id: SYSTEMS, _appId: SYSTEM_APP, body: {} },
];

const context = (system) =>
  system
    ? { id: 'req', token: { type: 'system', _appId: SYSTEM_APP }, authApp: { id: SYSTEM_APP } }
    : { id: 'req', token: { type: 'app', _appId: APP }, authApp: { id: APP } };
const request = ({ id, ids, system = false } = {}) => ({
  params: id === undefined ? {} : { id },
  query: ids === undefined ? {} : { ids },
  body: undefined,
  context: context(system),
});

describe('routes/api: core reads and deletes', () => {
  const datastores = new Map();
  const routeNamed = (name) => Routes.flat().find((RouteClass) => RouteClass.name === name);
  let services;

  beforeEach(() => {
    for (const ModelClass of MODELS) {
      const created = createSchemaModel(ModelClass.Schema, rows());
      // As the core model has them, which routes read
      created.model.Constants = ModelClass.Constants;
      datastores.set(ModelClass, created);
    }
    // Stubbed for each test, as other test files restore sinon after every test
    sinon.stub(Model, 'getCoreModel').callsFake((ModelClass) =>
      datastores.get(ModelClass)?.model ?? { schemaData: ModelClass.Schema, Constants: ModelClass.Constants },
    );
    services = new Map([
      ['nrp', { on: () => {}, emit: () => {} }],
      ['modelManager', Model],
    ]);
  });
  afterEach(() => sinon.restore());

  const run = async (name, req) => {
    const route = new (routeNamed(name))(services);
    return route._exec(req, {}, await route._validate(req, {}));
  };
  const ids = async (result) => (await Helpers.streamAll(result)).map((row) => row.id);
  const idsLeft = (ModelClass) => datastores.get(ModelClass).datastore.rows.map((row) => row.id);

  const GET_ONE = [
    ['GetPolicy', PolicySchemaModel],
    ['GetLambda', LambdaSchemaModel],
    ['GetAppDataSharing', AppDataSharingSchemaModel],
    ['GetLambdaExecution', LambdaExecutionSchemaModel],
    ['GetSecureStore', SecureStoreSchemaModel],
  ];
  for (const [name, ModelClass] of GET_ONE) {
    describe(name, () => {
      it("gives the app's row, and refuses another app's, an id nothing has and one that can't be an id", async () => {
        assert.strictEqual((await run(name, request({ id: MINE }))).id, MINE);

        const notFound = { status: 404, code: 'not_found', details: { schema: ModelClass.Schema.name, id: THEIRS } };
        await assert.rejects(run(name, request({ id: THEIRS })), notFound);
        await assert.rejects(run(name, request({ id: NOBODYS })), { status: 404, code: 'not_found' });
        await assert.rejects(run(name, request({ id: 'nope' })), { status: 400, code: 'invalid_id' });
      });

      if (ModelClass === SecureStoreSchemaModel) {
        it("keeps a system token to its own app's secure stores", async () => {
          await assert.rejects(run(name, request({ id: MINE, system: true })), { status: 404, code: 'not_found' });
          assert.strictEqual((await run(name, request({ id: SYSTEMS, system: true }))).id, SYSTEMS);
        });
      } else {
        it("gives any app's row to a system token", async () => {
          assert.strictEqual((await run(name, request({ id: THEIRS, system: true }))).id, THEIRS);
        });
      }
    });
  }

  it("gives an activity's body", async () => {
    assert.deepStrictEqual(await run('GetActivity', request({ id: MINE, system: true })), { mine: 1 });
  });

  const GET_LIST = [
    ['GetPolicyList', true],
    ['GetLambdaList', true],
    ['GetAllAppDataSharing', false],
    ['GetUserList', false],
  ];
  for (const [name, takesIds] of GET_LIST) {
    describe(name, () => {
      it("lists the app's rows, and every app's for a system token", async () => {
        assert.deepStrictEqual(await ids(await run(name, request())), [MINE, MINE_TOO]);
        assert.deepStrictEqual(await ids(await run(name, request({ system: true }))), [MINE, MINE_TOO, THEIRS, SYSTEMS]);
      });

      if (!takesIds) return;
      it("lists only the app's rows with the ids it's given, refusing one that can't be an id", async () => {
        assert.deepStrictEqual(await ids(await run(name, request({ ids: `${MINE},${THEIRS}` }))), [MINE]);
        assert.deepStrictEqual(await ids(await run(name, request({ ids: [MINE_TOO] }))), [MINE_TOO]);
        await assert.rejects(run(name, request({ ids: `${MINE},nope` })), { status: 400, code: 'invalid_id' });
      });
    });
  }

  it('lists every tracking entry for a system token', async () => {
    assert.strictEqual((await ids(await run('GetTrackingList', request({ system: true })))).length, 4);
  });

  it('deletes every activity and tracking entry for a system token', async () => {
    assert.strictEqual(await run('DeleteAllActivity', request({ system: true })), true);
    assert.strictEqual(await run('DeleteAllTrackings', request({ system: true })), true);

    assert.deepStrictEqual(idsLeft(ActivitySchemaModel), []);
    assert.deepStrictEqual(idsLeft(TrackingSchemaModel), []);
  });

  it("deletes only the caller's app's users, a system token's included", async () => {
    assert.strictEqual(await run('DeleteAllUsers', request()), true);
    assert.deepStrictEqual(idsLeft(UserSchemaModel), [THEIRS, SYSTEMS]);

    assert.strictEqual(await run('DeleteAllUsers', request({ system: true })), true);
    assert.deepStrictEqual(idsLeft(UserSchemaModel), [THEIRS]);
  });
});
