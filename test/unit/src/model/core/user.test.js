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
import * as Helpers from '../../../../../dist/helpers/index.js';

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
        // Only the google entry has an id and an email to claim
        _authKeys: [JSON.stringify([APP_ID, 'google', 'appId', 'ext-1']), JSON.stringify([APP_ID, 'google', 'email', 'ada@example.com'])],
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

// What a user's auth entries claim within their app, which the datastore lets only one of the app's users have
describe('model/core/UserSchemaModel: auth keys', () => {
  const APP_ID = '6abd05000000000000000001';
  const key = (app, field, value, appId = APP_ID) => JSON.stringify([appId, app, field, value]);

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

  // As the MongoDB adapter refuses a write that repeats a unique value
  const duplicate = (path) => Helpers.Errors.badRequest('duplicate', `Another entity has the same ${path}`, { path });

  it("claims each entry's app with its id, and with its email, within the user's app", () => {
    assert.deepStrictEqual(
      UserSchemaModel.authKeys(APP_ID, [
        { app: 'google', appId: 'g-1', email: 'ada@example.com' },
        { app: 'github', appId: 'gh-1', email: '' },
        { app: 'local', appId: null, email: 'ada@example.com' },
      ]),
      [
        key('google', 'appId', 'g-1'),
        key('google', 'email', 'ada@example.com'),
        key('github', 'appId', 'gh-1'),
        key('local', 'email', 'ada@example.com'),
      ],
    );
    assert.notDeepStrictEqual(
      UserSchemaModel.authKeys('6abd05000000000000000002', [{ app: 'google', appId: 'g-1' }]),
      UserSchemaModel.authKeys(APP_ID, [{ app: 'google', appId: 'g-1' }]),
    );
  });

  it('claims nothing for an entry without an id or email, nor for an entry that is not one', () => {
    assert.deepStrictEqual(UserSchemaModel.authKeys(APP_ID, [{ app: 'local', appId: null, email: '' }, { app: 'local' }, null, 'x']), []);
    assert.deepStrictEqual(UserSchemaModel.authKeys(APP_ID, undefined), []);
  });

  it("keeps a user's keys apart however their values read, as JSON", () => {
    // Joined with colons, both would claim `<app id>:google:appId:appId:x`
    assert.notDeepStrictEqual(
      UserSchemaModel.authKeys(APP_ID, [{ app: 'google:appId', appId: 'x' }]),
      UserSchemaModel.authKeys(APP_ID, [{ app: 'google', appId: 'appId:x' }]),
    );
  });

  it('works the keys out again from auth and the app, the fields an update to them reworks them from', () => {
    const { model } = createModel();

    assert.deepStrictEqual(model.derivedFrom, ['auth', '_appId']);
    assert.deepStrictEqual(model.deriveFields({ _appId: APP_ID, auth: [{ app: 'google', appId: 'g-1' }] }), {
      _authKeys: [key('google', 'appId', 'g-1')],
    });
  });

  it('never gives the keys back, and a client can not write them', () => {
    const { _authKeys } = UserSchemaModel.Schema.properties;
    assert.deepStrictEqual(_authKeys, { __type: 'array', __itemtype: 'string', __allowUpdate: false, __private: true, __unique: true });
  });

  it('stores what a client posts as keys as the keys of its auth entries instead', async () => {
    const { model, datastore } = createModel();

    await model.add({ auth: [{ app: 'google', appId: 'g-1' }], _authKeys: ['taken'] }, { _appId: APP_ID });

    assert.deepStrictEqual(datastore.rows[0]._authKeys, [key('google', 'appId', 'g-1')]);
  });

  it('refuses a user whose keys another of the app has stored since the route looked, as AddUser does', async () => {
    const { model, datastore } = createModel();
    datastore.add = async () => {
      throw duplicate('_authKeys');
    };

    await assert.rejects(() => model.add({ auth: [{ app: 'google', appId: 'g-1' }] }, { _appId: APP_ID }), {
      status: 400,
      code: 'user_already_exists_with_that_name',
    });
  });

  it('refuses an update that gives the user auth another of the app has, as AddUser does', async () => {
    const { model, datastore } = createModel();
    datastore.updateByPaths = async () => {
      throw duplicate('_authKeys');
    };

    await assert.rejects(() => model.updateByPath({ path: 'auth.0.appId', value: 'g-2' }, APP_ID), {
      status: 400,
      code: 'user_already_exists_with_that_name',
    });
  });

  it('passes any other failure on as it is', async () => {
    const { model, datastore } = createModel();
    datastore.add = async () => {
      throw duplicate('id');
    };
    datastore.updateByPaths = async () => {
      throw new Error('gone');
    };

    await assert.rejects(() => model.add({ auth: [{ app: 'google' }] }, { _appId: APP_ID }), { code: 'duplicate' });
    await assert.rejects(() => model.updateByPath({ path: 'auth.0.appId', value: 'g-2' }, APP_ID), { message: 'gone' });
  });
});
