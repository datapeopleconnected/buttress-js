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

import AppDataSharingSchemaModel from '../../../../../dist/model/core/app-data-sharing.js';
import StandardModel from '../../../../../dist/model/type/standard.js';

const HEX_ID = '507f1f77bcf86cd799439011';

// The Socket processes act on an agreement's activation by reading it back, so they're told once it's saved
describe('model/core/AppDataSharingSchemaModel: activation', () => {
  afterEach(() => sinon.restore());

  function createModel() {
    const happened = [];
    const nrp = { on: () => {}, emit: (channel, message) => happened.push(['emit', channel, JSON.parse(message)]) };
    sinon.stub(StandardModel.prototype, 'updateById').callsFake(async (_id, update) => {
      await new Promise((resolve) => setImmediate(resolve));
      happened.push(['update', update.$set]);
    });
    const model = new AppDataSharingSchemaModel(new Map([['nrp', nrp], ['modelManager', {}]]));
    model.adapter = { ID: { isValid: () => true, new: (v) => v } };
    return { model, happened };
  }

  it('says an agreement was activated once its new token is saved', async () => {
    const { model, happened } = createModel();

    await model.activate(HEX_ID, 'new-token');

    assert.deepStrictEqual(happened, [
      ['update', { active: true, 'remoteApp.token': 'new-token' }],
      ['emit', 'dataShare:activated', { appDataSharingId: HEX_ID }],
    ]);
  });

  it('says an agreement was deactivated once that is saved', async () => {
    const { model, happened } = createModel();

    await model.deactivate(HEX_ID);

    assert.deepStrictEqual(happened, [
      ['update', { active: false }],
      ['emit', 'dataShare:deactivated', { appDataSharingId: HEX_ID }],
    ]);
  });
});
