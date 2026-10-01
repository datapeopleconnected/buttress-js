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

import { describe, it } from 'mocha';
import assert from 'assert';

import SecureStoreSchemaModel from '../../../../../dist/model/core/secure-store.js';

import { createSchemaModel } from '../../../../schema-model.js';

// What's stored for a secure store, through the real model over a datastore in memory
describe('model/core/SecureStoreSchemaModel: what a secure store is stored as', () => {
  const APP_ID = '6abd05000000000000000001';
  const ID = '6abd09000000000000000001';

  function createModel() {
    const services = new Map([
      ['nrp', { on: () => () => {}, emit: () => {} }],
      ['modelManager', {}],
    ]);
    const model = new SecureStoreSchemaModel(services);
    const { datastore } = createSchemaModel({ name: 'unused', properties: {} });
    model.adapter = datastore;
    return { model, datastore };
  }

  it('stores its name and data, with no data as an empty object', async () => {
    const { model, datastore } = createModel();

    await model.add({ id: ID, name: 'keys', storeData: { a: 1 }, other: 'dropped' }, { _appId: APP_ID });
    await model.add({ name: 'empty' }, { _appId: APP_ID });
    await model.add({ name: 'nothing', storeData: null }, { _appId: APP_ID });

    assert.deepStrictEqual(datastore.rows[0], { id: ID, name: 'keys', storeData: { a: 1 }, _appId: APP_ID });
    assert.deepStrictEqual(datastore.rows.slice(1).map((row) => row.storeData), [{}, {}]);
  });
});
