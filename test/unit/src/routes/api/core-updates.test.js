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
import AppDataSharingSchemaModel from '../../../../../dist/model/core/app-data-sharing.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';
import PolicySchemaModel from '../../../../../dist/model/core/policy.js';
import SecureStoreSchemaModel from '../../../../../dist/model/core/secure-store.js';
import TrackingSchemaModel from '../../../../../dist/model/core/tracking.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';

import { createSchemaModel } from '../../../../schema-model.js';

// Every core update-by-path and bulk update route, run on its real model over a datastore in memory
const APP = '6abd05000000000000000001';
const OTHER_APP = '6abd05000000000000000002';
const SYSTEM_APP = '6abd05000000000000000003';
const MINE = '6abd0a000000000000000001';
const MINE_TOO = '6abd0a000000000000000002';
const THEIRS = '6abd0a000000000000000003';
const NOBODYS = '6abd0a000000000000000009';

// Each route, its model, the id param it takes, and an update it allows
const COLLECTIONS = [
  ['UpdatePolicy', 'BulkUpdatePolicy', PolicySchemaModel, 'id', { path: 'name', value: 'renamed' }],
  ['UpdateLambda', 'BulkUpdateLambda', LambdaSchemaModel, 'id', { path: 'name', value: 'renamed' }],
  ['UpdateUser', null, UserSchemaModel, 'id', { path: 'auth', value: [{ app: 'local', username: 'renamed' }] }],
  ['UpdateSecureStore', 'BulkUpdateSecureStore', SecureStoreSchemaModel, 'id', { path: 'name', value: 'renamed' }],
  ['UpdateAppDataSharing', 'BulkUpdateAppDataSharing', AppDataSharingSchemaModel, 'dataSharingId', { path: 'name', value: 'renamed' }],
  ['UpdateLambdaExecution', null, LambdaExecutionSchemaModel, 'id', { path: 'nextCronExpression', value: 'renamed' }],
];

const rows = () => [
  { id: MINE, _appId: APP, name: 'a', trigger: [] },
  { id: MINE_TOO, _appId: APP, name: 'b', trigger: [] },
  { id: THEIRS, _appId: OTHER_APP, name: 'c', trigger: [] },
];

const context = (system) =>
  system
    ? { id: 'req', token: { type: 'system', _appId: SYSTEM_APP }, authApp: { id: SYSTEM_APP } }
    : { id: 'req', token: { type: 'app', _appId: APP }, authApp: { id: APP } };

describe('routes/api: core updates', () => {
  const datastores = new Map();
  const routeNamed = (name) => Routes.flat().find((RouteClass) => RouteClass.name === name);
  let services;

  beforeEach(() => {
    for (const ModelClass of [...COLLECTIONS.map(([, , M]) => M), TrackingSchemaModel]) {
      datastores.set(ModelClass, createSchemaModel(ModelClass.Schema, rows()));
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
  const valueOf = (ModelClass, id, path) => datastores.get(ModelClass).datastore.rows.find((row) => row.id === id)[path];

  for (const [single, bulk, ModelClass, param, update] of COLLECTIONS) {
    describe(single, () => {
      const put = (id, body = [update], system = false) => ({ params: { [param]: id }, body, context: context(system) });

      it("updates the app's row by path", async () => {
        await run(single, put(MINE));

        assert.deepStrictEqual(valueOf(ModelClass, MINE, update.path), update.value);
      });

      it("refuses another app's row, an id nothing has, and an id that can't be one, writing nothing", async () => {
        await assert.rejects(run(single, put(THEIRS)), { status: 404, code: 'not_found' });
        await assert.rejects(run(single, put(NOBODYS)), { status: 404, code: 'not_found' });
        await assert.rejects(run(single, put('nope')), { status: 400, code: 'invalid_id' });
        assert.notDeepStrictEqual(valueOf(ModelClass, THEIRS, update.path), update.value);
      });

      it('refuses an update to a path the schema has not got', async () => {
        await assert.rejects(run(single, put(MINE, [{ path: 'nothing', value: 1 }])), { status: 400, code: 'invalid_update' });
      });

      if (ModelClass === SecureStoreSchemaModel) {
        it("keeps a system token to its own app's rows", async () => {
          await assert.rejects(run(single, put(MINE, [update], true)), { status: 404, code: 'not_found' });
        });
      } else {
        it("updates any app's row for a system token", async () => {
          await run(single, put(THEIRS, [update], true));

          assert.deepStrictEqual(valueOf(ModelClass, THEIRS, update.path), update.value);
        });
      }
    });

    if (!bulk) continue;
    describe(bulk, () => {
      const post = (body) => ({ params: {}, body, context: context(false) });

      it("updates each of the app's rows", async () => {
        assert.strictEqual(await run(bulk, post([{ id: MINE, body: [update] }, { id: MINE_TOO, body: update }])), true);

        assert.deepStrictEqual(valueOf(ModelClass, MINE, update.path), update.value);
        assert.deepStrictEqual(valueOf(ModelClass, MINE_TOO, update.path), update.value);
      });

      it("refuses the batch, writing none of it, when an item names another app's row or an update it can't take", async () => {
        await assert.rejects(run(bulk, post([{ id: MINE, body: [update] }, { id: THEIRS, body: [update] }])), {
          status: 404,
          code: 'not_found',
        });
        await assert.rejects(run(bulk, post([{ id: MINE, body: [update] }, { id: MINE_TOO, body: [{ path: 'nothing', value: 1 }] }])), {
          status: 400,
          code: 'invalid_update',
        });
        assert.notDeepStrictEqual(valueOf(ModelClass, MINE, update.path), update.value);
      });

      it('refuses a body that is not a list of updates', async () => {
        for (const body of [{ id: MINE }, [null], 'x']) {
          await assert.rejects(run(bulk, post(body)), { status: 400, code: 'array_required' });
        }
      });
    });
  }

  it('updates a tracking entry for a system token', async () => {
    await run('UpdateTracking', { params: { id: THEIRS }, body: [{ path: 'name', value: 'renamed' }], context: context(true) });

    assert.strictEqual(valueOf(TrackingSchemaModel, THEIRS, 'name'), 'renamed');
  });
});
