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
import { Readable } from 'node:stream';

import PolicySchemaModel from '../../../../../dist/model/core/policy.js';
import StandardModel from '../../../../../dist/model/type/standard.js';

import { createSchemaModel } from '../../../../schema-model.js';

const HEX_ID = '507f1f77bcf86cd799439011';

// The policy cache is brought up to date before a policy change resolves
describe('model/core/PolicySchemaModel: policy cache', () => {
  afterEach(() => sinon.restore());

  function createModel() {
    const invalidated = [];
    const policyCache = {
      invalidatePolicyAndTokensBySelection: (id) =>
        new Promise((resolve) => setTimeout(() => {
          invalidated.push(id);
          resolve();
        }, 5)),
      removePolicy: sinon.stub().resolves([]),
    };
    const services = new Map([
      ['nrp', { on: () => {}, emit: () => {} }],
      ['modelManager', {}],
      ['policyCache', policyCache],
    ]);
    const model = new PolicySchemaModel(services);
    model.adapter = { ID: { isValid: () => true, new: (v) => v } };
    return { model, invalidated };
  }

  it('refreshes the cached policy before an update by path resolves', async () => {
    sinon.stub(StandardModel.prototype, 'updateByPath').resolves([]);
    const { model, invalidated } = createModel();

    await model.updateByPath([{ path: 'name', value: 'renamed' }], HEX_ID);

    assert.deepStrictEqual(invalidated, [HEX_ID]);
  });

  it('refreshes the cached policy, by the id it was given, before an update by id resolves', async () => {
    sinon.stub(StandardModel.prototype, 'updateById').resolves({ acknowledged: true, modifiedCount: 1 });
    const { model, invalidated } = createModel();

    await model.updateById(HEX_ID, { $set: { name: 'renamed' } });

    assert.deepStrictEqual(invalidated, [HEX_ID]);
  });
});

describe('model/core/PolicySchemaModel: adding a policy', () => {
  afterEach(() => sinon.restore());

  it('stores the version it is given', async () => {
    const services = new Map([
      ['nrp', { on: () => {}, emit: () => {} }],
      ['modelManager', {}],
      ['policyCache', { invalidatePolicyAndTokensBySelection: async () => {} }],
    ]);
    const model = new PolicySchemaModel(services);
    model.adapter = { ID: { isValid: () => true, new: (v) => v ?? HEX_ID } };
    const add = sinon.stub(StandardModel.prototype, 'add').callsFake(async (body) => Readable.from([{ ...body, id: HEX_ID }]));

    await model.add({ name: 'readers', selection: {}, config: [], version: '1.2.3' }, 'app-1');

    assert.strictEqual(add.firstCall.args[0].version, '1.2.3');
  });
});

// What's stored for a policy, through the real model over a datastore in memory
describe('model/core/PolicySchemaModel: what a policy is stored as', () => {
  const APP_ID = '6abd05000000000000000001';

  function createModel() {
    const services = new Map([
      ['nrp', { on: () => {}, emit: () => {} }],
      ['modelManager', {}],
      ['policyCache', { invalidatePolicyAndTokensBySelection: async () => {} }],
    ]);
    const model = new PolicySchemaModel(services);
    const { datastore } = createSchemaModel({ name: 'unused', properties: {} });
    model.adapter = datastore;
    return { model, datastore };
  }

  it("stores the policy's own properties, read as their types, with defaults for the rest", async () => {
    const { model, datastore } = createModel();

    const policy = await model.add(
      {
        id: HEX_ID,
        name: 'readers',
        selection: { role: { '@eq': 'APP' } },
        priority: '3',
        config: [{ verbs: ['GET'], schema: ['note'], query: { access: '%FULL_ACCESS%' }, extra: 1 }],
        other: 'dropped',
      },
      { _appId: APP_ID },
    );

    const stored = {
      id: HEX_ID,
      name: 'readers',
      version: null,
      priority: 3,
      selection: { role: { '@eq': 'APP' } },
      env: {},
      config: [
        {
          verbs: ['GET'],
          endpoints: [],
          schema: ['note'],
          env: null,
          condition: null,
          projection: null,
          query: { access: '%FULL_ACCESS%' },
        },
      ],
      limit: null,
      _appId: APP_ID,
    };
    assert.deepStrictEqual(datastore.rows, [stored]);
    assert.deepStrictEqual(policy, stored);
  });

  it('stores the version, env and limit it is given', async () => {
    const { model, datastore } = createModel();

    await model.add(
      { name: 'readers', selection: {}, config: [], version: '1.2.3', env: { a: 1 }, limit: '2030-01-01T00:00:00.000Z' },
      { _appId: APP_ID },
    );

    assert.strictEqual(datastore.rows[0].version, '1.2.3');
    assert.deepStrictEqual(datastore.rows[0].env, { a: 1 });
    assert.deepStrictEqual(datastore.rows[0].limit, new Date('2030-01-01T00:00:00.000Z'));
  });
});
