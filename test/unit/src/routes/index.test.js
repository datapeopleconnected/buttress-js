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

import Routes from '../../../../dist/routes/index.js';

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
  it('mounts the error handler exactly once', () => {
    const { routes, app } = createRoutes();

    routes._mountErrorHandler();
    routes._mountErrorHandler();

    assert.strictEqual(app.use.callCount, 1);
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
      this.paths = ['/widget', '/widget/:id'];
      this.verb = 'get';
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
