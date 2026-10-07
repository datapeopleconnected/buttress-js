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

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import createConfig from '@dpc/node-env-obj';
import Express from 'express';
import { Readable } from 'node:stream';

import Routes from '../../../../dist/routes/index.js';
import Model from '../../../../dist/model/index.js';
import Logging from '../../../../dist/helpers/logging.js';

const Config = createConfig();

function createApp() {
  return { get: sinon.stub(), use: sinon.stub(), post: sinon.stub(), put: sinon.stub(), delete: sinon.stub() };
}

function createRoutes(app = createApp()) {
  return { routes: new Routes(app), app };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/Routes:init', () => {
  it('throws when NRP is missing from services', async () => {
    const { routes } = createRoutes();
    const services = { get: () => undefined };

    await assert.rejects(() => routes.init(services), /NRP not found/);
  });

  it('registers a rest:worker:app-deleted listener that deregisters the app router', async () => {
    const { routes } = createRoutes();
    const listeners = {};
    const nrp = { on: (evt, cb) => (listeners[evt] = cb), emit: sinon.spy() };
    const services = { get: (key) => (key === 'nrp' ? nrp : undefined) };

    await routes.init(services);
    routes._routerMap['myapp'] = () => {};
    routes._routerOrder.push('myapp');

    listeners['rest:worker:app-deleted'](JSON.stringify({ appId: 'app-1', apiPath: 'myapp' }));

    assert.strictEqual(routes._routerMap['myapp'], undefined);
  });

  it("removes a deleted app's lambda endpoints, so an app given its api path later gets its own", async () => {
    const { routes } = createRoutes();
    const listeners = {};
    const nrp = { on: (evt, cb) => (listeners[evt] = cb), emit: sinon.spy() };
    await routes.init({ get: (key) => (key === 'nrp' ? nrp : undefined) });
    await routes._lambdaSetupHelper.__configureAppLambdaEndpoints('myapp');
    assert.ok(routes._routerMap['lambda:myapp']);

    listeners['rest:worker:app-deleted'](JSON.stringify({ appId: 'app-1', apiPath: 'myapp' }));

    assert.strictEqual(routes._routerMap['lambda:myapp'], undefined);
    await routes._lambdaSetupHelper.__configureAppLambdaEndpoints('myapp');
    assert.ok(routes._routerMap['lambda:myapp']);
  });
});

describe('routes/Routes:_initIndexPage', () => {
  let indexPage;
  let server;
  let baseUrl;

  // Register the index page on a real Express app listening on a free port
  async function listen() {
    const app = Express();
    new Routes(app)._initIndexPage();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  beforeEach(() => {
    indexPage = Config.app.indexPage;
  });

  afterEach(async () => {
    Config.app.indexPage = indexPage;
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
  });

  it('is enabled by default', () => {
    assert.strictEqual(indexPage, 'TRUE');
  });

  for (const pagePath of ['/', '/index.html']) {
    it(`serves the landing page at ${pagePath} when BUTTRESS_APP_INDEX_PAGE is TRUE`, async () => {
      Config.app.indexPage = 'TRUE';
      await listen();

      const res = await fetch(`${baseUrl}${pagePath}`);

      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(await res.text(), /<html/i);
    });

    it(`returns 404 unknown_route at ${pagePath} when BUTTRESS_APP_INDEX_PAGE is FALSE`, async () => {
      Config.app.indexPage = 'FALSE';
      await listen();

      const res = await fetch(`${baseUrl}${pagePath}`);

      assert.strictEqual(res.status, 404);
      assert.strictEqual((await res.json()).code, 'unknown_route');
    });
  }
});

describe('routes/Routes:_registerRouter/_deregisterRouter/_getRouter', () => {
  it('registers a new router and mounts the dispatcher exactly once', () => {
    const { routes, app } = createRoutes();

    routes._registerRouter('core', () => {});
    routes._registerRouter('app-1', () => {});

    assert.deepStrictEqual(routes._routerOrder, ['core', 'app-1']);
    assert.strictEqual(app.use.callCount, 1, 'the dispatcher middleware should only be mounted once');
  });

  it('re-registering the same key updates the router without duplicating the order', () => {
    const { routes } = createRoutes();
    const first = () => {};
    const second = () => {};

    routes._registerRouter('core', first);
    routes._registerRouter('core', second);

    assert.deepStrictEqual(routes._routerOrder, ['core']);
    assert.strictEqual(routes._getRouter('core'), second);
  });

  it('deregisters a router, removing it from both the map and the order', () => {
    const { routes } = createRoutes();
    routes._registerRouter('core', () => {});
    routes._registerRouter('app-1', () => {});

    routes._deregisterRouter('core');

    assert.strictEqual(routes._getRouter('core'), undefined);
    assert.deepStrictEqual(routes._routerOrder, ['app-1']);
  });

  it('does nothing when deregistering a router that was never registered', () => {
    const { routes } = createRoutes();
    routes._registerRouter('app-1', () => {});

    assert.doesNotThrow(() => routes._deregisterRouter('unknown'));
    assert.deepStrictEqual(routes._routerOrder, ['app-1']);
  });
});

describe('routes/Routes:_mountErrorHandler', () => {
  it('mounts the unknown route answer and the error handler exactly once', () => {
    const { routes, app } = createRoutes();

    routes._mountErrorHandler();
    routes._mountErrorHandler();

    assert.strictEqual(app.use.callCount, 2);
  });

  describe('on a real app', () => {
    let server;
    let routes;
    let baseUrl;

    // The dispatcher, then the unknown route answer and the error handler, as the REST process mounts them
    beforeEach(async () => {
      const app = Express();
      routes = new Routes(app);
      routes._mountRouterDispatcher();
      routes._mountErrorHandler();
      server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('answers a request no route takes with 404 unknown_route, as JSON', async () => {
      const res = await fetch(`${baseUrl}/nothing/here`, { method: 'DELETE' });

      assert.strictEqual(res.status, 404);
      assert.match(res.headers.get('content-type'), /^application\/json/);
      assert.deepStrictEqual(await res.json(), {
        code: 'unknown_route',
        message: 'No route takes DELETE /nothing/here',
        details: { method: 'DELETE', path: '/nothing/here' },
      });
    });

    it('reaches a router registered after they are mounted, as an app added later is', async () => {
      const router = Express.Router();
      router.get('/later', (req, res) => res.json({ reached: true }));
      routes._registerRouter('later', router);

      const res = await fetch(`${baseUrl}/later`);

      assert.deepStrictEqual(await res.json(), { reached: true });
    });
  });
});

describe('routes/Routes:_dispatchRouters', () => {
  function createReqResNext() {
    const req = {};
    const res = { headersSent: false, writableEnded: false };
    const next = sinon.stub();
    return { req, res, next };
  }

  it('calls every registered router in registration order', () => {
    const { routes } = createRoutes();
    const calls = [];
    routes._registerRouter('first', (req, res, cb) => {
      calls.push('first');
      cb();
    });
    routes._registerRouter('second', (req, res, cb) => {
      calls.push('second');
      cb();
    });

    const { req, res, next } = createReqResNext();
    routes._dispatchRouters(req, res, next);

    assert.deepStrictEqual(calls, ['first', 'second']);
    assert.ok(next.calledOnce, 'next() should be called once every router has run');
  });

  it('skips a key whose router was deregistered mid-flight without breaking the chain', () => {
    const { routes } = createRoutes();
    routes._registerRouter('first', (req, res, cb) => cb());
    routes._registerRouter('second', (req, res, cb) => cb());
    // Simulate a stale order entry (deregister without going through _deregisterRouter's array cleanup).
    delete routes._routerMap['first'];

    const { req, res, next } = createReqResNext();
    routes._dispatchRouters(req, res, next);

    assert.ok(next.calledOnce);
  });

  it('stops dispatching further routers once the response has been sent', () => {
    const { routes } = createRoutes();
    const calls = [];
    routes._registerRouter('first', (req, res, cb) => {
      calls.push('first');
      res.headersSent = true;
      cb();
    });
    routes._registerRouter('second', (req, res, cb) => {
      calls.push('second');
      cb();
    });

    const { req, res, next } = createReqResNext();
    routes._dispatchRouters(req, res, next);

    assert.deepStrictEqual(calls, ['first']);
    assert.strictEqual(next.called, false, 'next() should not be reached once the response is already sent');
  });

  it('forwards an error from a router straight to next() without running the rest of the chain', () => {
    const { routes } = createRoutes();
    const calls = [];
    routes._registerRouter('first', (req, res, cb) => {
      calls.push('first');
      cb(new Error('router boom'));
    });
    routes._registerRouter('second', (req, res, cb) => {
      calls.push('second');
      cb();
    });

    const { req, res, next } = createReqResNext();
    routes._dispatchRouters(req, res, next);

    assert.deepStrictEqual(calls, ['first']);
    assert.ok(next.calledOnce);
    assert.strictEqual(next.firstCall.args[0].message, 'router boom');
  });

  it('calls next() with no error when there are no routers registered at all', () => {
    const { routes } = createRoutes();

    const { req, res, next } = createReqResNext();
    routes._dispatchRouters(req, res, next);

    assert.ok(next.calledOnceWithExactly());
  });
});

describe('routes/Routes:_initRoute', () => {
  class FakeRoute {
    constructor() {
      this.name = 'widget';
      this.paths = ['/widget', '/widget/:id'];
      this.verb = 'get';
      this.authType = 'app';
      this.exec = sinon.stub().resolves('exec-result');
    }
  }

  it('registers every path of the route class on the app under the configured verb', () => {
    const { routes, app } = createRoutes();

    routes._initRoute(app, FakeRoute, true);

    assert.strictEqual(app.get.callCount, 2);
    const [routePath, middleware, handler] = app.get.firstCall.args;
    assert.ok(routePath.endsWith('/widget'));
    assert.strictEqual(Array.isArray(middleware), true);
    assert.strictEqual(typeof handler, 'function');
  });

  it("the registered handler sets req.context.pathSpec and delegates to the route instance's exec()", async () => {
    const { routes, app } = createRoutes();

    routes._initRoute(app, FakeRoute, true);
    const [, , handler] = app.get.firstCall.args;

    const req = { context: {} };
    const res = {};
    const next = sinon.stub();

    await handler(req, res, next);

    assert.strictEqual(req.context.pathSpec, '/widget');
    assert.strictEqual(next.called, false, 'next() should not be invoked when exec() resolves');
  });

  // Such a route refuses every request (SR-DPC-001 S12)
  it('reports a route whose auth type is not a known one', () => {
    const { routes, app } = createRoutes();
    const logError = sinon.stub(Logging, 'logError');

    routes._initRoute(app, FakeRoute, true);
    assert.strictEqual(logError.callCount, 0);

    class UnknownAuthRoute extends FakeRoute {
      constructor() {
        super();
        this.authType = 'admin';
      }
    }
    routes._initRoute(app, UnknownAuthRoute, true);

    assert.strictEqual(logError.callCount, 1);
    assert.match(logError.firstCall.args[0], /widget has an unknown auth type admin/);
  });

  it('forwards a rejected exec() to next()', async () => {
    const { routes, app } = createRoutes();

    class FailingRoute extends FakeRoute {
      constructor() {
        super();
        this.paths = ['/widget'];
        this.exec = sinon.stub().rejects(new Error('exec failed'));
      }
    }

    routes._initRoute(app, FailingRoute, true);
    const [, , handler] = app.get.firstCall.args;

    const req = { context: {} };
    const next = sinon.stub();
    await handler(req, {}, next);
    // exec()'s rejection is attached via .catch(next); allow the microtask queue to flush.
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(next.calledOnce);
    assert.strictEqual(next.firstCall.args[0].message, 'exec failed');
  });
});

describe('routes/Routes:_handleEarlyError', () => {
  let server;
  let baseUrl;

  // A real Express app with the JSON parser, the handler and a route that echoes the body it got
  beforeEach(async () => {
    const app = Express();
    const routes = new Routes(app);
    app.use(Express.json({ limit: '1kb' }));
    app.use((err, req, res, next) => routes._handleEarlyError(err, req, res, next));
    app.post('/echo', (req, res) => res.json({ body: req.body ?? null }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const post = (body, headers = {}) =>
    fetch(`${baseUrl}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  for (const [label, body] of [
    ['malformed JSON', '{"a":'],
    ['a string', '"x"'],
    ['null', 'null'],
  ]) {
    it(`answers 400 invalid_body for ${label}`, async () => {
      const res = await post(body);

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), { code: 'invalid_body', message: 'The request body could not be parsed' });
    });
  }

  it('answers 413 body_too_large for a body over the limit', async () => {
    const res = await post(JSON.stringify({ a: 'x'.repeat(2048) }));

    assert.strictEqual(res.status, 413);
    assert.strictEqual((await res.json()).code, 'body_too_large');
  });

  it('answers 415 unsupported_body_encoding for an unknown charset', async () => {
    const res = await post('{}', { 'Content-Type': 'application/json; charset=klingon' });

    assert.strictEqual(res.status, 415);
    assert.strictEqual((await res.json()).code, 'unsupported_body_encoding');
  });

  it('passes a valid body through to the route', async () => {
    const res = await post('{"a":1}');

    assert.deepStrictEqual(await res.json(), { body: { a: 1 } });
  });

  it('logs any other error and carries on', () => {
    const routes = new Routes(createApp());
    const next = sinon.spy();

    routes._handleEarlyError(new Error('boom'), {}, {}, next);

    assert.ok(next.calledOnceWithExactly());
  });
});

describe('routes/Routes:initAppRoutes', () => {
  const app = (id, __schema) => ({ id, name: id, apiPath: id, __schema });
  const schema = (name) => ({ name, type: 'collection', extends: [], properties: {} });

  // Routes over the apps given, with no data sharing agreements, noting the schema routes it would set up
  function createAppRoutes(apps, { find = async () => Readable.from([]) } = {}) {
    sinon.stub(Model, 'getCoreModel').returns({ findAll: async () => Readable.from(apps), find });
    const { routes } = createRoutes();
    const built = [];
    sinon.stub(routes, '_initSchemaRoutes').callsFake((router, app, schema) => built.push([app.id, schema.name]));
    return { routes, built };
  }

  for (const [label, stored] of [
    ["isn't JSON", '[{"name": "car", '],
    ["isn't a list", JSON.stringify({ name: 'car', type: 'collection' })],
    ['is null', 'null'],
    ['holds null', JSON.stringify([{ name: 'car', type: 'collection', properties: {} }, null])],
    ['holds a schema with no type', JSON.stringify([{ name: 'car', properties: {} }])],
  ]) {
    it(`passes over an app whose stored schema ${label}, and sets up the routes of the apps after it`, async () => {
      const warn = sinon.stub(Logging, 'logWarn');
      const { routes, built } = createAppRoutes([
        app('app-1', JSON.stringify([schema('boat')])),
        app('app-2', stored),
        app('app-3', JSON.stringify([schema('car')])),
      ]);

      await routes.initAppRoutes();

      assert.deepStrictEqual(built, [
        ['app-1', 'boat'],
        ['app-3', 'car'],
      ]);
      assert.ok(routes._routerMap['app-1']);
      assert.strictEqual(routes._routerMap['app-2'], undefined);
      assert.ok(routes._routerMap['app-3']);
      sinon.assert.calledOnceWithMatch(warn, 'app-2');
    });
  }

  it('still fails on an error that is not about the stored schema', async () => {
    const { routes } = createAppRoutes([app('app-1', JSON.stringify([schema('car')]))], {
      find: async () => {
        throw new Error('datastore went away');
      },
    });

    await assert.rejects(routes.initAppRoutes(), /datastore went away/);
  });
});
