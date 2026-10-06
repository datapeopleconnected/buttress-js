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
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';

import { createSchemaModel } from '../../../../schema-model.js';

// The routes that change a lambda's or a user's token's policy properties, run on the real token model over a
// datastore in memory
const APP = '6abd05000000000000000001';
const OTHER_APP = '6abd05000000000000000002';
const LAMBDA = '6abd03000000000000000001';
const THEIR_LAMBDA = '6abd03000000000000000002';
const USER = '6abd01000000000000000001';
const THEIR_USER = '6abd01000000000000000002';
const LAMBDA_TOKEN = '6abd02000000000000000001';
const USER_TOKEN = '6abd02000000000000000002';
const BARE_USER_TOKEN = '6abd02000000000000000003';
const NOBODYS = '6abd0f000000000000000009';

const owners = () => [
  { id: LAMBDA, _appId: APP },
  { id: THEIR_LAMBDA, _appId: OTHER_APP },
  { id: USER, _appId: APP },
  { id: THEIR_USER, _appId: OTHER_APP },
];
const tokens = () => [
  { id: LAMBDA_TOKEN, _appId: APP, _lambdaId: LAMBDA, value: 'lambda-token', policyProperties: { role: 'member' } },
  { id: USER_TOKEN, _appId: APP, _userId: USER, value: 'user-token', policyProperties: { role: 'admin', department: 'sales' } },
  { id: BARE_USER_TOKEN, _appId: APP, _userId: USER, value: 'bare-token', policyProperties: null },
];

const context = () => ({
  id: 'req',
  token: { type: 'app', _appId: APP },
  authApp: { id: APP, policyPropertiesList: { role: ['admin', 'member'], department: ['sales', 'support'] } },
});

describe('routes/api: token policy properties', () => {
  const routeNamed = (name) => Routes.flat().find((RouteClass) => RouteClass.name === name);
  let tokenRows;
  let emitted;
  let services;

  beforeEach(() => {
    emitted = [];
    const nrp = { on: () => () => {}, emit: (event, data) => emitted.push([event, JSON.parse(data)]) };
    const policyCache = { setTokenIdAsStale: async () => {}, reselectToken: async () => {} };
    const lambdas = createSchemaModel(LambdaSchemaModel.Schema, owners()).model;
    const users = createSchemaModel(UserSchemaModel.Schema, owners()).model;
    const tokenModel = new TokenSchemaModel(new Map([['nrp', nrp], ['modelManager', {}], ['policyCache', policyCache]]));
    const { datastore } = createSchemaModel(TokenSchemaModel.Schema, tokens());
    tokenModel.adapter = datastore;
    tokenRows = datastore.rows;
    const models = new Map([
      [LambdaSchemaModel, lambdas],
      [UserSchemaModel, users],
      [TokenSchemaModel, tokenModel],
    ]);
    // Stubbed for each test, as other test files restore sinon after every test
    sinon.stub(Model, 'getCoreModel').callsFake((ModelClass) =>
      models.get(ModelClass) ?? { schemaData: ModelClass.Schema, Constants: ModelClass.Constants },
    );
    services = new Map([
      ['nrp', nrp],
      ['modelManager', Model],
    ]);
  });
  afterEach(() => sinon.restore());

  const run = async (name, params, body, ctx = context()) => {
    const route = new (routeNamed(name))(services);
    const req = { params, body, context: ctx };
    return route._exec(req, {}, await route._validate(req, {}));
  };
  const propertiesOf = (id) => tokenRows.find((row) => row.id === id).policyProperties;

  describe("a lambda's token", () => {
    it('sets, updates and clears its policy properties', async () => {
      assert.strictEqual(await run('SetLambdaPolicyProperties', { id: LAMBDA }, { department: 'sales' }), true);
      assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), { department: 'sales' });

      assert.strictEqual(await run('UpdateLambdaPolicyProperties', { id: LAMBDA }, { role: 'admin' }), true);
      assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), { department: 'sales', role: 'admin' });

      assert.strictEqual(await run('ClearLambdaPolicyProperties', { id: LAMBDA }, {}), true);
      assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), {});
    });

    it("refuses another app's lambda, and properties the app doesn't list", async () => {
      for (const name of ['SetLambdaPolicyProperties', 'UpdateLambdaPolicyProperties', 'ClearLambdaPolicyProperties']) {
        await assert.rejects(run(name, { id: THEIR_LAMBDA }, { role: 'admin' }), { status: 404, code: 'not_found' }, name);
      }
      for (const name of ['SetLambdaPolicyProperties', 'UpdateLambdaPolicyProperties']) {
        await assert.rejects(run(name, { id: LAMBDA }, { role: 'owner' }), { status: 400, code: 'invalid_field' }, name);
      }
      assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), { role: 'member' });
    });
  });

  // SR-DPC-001 D6: an update was collected onto an array, which swallowed `length: 5`, threw a RangeError (a 500) for
  // `length: 'a'`, and dropped `__proto__`
  describe('property names an object has of its own', () => {
    const listing = () => {
      const ctx = context();
      ctx.authApp.policyPropertiesList = JSON.parse('{"role": ["admin", "member"], "length": [5, "a"], "__proto__": ["admin"]}');
      return ctx;
    };

    it('updates each under its name as given', async () => {
      const update = (body) => run('UpdateLambdaPolicyProperties', { id: LAMBDA }, JSON.parse(body), listing());

      assert.strictEqual(await update('{"length": 5}'), true);
      assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), { role: 'member', length: 5 });

      assert.strictEqual(await update('{"length": "a"}'), true);
      assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), { role: 'member', length: 'a' });

      assert.strictEqual(await update('{"__proto__": "admin"}'), true);
      const stored = propertiesOf(LAMBDA_TOKEN);
      assert.deepStrictEqual(Object.entries(stored), [['role', 'member'], ['length', 'a'], ['__proto__', 'admin']]);
      assert.strictEqual(Object.getPrototypeOf(stored), Object.prototype);
    });

    it('refuses a value the app does not list for one with a 400', async () => {
      await assert.rejects(run('UpdateLambdaPolicyProperties', { id: LAMBDA }, { length: -1 }, listing()), {
        status: 400,
        code: 'invalid_field',
      });
      assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), { role: 'member' });
    });
  });

  it('refuses properties given as a list with a 400', async () => {
    for (const name of ['SetLambdaPolicyProperties', 'UpdateLambdaPolicyProperties']) {
      await assert.rejects(run(name, { id: LAMBDA }, ['admin']), { status: 400, code: 'invalid_body' }, name);
    }
    await assert.rejects(run('RemoveUserPolicyProperties', { id: USER, tokenId: USER_TOKEN }, ['admin']), {
      status: 400,
      code: 'invalid_body',
    });
    assert.deepStrictEqual(propertiesOf(LAMBDA_TOKEN), { role: 'member' });
  });

  describe("a user's token", () => {
    it('sets and updates its policy properties, by the token id or its value', async () => {
      assert.strictEqual(await run('SetUserPolicyProperties', { id: USER, tokenId: USER_TOKEN }, { role: 'member' }), true);
      assert.deepStrictEqual(propertiesOf(USER_TOKEN), { role: 'member' });

      assert.strictEqual(await run('UpdateUserPolicyProperties', { id: USER, tokenId: 'user-token' }, { department: 'support' }), true);
      assert.deepStrictEqual(propertiesOf(USER_TOKEN), { role: 'member', department: 'support' });
    });

    it('removes the properties whose value matches, and clears them, telling sockets to look at the user again', async () => {
      assert.strictEqual(await run('RemoveUserPolicyProperties', { id: USER, tokenId: USER_TOKEN }, { role: 'admin', department: 'support' }), true);
      assert.deepStrictEqual(propertiesOf(USER_TOKEN), { department: 'sales' });

      assert.strictEqual(await run('ClearUserPolicyProperties', { id: USER, tokenId: USER_TOKEN }, {}), true);
      assert.deepStrictEqual(propertiesOf(USER_TOKEN), {});

      assert.deepStrictEqual(emitted.filter(([event]) => event === 'worker:socket:evaluateUserRooms'), [
        ['worker:socket:evaluateUserRooms', { userId: USER, appId: APP }],
        ['worker:socket:evaluateUserRooms', { userId: USER, appId: APP }],
      ]);
    });

    it('removes properties from a token that has none', async () => {
      assert.strictEqual(await run('RemoveUserPolicyProperties', { id: USER, tokenId: BARE_USER_TOKEN }, { role: 'admin' }), true);
      assert.deepStrictEqual(propertiesOf(BARE_USER_TOKEN), {});
    });

    it("refuses another app's user, a token the user hasn't got, and properties the app doesn't list", async () => {
      const all = ['SetUserPolicyProperties', 'UpdateUserPolicyProperties', 'RemoveUserPolicyProperties', 'ClearUserPolicyProperties'];
      for (const name of all) {
        await assert.rejects(run(name, { id: THEIR_USER, tokenId: USER_TOKEN }, { role: 'admin' }), { status: 404, code: 'not_found' }, name);
        await assert.rejects(run(name, { id: USER, tokenId: NOBODYS }, { role: 'admin' }), { status: 404, code: 'not_found', details: { schema: 'token' } }, name);
      }
      for (const name of all.slice(0, 2)) {
        await assert.rejects(run(name, { id: USER, tokenId: USER_TOKEN }, { role: 'owner' }), { status: 400, code: 'invalid_field' }, name);
      }
      assert.deepStrictEqual(propertiesOf(USER_TOKEN), { role: 'admin', department: 'sales' });
    });
  });
});
