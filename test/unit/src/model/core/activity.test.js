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

import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';

// What an activity record keeps of a request's body
describe('model/core/ActivitySchemaModel: request bodies', () => {
  const model = Object.create(ActivitySchemaModel.prototype);
  const record = (body) =>
    model.__parseAddBody({
      activityTitle: 'Private Activity', activityDescription: 'ADD', activityVisibility: 'private',
      path: 'user', verb: 'post', permissions: 'add', params: {}, res: {},
      req: { body, query: {}, params: {}, context: { token: null, authUser: null, authApp: null } },
    });

  it('keeps no credential or secret from a created entity', () => {
    const stored = record({
      auth: [{ app: 'google', email: 'a@example.com', password: 'p4ss', token: 't0k', tokenSecret: 'ts3c', refreshToken: 'r3f' }],
      storeData: { apiKey: 'k3y' },
      remoteApp: { endpoint: 'https://example.com', token: 'dsa-t0k' },
      datastore: { connectionString: 'mongodb://user:pw@db' },
    });

    assert.ok(!/p4ss|t0k|ts3c|r3f|k3y|dsa-t0k|user:pw/.test(stored.body), stored.body);
    assert.ok(stored.body.includes('a@example.com'));
    assert.ok(stored.body.includes('https://example.com'));
  });

  it('keeps no value an update writes to a credential or secret', () => {
    const stored = record([
      { path: 'storeData.clientSecret', value: 's3cret' },
      { path: 'auth.0.password', value: 'p4ss' },
      { path: 'name', value: 'renamed' },
    ]);

    assert.ok(!/s3cret|p4ss/.test(stored.body), stored.body);
    assert.ok(stored.body.includes('renamed'));
  });
});
