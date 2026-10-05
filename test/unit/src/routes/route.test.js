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
import PolicySchemaModel from '../../../../dist/model/core/policy.js';
import AppSchemaModel from '../../../../dist/model/core/app.js';

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

// A schema can keep a property out of every response (D-24)
describe('routes/Route:_respond private properties', () => {
  const schema = {
    name: 'user',
    type: 'collection',
    properties: {
      name: { __type: 'string' },
      auth: { __type: 'array', __schema: { app: { __type: 'string' }, password: { __type: 'string', __private: true } } },
    },
  };
  const stored = () => ({ id: 'u1', name: 'a', auth: [{ app: 'google', password: 'secret' }] });

  for (const redactResults of [true, false]) {
    it(`leaves them out of a result${redactResults ? '' : ', when results are not redacted'}`, async () => {
      const route = createRoute({ schema });
      route.redactResults = redactResults;
      route.addSourceId = false;
      const res = createRes();

      await route._respond(createReq(), res, stored());

      assert.deepStrictEqual(res.json.firstCall.args[0], { id: 'u1', name: 'a', auth: [{ app: 'google' }] });
    });
  }

  it('leaves them out of each entity of a stream', async () => {
    const route = createRoute({ schema });
    route.addSourceId = false;
    const out = new PassThrough();
    let body = '';
    out.on('data', (chunk) => (body += chunk));
    const res = Object.assign(out, { statusCode: 200, set: sinon.stub() });
    const finished = new Promise((resolve) => out.on('end', resolve));

    await route._respond(createReq(), res, Readable.from([stored(), stored()]));
    await finished;

    assert.deepStrictEqual(JSON.parse(body), [
      { id: 'u1', name: 'a', auth: [{ app: 'google' }] },
      { id: 'u1', name: 'a', auth: [{ app: 'google' }] },
    ]);
  });
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
  it("rejects with 400 when ?apiPath= names an app other than the token's", async () => {
    const route = createRoute();
    const req = createReq({ token: { type: 'system' }, authApp: { id: 'app-1', apiPath: 'super-app' } });
    req.query = { apiPath: 'customer-app' };

    await assert.rejects(
      () => route._authenticate(req, createRes()),
      (err) => {
        assert.strictEqual(err.status, 400);
        assert.deepStrictEqual(err.toBody(), {
          code: 'apiPath_not_supported',
          message: 'Requests act on the app of the token (super-app)',
          details: { apiPath: 'super-app' },
        });
        return true;
      },
    );
  });

  it('rejects with 400 when ?apiPath= is given more than once, even naming the token\'s own app', async () => {
    const route = createRoute();
    for (const apiPath of [['customer-app', 'other-app'], ['customer-app', 'customer-app']]) {
      const req = createReq({ token: { type: 'app' }, authApp: { id: 'app-1', apiPath: 'customer-app' } });
      req.query = { apiPath };

      await assert.rejects(
        () => route._authenticate(req, createRes()),
        (err) => err.status === 400 && err.code === 'apiPath_not_supported',
      );
    }
  });

  it("allows ?apiPath= naming the token's own app", async () => {
    const route = createRoute();
    const req = createReq({ token: { type: 'app' }, authApp: { id: 'app-1', apiPath: 'customer-app' } });
    req.query = { apiPath: 'customer-app' };

    await route._authenticate(req, createRes());
  });

  it('rejects with 401 when there is no token', async () => {
    const route = createRoute();
    const req = createReq({ token: null });

    await assert.rejects(
      () => route._authenticate(req, createRes()),
      (err) => {
        assert.strictEqual(err.status, 401);
        assert.strictEqual(err.code, 'missing_token');
        return true;
      },
    );
  });

  it('rejects with 403 when the token type has insufficient authority', async () => {
    const route = createRoute();
    route.authType = Route.Constants.Type.SYSTEM;
    const req = createReq({ token: { type: 'user' } });

    await assert.rejects(
      () => route._authenticate(req, createRes()),
      (err) => {
        assert.strictEqual(err.status, 403);
        assert.strictEqual(err.code, 'insufficient_authority');
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

  it("refuses a token from another app on an app's route, other than a system token", async () => {
    const route = createRoute({ app: { id: 'app-2' } });

    for (const type of ['app', 'user', 'lambda', 'dataSharing']) {
      const req = createReq({ token: { type }, authApp: { id: 'app-1' } });
      await assert.rejects(
        () => route._authenticate(req, createRes()),
        (err) => err.status === 403 && err.code === 'insufficient_authority',
        type,
      );
    }

    const req = createReq({ token: { type: 'system' }, authApp: { id: 'app-1' } });
    assert.strictEqual((await route._authenticate(req, createRes())).type, 'system');
  });

  it("allows another app's token on a core route, which has no app", async () => {
    const route = createRoute({ app: null });
    const req = createReq({ token: { type: 'app' }, authApp: { id: 'app-1' } });

    assert.strictEqual((await route._authenticate(req, createRes())).type, 'app');
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
    const route = createRoute({ app: null });
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
    const route = createRoute({ app: null });
    route.verb = Route.Constants.Verbs.POST;
    const broadcast = sinon.stub(route, '_broadcast').resolves();
    sinon.stub(route, '_checkBasedPathLambda').resolves();
    const req = createReq({ path: '/api/v1/user', authApp: { id: 'app-1', apiPath: 'api' } });

    await route._boardcastData(req, createRes(), {});

    assert.strictEqual(broadcast.firstCall.args[3], '/v1/user');
  });

  it("strips the api path of an app route's own app, whoever's token it is", async () => {
    const route = createRoute({ app: { id: 'app-1', apiPath: 'app-one' } });
    route.verb = Route.Constants.Verbs.POST;
    const broadcast = sinon.stub(route, '_broadcast').resolves();
    sinon.stub(route, '_checkBasedPathLambda').resolves();
    const req = createReq({
      path: '/app-one/api/v1/car',
      token: { type: 'system' },
      authApp: { id: 'super-app', apiPath: 'bjs' },
    });

    await route._boardcastData(req, createRes(), {});

    assert.strictEqual(broadcast.firstCall.args[3], '/car');
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

  it('sends the entities a delete removed with the scoped activity only, for the SPR to check', () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp });
    route.activityBroadcast = true;
    route.verb = Route.Constants.Verbs.DEL;
    const req = createReq({ method: 'DELETE', path: '/api/v1/user/doc-1', params: { id: 'doc-1' } });
    req.context.deletedEntities = [{ id: 'doc-1', ownerId: 'user-1' }];

    route._broadcast(req, createRes(), true, '/user/doc-1', true);
    route._broadcast(req, createRes(), true, '/user/doc-1');

    const [superActivity, scopedActivity] = nrp.emit.getCalls().map((call) => JSON.parse(call.args[1]));
    assert.strictEqual('deletedEntities' in superActivity, false);
    assert.deepStrictEqual(scopedActivity.deletedEntities, [{ id: 'doc-1', ownerId: 'user-1' }]);
    assert.strictEqual(scopedActivity.response, true);
  });

  it('names the agreement a write to a partner\'s record went through, on both activities, for the SPR to find it', () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp });
    route.activityBroadcast = true;
    route.verb = Route.Constants.Verbs.PUT;
    const req = createReq({ method: 'PUT', path: '/api/v1/car/car-1', params: { id: 'car-1' } });
    req.context.dataShareId = 'agreement-1';

    route._broadcast(req, createRes(), [{ type: 'scalar', path: 'name', value: 'x' }], '/car/car-1', true);
    route._broadcast(req, createRes(), [{ type: 'scalar', path: 'name', value: 'x' }], '/car/car-1');

    const activities = nrp.emit.getCalls().map((call) => JSON.parse(call.args[1]));
    assert.deepStrictEqual(activities.map((activity) => activity.dataShareId), ['agreement-1', 'agreement-1']);
  });

  it("leaves the agreement off an activity for the app's own records", () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp });
    route.activityBroadcast = true;
    route.verb = Route.Constants.Verbs.POST;

    route._broadcast(createReq(), createRes(), { name: 'test' }, '/car');

    const activity = JSON.parse(nrp.emit.firstCall.args[1]);
    assert.deepStrictEqual(['dataShareId' in activity, 'dataShareIds' in activity], [false, false]);
  });

  // A super or system token can call an app's schema routes, and the data it changes is that app's.
  it("names an app route's own app on the activity and the entity's sourceId, whoever's token it is", () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp, app: { id: 'app-1', apiPath: 'app-one' } });
    route.activityBroadcast = true;
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({ token: { type: 'system' }, authApp: { id: 'super-app', apiPath: 'bjs' } });

    route._broadcast(req, createRes(), { name: 'car-1' }, '/car');

    const activity = JSON.parse(nrp.emit.firstCall.args[1]);
    assert.deepStrictEqual([activity.appId, activity.appAPIPath], ['app-1', 'app-one']);
    assert.strictEqual(activity.response.sourceId, 'app-1');
  });

  it("names the token's app on a core route's activity", () => {
    const nrp = createNrpFake();
    const route = createRoute({ nrp, app: null });
    route.activityBroadcast = true;
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({ authApp: { id: 'app-1', apiPath: 'app-one' } });

    route._broadcast(req, createRes(), { name: 'user-1' }, '/user');

    const activity = JSON.parse(nrp.emit.firstCall.args[1]);
    assert.deepStrictEqual([activity.appId, activity.appAPIPath], ['app-1', 'app-one']);
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

// A message that can't be published is logged: the request has done its work, and a rejection left unhandled would
// end the process
describe('routes/Route: a message that cannot be published', () => {
  const unhandledDuring = async (run) => {
    const seen = [];
    const record = (err) => seen.push(err);
    process.on('unhandledRejection', record);
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', record);
    }
    return seen;
  };
  const failingNrp = () => ({ on: () => {}, emit: sinon.stub().rejects(new Error('redis is down')) });

  it("doesn't leave the activity broadcast's rejection unhandled", async () => {
    const route = createRoute({ app: null, nrp: failingNrp() });
    route.verb = Route.Constants.Verbs.POST;
    route.activityBroadcast = true;
    sinon.stub(route, '_checkBasedPathLambda').resolves();
    const logged = sinon.stub(Logging, 'logError');

    const unhandled = await unhandledDuring(() => route._boardcastData(createReq(), createRes(), { name: 'test' }));

    assert.deepStrictEqual(unhandled, []);
    assert.ok(logged.called);
  });

  it("doesn't leave a notification's rejection unhandled", async () => {
    const route = createRoute({ nrp: failingNrp() });
    sinon.stub(Logging, 'logError');

    const unhandled = await unhandledDuring(async () => route._notify('app-routes:bust-cache', '{}'));

    assert.deepStrictEqual(unhandled, []);
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

  it('leaves out bulk update items that were refused, since they changed nothing', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      pathSpec: '/api/v1/user/bulk/update',
      body: [
        { id: 'id-1', body: [{ path: 'name', value: 'a' }], validation: true },
        { id: 'id-2', body: [{ path: 'name', value: 'b' }], validation: { code: 400, message: 'refused' } },
      ],
    });

    route._checkBasedPathLambda(req);

    const parsed = JSON.parse(route._nrp.emit.firstCall.args[1]);
    assert.deepStrictEqual(parsed.paths, ['user.id-1.name']);
    assert.deepStrictEqual(parsed.values, ['a']);
  });

  it('notifies nothing when every bulk update item was refused', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      pathSpec: '/api/v1/user/bulk/update',
      body: [{ id: 'id-1', body: [{ path: 'name', value: 'a' }], validation: { code: 400, message: 'refused' } }],
    });

    route._checkBasedPathLambda(req);

    assert.strictEqual(route._nrp.emit.called, false);
  });

  it('sends one value per path for a bulk update item with several updates', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      pathSpec: '/api/v1/user/bulk/update',
      body: [
        {
          id: 'id-1',
          body: [
            { path: 'name', value: 'a' },
            { path: 'age', value: 3 },
          ],
        },
      ],
    });

    route._checkBasedPathLambda(req);

    const parsed = JSON.parse(route._nrp.emit.firstCall.args[1]);
    assert.deepStrictEqual(parsed.paths, ['user.id-1.name', 'user.id-1.age']);
    assert.deepStrictEqual(parsed.values, ['a', 3]);
  });

  it("names the route's app as the owner of the change, whichever app's token made it", () => {
    const route = createRoute({ app: { id: 'route-app' } });
    route.verb = Route.Constants.Verbs.PUT;
    const req = createReq({ params: { id: 'id-1' }, body: [{ path: 'name', value: 'a' }], authApp: { id: 'token-app' } });

    route._checkBasedPathLambda(req);

    assert.strictEqual(JSON.parse(route._nrp.emit.firstCall.args[1]).appId, 'route-app');
  });

  it("names the requesting app as the owner of a change to a core schema, whose routes have no app", () => {
    const route = createRoute({ app: null });
    route.verb = Route.Constants.Verbs.PUT;
    const req = createReq({ params: { id: 'id-1' }, body: [{ path: 'name', value: 'a' }], authApp: { id: 'token-app' } });

    route._checkBasedPathLambda(req);

    assert.strictEqual(JSON.parse(route._nrp.emit.firstCall.args[1]).appId, 'token-app');
  });

  it('sends each change to the app that owns the record it names, and the rest to the requesting app', () => {
    const route = createRoute({ schema: { name: 'policy' }, app: null });
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      pathSpec: 'policy/bulk/update',
      authApp: { id: 'super-app' },
      body: [
        { id: 'policy-1', body: { path: 'name', value: 'a' } },
        { id: 'policy-2', body: { path: 'name', value: 'b' } },
        { id: 'policy-3', body: { path: 'name', value: 'c' } },
      ],
    });
    req.context.changeOwners = new Map([
      ['policy-1', 'app-a'],
      ['policy-2', 'app-b'],
    ]);

    route._checkBasedPathLambda(req);

    assert.deepStrictEqual(
      route._nrp.emit.getCalls().map((call) => JSON.parse(call.args[1])),
      [
        { paths: ['policy.policy-1.name'], values: ['a'], collection: 'policy', appId: 'app-a' },
        { paths: ['policy.policy-2.name'], values: ['b'], collection: 'policy', appId: 'app-b' },
        { paths: ['policy.policy-3.name'], values: ['c'], collection: 'policy', appId: 'super-app' },
      ],
    );
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

  it('keeps values lined up with paths when a path repeats, with the last value written to it', () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.PUT;
    const req = createReq({
      params: { id: 'id-1' },
      body: [
        { path: 'name', value: 'a' },
        { path: 'age', value: 3 },
        { path: 'name', value: 'b' },
      ],
    });

    route._checkBasedPathLambda(req);

    const parsed = JSON.parse(route._nrp.emit.firstCall.args[1]);
    assert.deepStrictEqual(parsed.paths, ['user.id-1.name', 'user.id-1.age']);
    assert.deepStrictEqual(parsed.values, ['b', 3]);
  });
});

describe('routes/Route:_findChangeOwners', () => {
  // A core model whose records belong to the apps in `owners` (record id -> app id), and whose ids don't start with "x"
  const stubCoreModel = (owners) => {
    const model = {
      createId: (id) => id,
      isValidId: (id) => !String(id).startsWith('x'),
      find: sinon.spy(async ({ _id }) =>
        Readable.from(_id.$in.filter((id) => owners[id]).map((id) => ({ id, _appId: owners[id] }))),
      ),
      findOne: sinon.spy(async ({ _id }) => (owners[_id] ? { id: _id, _appId: owners[_id] } : null)),
    };
    sinon.stub(Model, 'getCoreModelBySchemaName').returns(model);
    return model;
  };

  it("takes an app record's owner from its own id, without a lookup", async () => {
    const lookup = stubCoreModel({});
    const route = createRoute({ schema: { name: 'apps' }, app: null });
    route.verb = Route.Constants.Verbs.PUT;

    const owners = await route._findChangeOwners(createReq({ params: { id: 'app-x' } }));

    assert.deepStrictEqual([...owners], [['app-x', 'app-x']]);
    assert.strictEqual(lookup.find.called || lookup.findOne.called, false);
  });

  it('looks up the app that owns any other core record', async () => {
    stubCoreModel({ 'user-1': 'app-y' });
    const route = createRoute({ schema: { name: 'users' }, app: null });
    route.verb = Route.Constants.Verbs.DEL;

    const owners = await route._findChangeOwners(createReq({ params: { id: 'user-1' } }));

    assert.deepStrictEqual([...owners], [['user-1', 'app-y']]);
  });

  it('finds the owner of each item of a core bulk update, and skips records it cannot find', async () => {
    stubCoreModel({ 'policy-1': 'app-a', 'policy-2': 'app-b' });
    const route = createRoute({ schema: { name: 'policy' }, app: null });
    route.verb = Route.Constants.Verbs.POST;
    const req = createReq({
      pathSpec: 'policy/bulk/update',
      body: [
        { id: 'policy-1', body: { path: 'name', value: 'a' } },
        { id: 'policy-2', body: { path: 'name', value: 'b' } },
        { id: 'policy-9', body: { path: 'name', value: 'c' } },
      ],
    });

    const owners = await route._findChangeOwners(req);

    assert.deepStrictEqual(
      [...owners],
      [
        ['policy-1', 'app-a'],
        ['policy-2', 'app-b'],
      ],
    );
  });

  it('looks the records of a core bulk update up at once, and skips ids that are not ids', async () => {
    const model = stubCoreModel({ 'policy-1': 'app-a', 'policy-2': 'app-b' });
    const route = createRoute({ schema: { name: 'policy' }, app: null });
    route.verb = Route.Constants.Verbs.POST;
    const ids = ['policy-1', 'policy-2', 'x-not-an-id', 'policy-3', 'policy-4'];
    const req = createReq({ pathSpec: 'policy/bulk/update', body: ids.map((id) => ({ id, body: { path: 'name', value: 'a' } })) });

    const owners = await route._findChangeOwners(req);

    assert.strictEqual(model.find.callCount, 1);
    assert.strictEqual(model.findOne.called, false);
    assert.deepStrictEqual(model.find.firstCall.args[0], { _id: { $in: ['policy-1', 'policy-2', 'policy-3', 'policy-4'] } });
    assert.deepStrictEqual([...owners], [['policy-1', 'app-a'], ['policy-2', 'app-b']]);
  });

  it("looks nothing up for a schema route, whose data belongs to the route's app", async () => {
    const lookup = stubCoreModel({});
    const route = createRoute({ schema: { name: 'car' }, app: { id: 'app-1' } });
    route.verb = Route.Constants.Verbs.PUT;

    const owners = await route._findChangeOwners(createReq({ params: { id: 'car-1' } }));

    assert.strictEqual(owners, undefined);
    assert.strictEqual(lookup.find.called || lookup.findOne.called, false);
  });
});

describe('routes/Route:exec', () => {
  it("logs each request's end with its own timer, when two run at once on the route", async () => {
    const route = createRoute();
    sinon.stub(route, '_authenticate').resolves();
    sinon.stub(route, '_validate').resolves();
    sinon.stub(route, '_findChangeOwners').resolves(new Map());
    const release = {};
    sinon.stub(route, '_exec').callsFake((req) => new Promise((resolve) => (release[req.context.id] = () => resolve({}))));
    sinon.stub(route, '_respond').resolves();
    sinon.stub(route, '_logActivity').resolves();
    sinon.stub(route, '_boardcastData').resolves();
    const logTimer = sinon.stub(Logging, 'logTimer');
    const first = createReq();
    const second = createReq();
    second.context.id = 'req-2';
    second.context.timer = { interval: 1, lapTime: 1 };

    const running = [route.exec(first, createRes()), route.exec(second, createRes())];
    await new Promise((resolve) => setImmediate(resolve));
    release['req-1']();
    release['req-2']();
    await Promise.all(running);

    const ends = logTimer.getCalls().filter((call) => String(call.args[0]).startsWith('Route:exec:end '));
    assert.deepStrictEqual(ends.map((call) => [call.args[3], call.args[1]]), [
      ['req-1', first.context.timer],
      ['req-2', second.context.timer],
    ]);
  });

  it('finds the owners of the records it will change after validating and before changing them', async () => {
    const route = createRoute();
    const calls = [];
    const owners = new Map([['id-1', 'app-2']]);
    sinon.stub(route, '_authenticate').resolves();
    sinon.stub(route, '_validate').callsFake(async () => calls.push('validate'));
    sinon.stub(route, '_findChangeOwners').callsFake(async () => {
      calls.push('findChangeOwners');
      return owners;
    });
    const req = createReq();
    sinon.stub(route, '_exec').callsFake(async () => {
      calls.push('exec');
      assert.strictEqual(req.context.changeOwners, owners);
      return {};
    });
    sinon.stub(route, '_respond').resolves();
    sinon.stub(route, '_logActivity').resolves();
    sinon.stub(route, '_boardcastData').resolves();

    await route.exec(req, createRes());

    assert.deepStrictEqual(calls, ['validate', 'findChangeOwners', 'exec']);
  });

  it('throws immediately when no _exec implementation is defined', async () => {
    const route = createRoute();
    route._exec = undefined;
    const authenticate = sinon.stub(route, '_authenticate');

    await assert.rejects(() => route.exec(createReq(), createRes()), (err) => {
      assert.strictEqual(err.status, 500);
      assert.match(err.cause, /no exec function defined/);
      return true;
    });
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

  it('gives the error of a result stream that fails after exec has returned to next, and stops its streams', async () => {
    const route = createRoute();
    route.verb = Route.Constants.Verbs.POST;
    sinon.stub(route, '_authenticate').resolves();
    sinon.stub(route, '_validate').resolves();
    const stream = new Readable({ objectMode: true, read() {} });
    sinon.stub(route, '_exec').resolves(stream);
    const respond = sinon.stub(route, '_respond').resolves();
    sinon.stub(route, '_logActivity').resolves();
    const broadcastData = sinon.stub(route, '_boardcastData').resolves();
    const next = sinon.spy();

    await route.exec(createReq(), createRes(), next);
    const err = new Error('$in needs an array');
    // Without a listener the error would be thrown here.
    stream.destroy(err);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(next.calledOnceWithExactly(err));
    assert.ok(respond.firstCall.args[2].destroyed, 'the response stream should be destroyed');
    assert.ok(broadcastData.firstCall.args[2].destroyed, 'the broadcast stream should be destroyed');
  });

  it('fails a streamed response that has not started through the error handler, without responding itself', async () => {
    const route = createRoute();
    route.redactResults = false;
    sinon.stub(route, '_authenticate').resolves();
    sinon.stub(route, '_validate').resolves();
    const stream = new Readable({ objectMode: true, read() {} });
    sinon.stub(route, '_exec').resolves(stream);
    sinon.stub(route, '_logActivity').resolves();
    sinon.stub(route, '_boardcastData').resolves();
    const res = Object.assign(new PassThrough(), { headersSent: false, set: sinon.stub(), json: sinon.stub() });
    const written = [];
    res.on('data', (chunk) => written.push(chunk.toString()));
    const next = sinon.spy();

    await route.exec(createReq(), res, next);
    stream.destroy(new Error('$in needs an array'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(next.calledOnce);
    assert.deepStrictEqual(written, [], 'nothing should be written before the error handler responds');
    assert.strictEqual(res.writableEnded, false, 'the response should be left for the error handler');
  });
});

describe('routes/Route:_respond Server-Timing', () => {
  const createTimedReq = () => {
    const req = createReq();
    req.context.timer.interval = 0.01;
    Object.assign(req.context.timings, {
      authenticateToken: 0,
      accessControl: 0.001,
      configCrossDomain: 0.002,
      validate: 0.003,
      exec: 0.004,
    });
    return req;
  };

  it('sets the header before responding when server timing is on', async () => {
    const route = createRoute();
    route.redactResults = false;
    route.serverTiming = true;
    const res = createRes();

    await route._respond(createTimedReq(), res, { name: 'test' });

    assert.ok(
      res.set.calledWith(
        'Server-Timing',
        'auth;dur=1.000;desc="token", ac;dur=1.000;desc="access control", validate;dur=1.000, exec;dur=6.000, ' +
          'total;dur=10.000;desc="until response"',
      ),
    );
    assert.ok(res.set.calledBefore(res.json));
  });

  it('leaves the header off by default', async () => {
    const route = createRoute();
    route.redactResults = false;
    const res = createRes();

    await route._respond(createTimedReq(), res, { name: 'test' });

    assert.strictEqual(route.serverTiming, false);
    assert.ok(res.set.neverCalledWith('Server-Timing'));
    assert.ok(res.json.calledOnce);
  });
});

describe('routes/Route:scoped', () => {
  const policies = { name: 'policies' };
  const apps = { name: 'apps' };
  beforeEach(() => {
    Model.getCoreModel.restore();
    const models = {
      [ActivitySchemaModel.name]: { Constants: { Visibility: { PRIVATE: 'PRIVATE' } } },
      [PolicySchemaModel.name]: policies,
      [AppSchemaModel.name]: apps,
    };
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => models[modelClass.name]);
  });

  it("limits a core model to the caller's app", () => {
    const scoped = createRoute().scoped(createReq({ token: { type: 'app' }, authApp: { id: 'app-1' } }), PolicySchemaModel);

    assert.deepStrictEqual([scoped.tenant, scoped.clause], ['app-1', { _appId: 'app-1' }]);
  });

  it("limits the apps model to the caller's own app", () => {
    const scoped = createRoute().scoped(createReq({ token: { type: 'app' }, authApp: { id: 'app-1' } }), AppSchemaModel);

    assert.deepStrictEqual(scoped.clause, { id: 'app-1' });
  });

  it("doesn't limit a system token", () => {
    const scoped = createRoute().scoped(createReq({ token: { type: 'system' } }), PolicySchemaModel);

    assert.strictEqual(scoped.tenant, null);
  });

  // Authentication refuses a token without an app, so a route reached without one is a fault
  it('refuses a caller with no app as an internal error', () => {
    assert.throws(() => createRoute().scoped(createReq({ token: { type: 'app' }, authApp: null }), PolicySchemaModel), {
      status: 500,
      code: 'internal_error',
      cause: 'no_authenticated_app',
    });
  });

  it('gives the whole model only when asked for it by name, with a reason', () => {
    assert.strictEqual(createRoute().unscopedModel(PolicySchemaModel, 'reads every app for the test'), policies);
    assert.throws(() => createRoute().unscopedModel(PolicySchemaModel, ''), /reason/);
  });
});

