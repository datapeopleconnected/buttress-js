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

import { describe, it, afterEach, beforeEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import { Readable, PassThrough } from 'node:stream';

import Route from '../../../../dist/routes/route.js';
import Logging from '../../../../dist/helpers/logging.js';
import Model from '../../../../dist/model/index.js';
import ActivitySchemaModel from '../../../../dist/model/core/activity.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';

function createNrpFake() {
  return { on: () => {}, emit: sinon.spy() };
}

// Route's `activityVisibility` class field and `_checkBasedPathLambda`/`_addLogActivity` all
// read core models via Model.getCoreModel(), which normally requires the real datastore-backed
// core-model init to have run at boot. Stub just the two lookups Route itself touches so a Route
// instance can be constructed and exercised without a live Mongo connection.
beforeEach(() => {
  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === ActivitySchemaModel) {
      return { Constants: { Visibility: { PRIVATE: 'PRIVATE' } }, add: async () => ({}) };
    }
    if (modelClass === TokenSchemaModel) {
      return { Constants: { Type: { LAMBDA: 'lambda' } } };
    }
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });
});

function createRoute({
  paths = '/user',
  name = 'testRoute',
  schema = { name: 'user' },
  app = { id: 'app-1' },
  nrp,
} = {}) {
  const services = {
    get: (key) => ({ nrp: nrp || createNrpFake(), modelManager: {}, redisClient: {} })[key],
  };
  return new Route(paths, name, services, schema, app);
}

function createReq({
  method = 'GET',
  path = '/api/v1/user',
  pathSpec = null,
  params = {},
  body = {},
  token = { type: 'user' },
  authApp = { id: 'app-1' },
  authUser = null,
  authLambda = null,
} = {}) {
  return {
    method,
    path,
    url: path,
    originalUrl: path,
    ip: '127.0.0.1',
    params,
    body,
    context: {
      id: 'req-1',
      timer: { interval: 0, lapTime: 0 },
      timings: { stream: [] },
      token,
      authApp,
      authUser,
      authLambda,
      pathSpec: pathSpec || path,
      clientSessionId: 'sess-1',
      bjsReqStatus: () => {},
      bjsReqClose: () => {},
    },
  };
}

function createRes() {
  return { statusCode: 200, json: sinon.stub(), set: sinon.stub() };
}

afterEach(() => {
  sinon.restore();
});

describe('routes/Route:constructor', () => {
  it('throws when NRP is missing from services', () => {
    const services = { get: (key) => (key === 'modelManager' ? {} : undefined) };
    assert.throws(() => new Route('/user', 'test', services, null), /NRP not found/);
  });

  it('throws when ModelManager is missing from services', () => {
    const services = { get: (key) => (key === 'nrp' ? createNrpFake() : undefined) };
    assert.throws(() => new Route('/user', 'test', services, null), /ModelManager not found/);
  });

  it('normalises a single path string into an array', () => {
    const route = createRoute({ paths: '/user' });
    assert.deepStrictEqual(route.paths, ['/user']);
  });
});

describe('routes/Route:_authenticate', () => {
  it('rejects with 401 when there is no token', async () => {
    const route = createRoute();
    const req = createReq({ token: null });

    await assert.rejects(
      () => route._authenticate(req, createRes()),
      (err) => {
        assert.strictEqual(err.code, 401);
        assert.strictEqual(err.message, 'invalid_token');
        return true;
      },
    );
  });

  it('rejects with 401 when the token type has insufficient authority', async () => {
    const route = createRoute();
    route.authType = Route.Constants.Type.SYSTEM;
    const req = createReq({ token: { type: 'user' } });

    await assert.rejects(
      () => route._authenticate(req, createRes()),
      (err) => {
        assert.strictEqual(err.code, 401);
        assert.strictEqual(err.message, 'insufficient_authority');
        return true;
      },
    );
  });

  it('resolves for an app token, bypassing schema checks', async () => {
    const route = createRoute();
    const req = createReq({ token: { type: 'app' } });

    const result = await route._authenticate(req, createRes());
    assert.strictEqual(result.type, 'app');
  });

  it('resolves for a dataSharing token', async () => {
    const route = createRoute();
    const req = createReq({ token: { type: 'dataSharing' } });

    const result = await route._authenticate(req, createRes());
    assert.strictEqual(result.type, 'dataSharing');
  });

  it('resolves for a regular user token with sufficient authority', async () => {
    const route = createRoute();
    const req = createReq({ token: { type: 'user' } });

    const result = await route._authenticate(req, createRes());
    assert.strictEqual(result.type, 'user');
  });
});

describe('routes/Route:_matchPermission', () => {
  it('matches the wildcard permission spec', () => {
    const route = createRoute();
    assert.strictEqual(route._matchPermission('*'), true);
  });

  it('matches when the spec equals the route permission', () => {
    const route = createRoute();
    route.permissions = Route.Constants.Permissions.WRITE;
    assert.strictEqual(route._matchPermission(Route.Constants.Permissions.WRITE), true);
  });

  it('does not match a different permission spec', () => {
    const route = createRoute();
    route.permissions = Route.Constants.Permissions.READ;
    assert.strictEqual(route._matchPermission(Route.Constants.Permissions.WRITE), false);
  });
});

describe('routes/Route:_close', () => {
  it('logs an error when the request exceeded the configured slow-logging time', () => {
    const route = createRoute();
    route.slowLogging = true;
    route.slowLoggingTime = 0;
    const logError = sinon.stub(Logging, 'logError');
    const req = createReq();
    req.context.timer.interval = 5;

    route._close(req);

    assert.ok(logError.calledOnce);
  });

  it('does not log when slow-logging is disabled', () => {
    const route = createRoute();
    route.slowLogging = false;
    const logError = sinon.stub(Logging, 'logError');
    const req = createReq();
    req.context.timer.interval = 999;

    route._close(req);

    assert.strictEqual(logError.called, false);
  });
});

describe('routes/Route:_logActivity', () => {
  it('skips logging activity for GET requests', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.GET;
    const addLog = sinon.stub(route, '_addLogActivity');

    route._logActivity(createReq(), createRes());

    assert.strictEqual(addLog.called, false);
  });

  it('skips logging activity for SEARCH requests', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.SEARCH;
    const addLog = sinon.stub(route, '_addLogActivity');

    route._logActivity(createReq(), createRes());

    assert.strictEqual(addLog.called, false);
  });

  it('logs activity for mutating verbs when activity tracking is enabled', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    route.activity = true;
    const addLog = sinon.stub(route, '_addLogActivity');

    route._logActivity(createReq(), createRes());

    assert.ok(addLog.calledOnce);
  });

  it('does not log activity when activity tracking is disabled', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    route.activity = false;
    const addLog = sinon.stub(route, '_addLogActivity');

    route._logActivity(createReq(), createRes());

    assert.strictEqual(addLog.called, false);
  });
});

describe('routes/Route:_boardcastData', () => {
  it('skips broadcasting for GET requests', async () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.GET;
    const broadcast = sinon.stub(route, '_broadcast');
    const checkLambda = sinon.stub(route, '_checkBasedPathLambda');

    await route._boardcastData(createReq(), createRes(), {});

    assert.strictEqual(broadcast.called, false);
    assert.strictEqual(checkLambda.called, false);
  });

  it('broadcasts twice (super + scoped) and checks for path lambdas on mutating verbs', async () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const broadcast = sinon.stub(route, '_broadcast').resolves();
    const checkLambda = sinon.stub(route, '_checkBasedPathLambda').resolves();
    const req = createReq({ path: '/api/v1/user', authApp: { id: 'app-1', apiPath: 'myapp' } });

    await route._boardcastData(req, createRes(), { name: 'test' });

    assert.strictEqual(broadcast.callCount, 2);
    assert.strictEqual(broadcast.firstCall.args[3], '/user');
    assert.strictEqual(broadcast.firstCall.args[4], true);
    assert.strictEqual(broadcast.secondCall.args[4], undefined);
    assert.ok(checkLambda.calledOnce);
  });

  it('strips the app api path segment from the broadcast path when present', async () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const broadcast = sinon.stub(route, '_broadcast').resolves();
    sinon.stub(route, '_checkBasedPathLambda').resolves();
    const req = createReq({ path: '/api/v1/user', authApp: { id: 'app-1', apiPath: 'api' } });

    await route._boardcastData(req, createRes(), {});

    assert.strictEqual(broadcast.firstCall.args[3], '/v1/user');
  });
});

describe('routes/Route:_broadcast', () => {
  it('emits rest:activity when activityBroadcast is enabled', () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp });
    route.activityBroadcast = true;
    route.verb = Route.Constants.Verbs.POST;

    route._broadcast(createReq(), createRes(), { name: 'test' }, '/user', true);

    assert.ok(nrp.emit.calledWith('rest:activity'));
    const [, payload] = nrp.emit.firstCall.args;
    const parsed = JSON.parse(payload);
    assert.strictEqual(parsed.path, '/user');
    assert.strictEqual(parsed.isSuper, true);
  });

  it('does not emit when activityBroadcast is disabled', () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp });
    route.activityBroadcast = false;

    route._broadcast(createReq(), createRes(), { name: 'test' }, '/user');

    assert.strictEqual(nrp.emit.called, false);
  });

  it('emits once per streamed data chunk', async () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp });
    route.activityBroadcast = true;

    const stream = new Readable({ objectMode: true, read() {} });
    route._broadcast(createReq(), createRes(), stream, '/user');
    stream.push({ name: 'a' });
    stream.push({ name: 'b' });
    stream.push(null);
    await new Promise((resolve) => stream.on('end', resolve));

    assert.strictEqual(nrp.emit.callCount, 2);
  });
});

describe('routes/Route:_checkBasedPathLambda', () => {
  it('does nothing when the route has no schemaName', () => {
    const route = createRoute({ schema: null });
    const nrp = route._nrp;
    route.verb = Route.Constants.Verbs.POST;

    route._checkBasedPathLambda(createReq({ body: { name: 'test' } }));

    assert.strictEqual(nrp.emit.called, false);
  });

  it('blocks a path-mutation lambda from triggering further path mutations', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      body: { name: 'test' },
      token: { type: 'lambda' },
      authLambda: { name: 'my-lambda', trigger: [{ type: 'PATH_MUTATION' }] },
    });

    route._checkBasedPathLambda(req);

    assert.strictEqual(route._nrp.emit.called, false);
  });

  it('notifies a simple path mutation for a plain POST', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({ body: { name: 'test' } });

    route._checkBasedPathLambda(req);

    assert.ok(route._nrp.emit.calledWith('rest:worker:notifyLambdaPathChange'));
    const [, payload] = route._nrp.emit.firstCall.args;
    const parsed = JSON.parse(payload);
    assert.deepStrictEqual(parsed.paths, ['user']);
    assert.deepStrictEqual(parsed.values, [{ name: 'test' }]);
  });

  it('notifies individual paths for a bulk update POST', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      pathSpec: '/api/v1/user/bulk/update',
      body: [{ id: 'id-1', body: [{ path: 'name', value: 'a' }] }],
    });

    route._checkBasedPathLambda(req);

    const [, payload] = route._nrp.emit.firstCall.args;
    const parsed = JSON.parse(payload);
    assert.deepStrictEqual(parsed.paths, ['user.id-1.name']);
  });

  it('notifies individual paths for a bulk delete POST', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      pathSpec: '/api/v1/user/bulk/delete',
      body: ['id-1', 'id-2'],
    });

    route._checkBasedPathLambda(req);

    const [, payload] = route._nrp.emit.firstCall.args;
    const parsed = JSON.parse(payload);
    assert.deepStrictEqual(parsed.paths, ['user.id-1', 'user.id-2']);
  });

  it('notifies the entity path for a DELETE by id', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.DEL;
    const req = createReq({ params: { id: 'id-1' } });

    route._checkBasedPathLambda(req);

    const [, payload] = route._nrp.emit.firstCall.args;
    assert.deepStrictEqual(JSON.parse(payload).paths, ['user.id-1']);
  });

  it('notifies per-path mutations for a PUT', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.PUT;
    const req = createReq({ params: { id: 'id-1' }, body: [{ path: 'name', value: 'new-name' }] });

    route._checkBasedPathLambda(req);

    const [, payload] = route._nrp.emit.firstCall.args;
    const parsed = JSON.parse(payload);
    assert.deepStrictEqual(parsed.paths, ['user.id-1.name']);
    assert.deepStrictEqual(parsed.values, ['new-name']);
  });

  it('de-duplicates repeated paths before notifying', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.PUT;
    const req = createReq({
      params: { id: 'id-1' },
      body: [
        { path: 'name', value: 'a' },
        { path: 'name', value: 'b' },
      ],
    });

    route._checkBasedPathLambda(req);

    const [, payload] = route._nrp.emit.firstCall.args;
    assert.deepStrictEqual(JSON.parse(payload).paths, ['user.id-1.name']);
  });
});

describe('routes/Route:exec', () => {
  it('throws immediately when no _exec implementation is defined', async () => {
    const route = createRoute();
    route._exec = undefined;
    const authenticate = sinon.stub(route, '_authenticate');

    await assert.rejects(() => route.exec(createReq(), createRes()), /no exec function defined/);
    assert.strictEqual(authenticate.called, false);
  });

  it('runs the full pipeline in order for a non-stream result', async () => {
    const route = createRoute();
    const calls = [];
    sinon.stub(route, '_authenticate').callsFake(async () => calls.push('authenticate'));
    sinon.stub(route, '_validate').callsFake(async () => {
      calls.push('validate');
      return 'validated';
    });
    sinon.stub(route, '_exec').callsFake(async () => {
      calls.push('exec');
      return { name: 'test' };
    });
    sinon.stub(route, '_respond').callsFake(async () => calls.push('respond'));
    sinon.stub(route, '_logActivity').callsFake(async () => calls.push('logActivity'));
    sinon.stub(route, '_boardcastData').callsFake(async () => calls.push('boardcastData'));

    await route.exec(createReq(), createRes());

    assert.deepStrictEqual(calls, ['authenticate', 'validate', 'exec', 'respond', 'logActivity', 'boardcastData']);
  });

  it('pipes a Readable _exec result into PassThrough streams before responding/broadcasting', async () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    sinon.stub(route, '_authenticate').resolves();
    sinon.stub(route, '_validate').resolves();
    const stream = new Readable({ objectMode: true, read() {} });
    sinon.stub(route, '_exec').resolves(stream);
    const respond = sinon.stub(route, '_respond').resolves();
    sinon.stub(route, '_logActivity').resolves();
    const broadcastData = sinon.stub(route, '_boardcastData').resolves();

    const req = createReq();
    await route.exec(req, createRes());
    stream.push(null);

    assert.ok(respond.calledOnce);
    assert.ok(respond.firstCall.args[2] instanceof PassThrough, '_respond should receive a piped PassThrough stream');
    assert.ok(broadcastData.calledOnce);
    assert.ok(
      broadcastData.firstCall.args[2] instanceof PassThrough,
      '_boardcastData should receive a piped PassThrough stream',
    );
  });
});
