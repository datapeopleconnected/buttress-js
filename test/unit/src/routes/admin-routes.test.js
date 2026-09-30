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
    await handlers[path]({ query: {}, params: {}, body: {}, ...req }, res);
    return res;
  }

  // Express 5 parses a repeated ?token= into an array, and Express 4's extended parser made ?token[$ne]= an object.
  const notStrings = [{ $ne: null }, { $regex: '.' }, ['a', 'b'], ''];

  it('refuses a ?token= on install-lambda that is not a string, without looking it up', async () => {
    for (const token of notStrings) {
      const res = await call('/api/v1/admin/install-lambda', { query: { token }, body: { installLambda: [] } });

      assert.strictEqual(res.statusCode, 401, `accepted ${JSON.stringify(token)}`);
      assert.deepStrictEqual(res.body, { message: 'invalid_token' });
    }

    assert.deepStrictEqual(lookups, []);
  });

  it('refuses a super token on activate that is not a string, without looking it up', async () => {
    for (const superToken of notStrings) {
      const res = await call('/api/v1/admin/activate/:superToken', { params: { superToken } });

      assert.strictEqual(res.statusCode, 404, `accepted ${JSON.stringify(superToken)}`);
      assert.deepStrictEqual(res.body, { message: 'invalid_token' });
    }

    assert.deepStrictEqual(lookups, []);
  });

  it('still looks up a token that is a string', async () => {
    await call('/api/v1/admin/install-lambda', { query: { token: 'install-token' } });
    await call('/api/v1/admin/activate/:superToken', { params: { superToken: 'activate-token' } });

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

    await handlers['/api/v1/admin/install-lambda']({ query: { token: 'system' }, params: {}, body: { installLambda: [] } }, res)
      .catch(() => {});

    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(res.body, { message: 'install_lambda_failed' });
  });
});
