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

import PolicySchemaModel from '../../../../../dist/model/core/policy.js';
import StandardModel from '../../../../../dist/model/type/standard.js';

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
