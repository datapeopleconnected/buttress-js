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
import PolicySchemaModel from '../../../../dist/model/core/policy.js';
import adminPolicy from '../../../../dist/admin-policy.json' with { type: 'json' };
import { toApiError } from '../../../../dist/helpers/errors.js';

// Calls `handler` with `req`, returning the status and body it sent, or that the error handler would send for what
// it threw: the routes are added before it, and Express passes it a handler's rejection.
async function callHandler(handler, req) {
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
  try {
    await handler({ query: {}, params: {}, body: {}, headers: {}, ...req }, res);
  } catch (err) {
    const apiError = toApiError(err);
    return { statusCode: apiError.status, body: apiError.toBody(), thrown: err };
  }
  return res;
}

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

  const call = (path, req) => callHandler(handlers[path], req);
  const urlToken = { code: 'token_in_url_not_supported', message: 'A token in the URL is not supported' };

  const bearer = (token) => ({ authorization: `Bearer ${token}` });

  it('refuses a token given in the URL, without looking it up', async () => {
    for (const token of ['system-token', ['a', 'b'], { $ne: null }]) {
      const res = await call('/api/v1/admin/install-lambda', { query: { token }, body: { installLambda: [] } });
      assert.strictEqual(res.statusCode, 400, `accepted ${JSON.stringify(token)}`);
      assert.deepStrictEqual(res.body, urlToken);
    }

    const res = await call('/api/v1/admin/activate/:superToken', { params: { superToken: 'system-token' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, urlToken);

    assert.deepStrictEqual(lookups, []);
  });

  it('refuses a request without a bearer token, without looking one up', async () => {
    for (const headers of [{}, { authorization: '' }, { authorization: 'Basic abc' }, bearer('')]) {
      const install = await call('/api/v1/admin/install-lambda', { headers, body: { installLambda: [] } });
      const activate = await call('/api/v1/admin/activate', { headers });

      for (const res of [install, activate]) {
        assert.strictEqual(res.statusCode, 401, JSON.stringify(headers));
        assert.deepStrictEqual(res.body, { code: 'missing_token', message: 'A token is required' });
      }
    }

    assert.deepStrictEqual(lookups, []);
  });

  it('looks up the bearer token of the Authorization header, refusing one it does not find with 401', async () => {
    const install = await call('/api/v1/admin/install-lambda', { headers: bearer('install-token') });
    const activate = await call('/api/v1/admin/activate', { headers: bearer('activate-token') });

    assert.deepStrictEqual(lookups, [{ value: 'install-token' }, { value: 'activate-token', type: 'system' }]);
    for (const res of [install, activate]) {
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.body.code, 'invalid_token');
    }
  });

  it('checks the token of an install without a body before reading the body', async () => {
    const missing = await call('/api/v1/admin/install-lambda', { body: undefined });
    const unknown = await call('/api/v1/admin/install-lambda', { headers: bearer('install-token'), body: undefined });

    assert.deepStrictEqual([missing.statusCode, missing.body.code], [401, 'missing_token']);
    assert.deepStrictEqual([unknown.statusCode, unknown.body.code], [401, 'invalid_token']);
  });

  it('refuses an install without a body from a system token with 400', async () => {
    Model.getCoreModel.restore();
    sinon.stub(Model, 'getCoreModel').returns({
      Constants: TokenSchemaModel.Constants,
      findOne: async () => ({ id: 'system-token', type: 'system' }),
    });

    const res = await call('/api/v1/admin/install-lambda', { headers: bearer('system-token'), body: undefined });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_body');
  });

  it('refuses a token that is not a system token with 403', async () => {
    Model.getCoreModel.restore();
    sinon.stub(Model, 'getCoreModel').returns({
      Constants: TokenSchemaModel.Constants,
      findOne: async () => ({ id: 'app-token', type: 'app' }),
    });

    const res = await call('/api/v1/admin/install-lambda', { headers: bearer('app-token'), body: { installLambda: [] } });

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'insufficient_authority');
  });
});

describe('routes/admin-routes:install-lambda failures', () => {
  const handlers = {};

  before(async () => {
    const register = (path, handler) => (handlers[path] = handler);
    await AdminRoutes.initAdminRoutes({ get: register, post: register });
  });

  afterEach(() => sinon.restore());

  it("answers a failed install as an internal error, not with the failure's detail", async () => {
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass === TokenSchemaModel) {
        return {
          Constants: TokenSchemaModel.Constants,
          createId: (id) => id,
          findOne: async () => ({ id: 'system-token', type: 'system' }),
        };
      }
      return { findOne: async () => { throw new Error('connect failed: mongodb://user:pw@db.internal'); } };
    });

    const res = await callHandler(handlers['/api/v1/admin/install-lambda'], {
      headers: { authorization: 'Bearer system' },
      body: { installLambda: [] },
    });

    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(res.body, { code: 'internal_error', message: 'Internal server error' });
    // Nothing was sent before it threw, so the error handler can answer
    assert.match(res.thrown.message, /connect failed/);
  });
});

describe('routes/admin-routes:_createAdminPolicy', () => {
  const APP = '6abd05000000000000000001';

  // The policies added, and the names of the ones already stored
  let added;
  let stored;

  beforeEach(() => {
    added = [];
    stored = [];
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass !== PolicySchemaModel) throw new Error(`Unexpected core model ${modelClass.name}`);

      return {
        findOne: async (q) => (stored.includes(q.name.$eq) ? { id: 'stored', name: q.name.$eq } : null),
        add: async (policy, internals) => added.push({ policy, internals }),
      };
    });
  });

  afterEach(() => sinon.restore());

  it('installs the admin policies on a fresh install, limiting the lambda access ones to the admin app', async () => {
    await AdminRoutes._createAdminPolicy(APP);

    assert.deepStrictEqual(added.map(({ policy }) => policy.name), ['admin-user', 'admin-lambda-access']);
    assert.ok(added.every(({ internals }) => internals._appId === APP));

    const [app, user, tokenAndUser] = added[1].policy.config;
    assert.deepStrictEqual(app.query, { id: { '@eq': APP } });
    assert.deepStrictEqual(user.query, { _appId: { '@eq': APP } });
    assert.deepStrictEqual(tokenAndUser.query, [{ _appId: { '@eq': APP } }]);
  });

  it('leaves the policies it ships as they are, for the next install', async () => {
    const before = JSON.parse(JSON.stringify(adminPolicy));

    await AdminRoutes._createAdminPolicy(APP);

    assert.deepStrictEqual(adminPolicy, before);
  });

  it('skips a policy that is already installed', async () => {
    stored = ['admin-lambda-access'];

    await AdminRoutes._createAdminPolicy(APP);

    assert.deepStrictEqual(added.map(({ policy }) => policy.name), ['admin-user']);
  });
});
