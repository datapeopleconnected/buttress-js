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

import UserSchemaModel from '../../../../../dist/model/core/user.js';

import { createSchemaModel } from '../../../../schema-model.js';

// What's stored for a user, through the real model over a datastore in memory
describe('model/core/UserSchemaModel: what a user is stored as', () => {
  const APP_ID = '6abd05000000000000000001';

  function createModel() {
    const services = new Map([
      ['nrp', { on: () => () => {}, emit: () => {} }],
      ['modelManager', { getCoreModel: () => assert.fail('no token was asked for') }],
    ]);
    const model = new UserSchemaModel(services);
    const { datastore } = createSchemaModel({ name: 'unused', properties: {} });
    model.adapter = datastore;
    return { model, datastore };
  }

  it("stores each auth entry's own fields, its images from the image urls, and defaults for the rest", async () => {
    const { model, datastore } = createModel();

    const user = await model.add(
      {
        auth: [
          {
            app: 'google',
            appId: 'ext-1',
            username: 'ada',
            password: 'pw',
            email: 'ada@example.com',
            profileImgUrl: 'https://img/p',
            bannerImgUrl: 'https://img/b',
            other: 'dropped',
          },
          { app: 'local', username: 'ada' },
        ],
      },
      { _appId: APP_ID },
    );

    const defaults = { profileUrl: '', locale: '', token: '', tokenSecret: '', refreshToken: '', extras: '' };
    // The datastore gives back the row it keeps, which add gives the user's tokens
    assert.deepStrictEqual(datastore.rows.map(({ tokens: _tokens, ...row }) => row), [
      {
        id: user.id,
        auth: [
          {
            ...defaults,
            app: 'google',
            appId: 'ext-1',
            username: 'ada',
            password: 'pw',
            email: 'ada@example.com',
            images: { profile: 'https://img/p', banner: 'https://img/b' },
          },
          { ...defaults, app: 'local', appId: null, username: 'ada', password: '', email: '', images: { profile: '', banner: '' } },
        ],
        _appId: APP_ID,
      },
    ]);
    assert.deepStrictEqual(user.tokens, []);
  });

  it('stores the locale and extras an auth entry gives', async () => {
    const { model, datastore } = createModel();

    await model.add({ auth: [{ app: 'google', locale: 'en-GB', extras: '{"a":1}' }] }, { _appId: APP_ID });

    assert.strictEqual(datastore.rows[0].auth[0].locale, 'en-GB');
    assert.strictEqual(datastore.rows[0].auth[0].extras, '{"a":1}');
  });
});
