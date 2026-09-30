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

import { describe, it, before, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';

import AdminRoutes from '../../../../dist/routes/admin-routes.js';
import Model from '../../../../dist/model/index.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';

describe('routes/admin-routes:token lookups', () => {
  const handlers = {};

  // The token queries the routes ran. No token is ever found.
  let lookups;

  before(async () => {
    const register = (path, handler) => (handlers[path] = handler);
    await AdminRoutes.initAdminRoutes({ get: register, post: register });
  });

  beforeEach(() => {
    lookups = [];
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass !== TokenSchemaModel) throw new Error(`Unexpected core model ${modelClass.name}`);

      return {
        Constants: TokenSchemaModel.Constants,
        findOne: async (q) => {
          lookups.push(q);
          return null;
        },
      };
    });
  });

  afterEach(() => sinon.restore());

  // Calls the handler registered for `path` with `req`, returning the status and body it sent.
  async function call(path, req) {
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
    };
    await handlers[path]({ query: {}, params: {}, body: {}, headers: {}, ...req }, res);
    return res;
  }

  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  it('refuses a token given in the URL, without looking it up', async () => {
    for (const token of ['system-token', ['a', 'b'], { $ne: null }]) {
      const res = await call('/api/v1/admin/install-lambda', { query: { token }, body: { installLambda: [] } });
      assert.strictEqual(res.statusCode, 400, `accepted ${JSON.stringify(token)}`);
      assert.deepStrictEqual(res.body, { message: 'token_in_url_not_supported' });
    }

    const res = await call('/api/v1/admin/activate/:superToken', { params: { superToken: 'system-token' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { message: 'token_in_url_not_supported' });

    assert.deepStrictEqual(lookups, []);
  });

  it('refuses a request without a bearer token, without looking one up', async () => {
    for (const headers of [{}, { authorization: '' }, { authorization: 'Basic abc' }, bearer('')]) {
      const install = await call('/api/v1/admin/install-lambda', { headers, body: { installLambda: [] } });
      const activate = await call('/api/v1/admin/activate', { headers });

      assert.strictEqual(install.statusCode, 401, JSON.stringify(headers));
      assert.deepStrictEqual(install.body, { message: 'invalid_token' });
      assert.strictEqual(activate.statusCode, 404, JSON.stringify(headers));
      assert.deepStrictEqual(activate.body, { message: 'invalid_token' });
    }

    assert.deepStrictEqual(lookups, []);
  });

  it('looks up the bearer token of the Authorization header', async () => {
    await call('/api/v1/admin/install-lambda', { headers: bearer('install-token') });
    await call('/api/v1/admin/activate', { headers: bearer('activate-token') });

    assert.deepStrictEqual(lookups, [{ value: 'install-token' }, { value: 'activate-token', type: 'system' }]);
  });
});

describe('routes/admin-routes:install-lambda failures', () => {
  const handlers = {};

  before(async () => {
    const register = (path, handler) => (handlers[path] = handler);
    await AdminRoutes.initAdminRoutes({ get: register, post: register });
  });

  afterEach(() => sinon.restore());

  it("answers a failed install with a fixed message, not the failure's detail", async () => {
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass === TokenSchemaModel) {
        return { Constants: TokenSchemaModel.Constants, findOne: async () => ({ id: 'system-token', type: 'system' }) };
      }
      return { findOne: async () => { throw new Error('connect failed: mongodb://user:pw@db.internal'); } };
    });
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
    };

    await handlers['/api/v1/admin/install-lambda']({
      query: {},
      headers: { authorization: 'Bearer system' },
      params: {},
      body: { installLambda: [] },
    }, res)
      .catch(() => {});

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { message: 'install_lambda_failed' });
  });
});
