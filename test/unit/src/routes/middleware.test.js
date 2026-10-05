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
import http from 'node:http';
import sinon from 'sinon';
import Express from 'express';

import { RoutesMiddleware } from '../../../../dist/routes/middleware.js';
import Logging from '../../../../dist/helpers/logging.js';
import IOStats from '../../../../dist/helpers/io-stats.js';
import * as Helpers from '../../../../dist/helpers/errors.js';
import Model from '../../../../dist/model/index.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';
import AppSchemaModel from '../../../../dist/model/core/app.js';
import LambdaSchemaModel from '../../../../dist/model/core/lambda.js';
import UserSchemaModel from '../../../../dist/model/core/user.js';
import AppDataSharingSchemaModel from '../../../../dist/model/core/app-data-sharing.js';
import AdminRoutes from '../../../../dist/routes/admin-routes.js';

function createMiddleware() {
  return new RoutesMiddleware({}, {});
}

function createReq() {
  return { context: { id: 'req-1' } };
}

function createRes() {
  const res = {
    status: sinon.stub(),
    json: sinon.stub(),
    end: sinon.stub(),
  };
  res.status.returns(res);
  res.json.returns(res);
  return res;
}

afterEach(() => {
  sinon.restore();
});

describe('routes/RoutesMiddleware:_createContext', () => {
  afterEach(() => {
    IOStats.disable();
  });

  it('counts the I/O the rest of the request causes against its request id', async () => {
    IOStats.enable();
    const middleware = createMiddleware();
    const req = {};

    await new Promise((resolve) => {
      middleware._createContext(req, {}, () => {
        setImmediate(() => {
          IOStats.record('mongo', 'find', 'tokens');
          resolve();
        });
      });
    });

    assert.deepStrictEqual(IOStats.get(req.context.id).mongo, { find: 1 });
  });
});

describe('routes/RoutesMiddleware:logErrors', () => {
  it('sends an ApiError with its status and body, without logging it as an error', () => {
    sinon.stub(Logging, 'logError');
    const middleware = createMiddleware();
    const req = createReq();
    const res = createRes();
    const next = sinon.spy();
    const err = Helpers.entityNotFound('policy', '6AB00000000000000000ABCD');

    middleware.logErrors(err, req, res, next);

    assert(res.status.calledWith(404));
    assert.deepStrictEqual(res.json.firstCall.args[0], {
      code: 'not_found',
      message: 'No policy was found with that id',
      details: { schema: 'policy', id: '6AB00000000000000000ABCD' },
    });
    assert(next.notCalled);
    assert(Logging.logError.notCalled);
  });

  it('logs and sends a generic JSON body for any other error, without leaking its message', () => {
    sinon.stub(Logging, 'logError');
    const middleware = createMiddleware();
    const req = createReq();
    const res = createRes();
    const next = sinon.spy();
    const err = new TypeError('connect ECONNREFUSED 127.0.0.1:27017');

    middleware.logErrors(err, req, res, next);

    assert(Logging.logError.calledWith(err, 'req-1'));
    assert(res.status.calledWith(500));
    assert(res.json.calledOnce);
    const body = res.json.firstCall.args[0];
    assert.deepStrictEqual(body, { code: 'internal_error', message: 'Internal server error' });
    assert(!JSON.stringify(body).includes('ECONNREFUSED'));
    assert(next.notCalled);
  });

  it('logs the reason of an internal ApiError and sends only the generic body', () => {
    sinon.stub(Logging, 'logError');
    const middleware = createMiddleware();
    const res = createRes();

    middleware.logErrors(Helpers.internal('no_authenticated_app'), createReq(), res, sinon.spy());

    assert(Logging.logError.calledWith('no_authenticated_app', 'req-1'));
    assert(res.status.calledWith(500));
    assert.deepStrictEqual(res.json.firstCall.args[0], { code: 'internal_error', message: 'Internal server error' });
  });

  it('passes the error on without sending one when the response has already started', () => {
    sinon.stub(Logging, 'logError');
    const middleware = createMiddleware();
    const req = createReq();
    const res = { ...createRes(), headersSent: true };
    const next = sinon.spy();
    const err = new TypeError('stream failed');

    middleware.logErrors(err, req, res, next);

    assert(Logging.logError.calledWith(err, 'req-1'));
    assert(res.status.notCalled);
    assert(res.json.notCalled);
    assert(next.calledWith(err));
  });

  describe('over a keep-alive connection', () => {
    let server = null;

    afterEach(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    });

    // An Express app with a route that fails and one that doesn't, using logErrors as its error handler, as the REST
    // process does.
    async function listen() {
      const middleware = createMiddleware();
      const app = Express();
      app.use(Express.json());
      app.use((req, res, next) => {
        req.context = { id: 'req-1' };
        next();
      });
      app.get('/missing', () => {
        throw Helpers.notFound('not_found');
      });
      app.post('/add', (req, res) => res.json(req.body));
      app.use((err, req, res, next) => middleware.logErrors(err, req, res, next));

      server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      return server.address().port;
    }

    function request(agent, port, method, path, body) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          { agent, port, method, path, headers: { 'Content-Type': 'application/json' } },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode, headers: res.headers, body: data, socket: req.socket }),
            );
          },
        );
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    }

    it('leaves the connection open for the next request after an error', async () => {
      const port = await listen();
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

      try {
        const failed = await request(agent, port, 'GET', '/missing');
        assert.strictEqual(failed.status, 404);
        assert.notStrictEqual(failed.headers.connection, 'close');

        // Wait for the server to act on the finished request, so a socket it closes is seen as closed
        await new Promise((resolve) => setTimeout(resolve, 50));

        const added = await request(agent, port, 'POST', '/add', { name: 'after-error' });
        assert.strictEqual(added.status, 200);
        assert.deepStrictEqual(JSON.parse(added.body), { name: 'after-error' });
        assert.strictEqual(added.socket, failed.socket, 'the POST should reuse the connection of the failed request');
      } finally {
        agent.destroy();
      }
    });
  });
});

describe('routes/RoutesMiddleware:_configCrossDomain', () => {
  function run(domains, origin) {
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass === TokenSchemaModel) return { Constants: { Type: { USER: 'user' } } };
      throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
    });
    sinon.stub(Logging, 'logError');
    const req = {
      method: 'GET',
      header: (name) => ({ Origin: origin })[name],
      context: { id: 'req-1', timings: {}, token: { type: 'user', domains } },
    };
    const res = { header: sinon.stub(), sendStatus: sinon.stub() };
    const next = sinon.spy();

    createMiddleware()._configCrossDomain(req, res, next);

    return { res, next };
  }

  it("lets through a request from one of the token's domains", () => {
    const { next } = run(['https://app.example.com'], 'https://app.example.com');

    assert.ok(next.calledOnceWithExactly());
  });

  // The error handler answers it
  const assertRefused = (next, status, code) => {
    assert.ok(next.calledOnce);
    const [err] = next.firstCall.args;
    assert.ok(err instanceof Helpers.ApiError, `passed on ${err}`);
    assert.strictEqual(err.status, status);
    assert.strictEqual(err.code, code);
  };

  it('refuses a token that holds a null domain with 403 origin_not_allowed, like any other domain it does not match', () => {
    const { res, next } = run([null], 'https://app.example.com');

    assertRefused(next, 403, 'origin_not_allowed');
    assert.ok(res.sendStatus.notCalled);
  });

  it('ignores the domains that are not strings and matches the rest', () => {
    const { next } = run([null, 42, {}, '*.example.com'], 'https://app.example.com');

    assert.ok(next.calledOnceWithExactly());
  });

  it('refuses a token whose domains are not a list', () => {
    const { next } = run(null, 'https://app.example.com');

    assertRefused(next, 403, 'origin_not_allowed');
  });

  it('lets through a request from an exact domain, without reading it as a pattern', () => {
    const { next } = run(['other.example.com', 'app.example.com'], 'https://app.example.com');

    assert.ok(next.calledOnceWithExactly());
  });

  it('lets through a subdomain of a *. domain, giving its origin as Access-Control-Allow-Origin', () => {
    const { res, next } = run(['*.example.com'], 'https://app.eu.example.com');

    assert.ok(next.calledOnceWithExactly());
    assert.ok(res.header.calledWith('Access-Control-Allow-Origin', 'https://app.eu.example.com'));
  });

  it('refuses a look-alike origin that only starts like a subdomain of a *. domain', () => {
    const { res, next } = run(['*.example.com'], 'https://app.example.com.evil.io');

    assertRefused(next, 403, 'origin_not_allowed');
    assert.ok(res.header.notCalled);
  });

  it('refuses the bare domain of a *. domain, which has to be listed itself', () => {
    const { next } = run(['*.example.com'], 'https://example.com');

    assertRefused(next, 403, 'origin_not_allowed');
  });

  it("keeps the origin's port, so a domain naming that port lets it through", () => {
    const { next } = run(['*.example.com:8443'], 'https://app.example.com:8443');

    assert.ok(next.calledOnceWithExactly());
  });

  it('refuses an origin whose port its domain does not name', () => {
    const { next } = run(['*.example.com'], 'https://app.example.com:8443');

    assertRefused(next, 403, 'origin_not_allowed');
  });

  it('lets through any port for a domain ending in :*', () => {
    const { next } = run(['localhost:*'], 'http://localhost:3000');

    assert.ok(next.calledOnceWithExactly());
  });

  it("matches a pattern's other characters as themselves, not as a regular expression", () => {
    // Read as a regular expression, [::1] is a character class, which `host1:8080` matches
    const { next } = run(['[::1]:*'], 'http://host1:8080');

    assertRefused(next, 403, 'origin_not_allowed');
  });

  it('lets through an IPv6 origin that matches a pattern', () => {
    const { next } = run(['[::1]:*'], 'http://[::1]:8080');

    assert.ok(next.calledOnceWithExactly());
  });

  it('lets through any origin for a token with the * domain', () => {
    const { next } = run(['*'], 'https://app.example.com.evil.io');

    assert.ok(next.calledOnceWithExactly());
  });

  it('refuses a request with no token with 401 missing_token', () => {
    sinon.stub(Logging, 'logError');
    const req = { method: 'GET', header: () => undefined, context: { id: 'req-1', timings: {}, token: null } };
    const res = { header: sinon.stub(), status: sinon.stub(), json: sinon.stub() };
    const next = sinon.spy();

    createMiddleware()._configCrossDomain(req, res, next);

    assertRefused(next, 401, 'missing_token');
    assert.ok(res.status.notCalled);
  });
});

describe('routes/RoutesMiddleware:_authenticateToken a lambda endpoint call', () => {
  const app = { id: 'app-1', apiPath: 'test' };
  const lambdaToken = { id: 'lambda-token', _appId: 'app-1', _lambdaId: 'lambda-1', type: 'lambda' };
  const callerToken = { id: 'caller-token', _appId: 'app-1', type: 'app' };

  // The context the request has once it's authenticated, for a call with `provided` as its token
  async function authenticate({ type = 'PRIVATE', useCallerToken, provided = callerToken }) {
    const lambda = {
      id: 'lambda-1', _appId: 'app-1', type,
      trigger: [{ type: 'API_ENDPOINT', apiEndpoint: { url: 'hello', method: 'GET', useCallerToken } }],
    };
    const models = new Map([
      [AppSchemaModel, { findOne: async () => app, findById: async () => app }],
      [LambdaSchemaModel, { findOne: async () => lambda }],
      [TokenSchemaModel, { findOne: async () => lambdaToken }],
      [UserSchemaModel, { findById: async () => null }],
      [AppDataSharingSchemaModel, { findById: async () => null }],
    ]);
    sinon.stub(Model, 'getCoreModel').callsFake((model) => models.get(model));
    sinon.stub(AdminRoutes, 'checkAdminCall').resolves({});
    const middleware = createMiddleware();
    sinon.stub(middleware, '_getProvidedToken').resolves(provided);
    const req = {
      url: '/lambda/v1/test/hello', method: 'GET', query: {}, headers: {},
      context: { id: 'req-1', timings: {}, authLambda: null, authApp: null, token: null, callerToken: null },
    };

    const next = sinon.stub();
    await middleware._authenticateToken(req, createRes(), next);
    assert.deepStrictEqual(next.firstCall.args, [], 'the request is let through');
    return req.context;
  }

  it("runs a call to an endpoint that uses the caller's token with the caller's, which is also the caller", async () => {
    const context = await authenticate({ useCallerToken: true });

    assert.strictEqual(context.token, callerToken);
    assert.strictEqual(context.callerToken, callerToken);
  });

  it("runs a call to an endpoint that doesn't with the lambda's token, keeping the caller's apart", async () => {
    const context = await authenticate({ useCallerToken: false });

    assert.strictEqual(context.token, lambdaToken);
    assert.strictEqual(context.callerToken, callerToken);
  });

  it("has no caller for a call to a PUBLIC endpoint that doesn't use the caller's token, whatever it sends", async () => {
    const context = await authenticate({ type: 'PUBLIC', useCallerToken: false });

    assert.strictEqual(context.token, lambdaToken);
    assert.strictEqual(context.callerToken, null);
  });
});
