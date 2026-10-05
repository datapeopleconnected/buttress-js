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

import AccessControlSingleton, { PolicyError } from '../../../../dist/access-control/index.js';
import Model from '../../../../dist/model/index.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';
import PolicySchemaModel from '../../../../dist/model/core/policy.js';
import AppSchemaModel from '../../../../dist/model/core/app.js';
import { isPolicyExpired } from '../../../../dist/access-control/helpers.js';
import Logging from '../../../../dist/helpers/logging.js';

// Only the instance is exported (module-level singleton); grab the class off it so each
// test gets a fresh, unshared instance instead of mutating shared access-control state.
const AccessControl = AccessControlSingleton.constructor;

const userSchema = {
  name: 'user',
  type: 'collection',
  properties: { name: { __type: 'string' }, email: { __type: 'string' } },
};

function createInstance({ coreSchema = [], schemas = {} } = {}) {
  const instance = new AccessControl();
  instance._coreSchema = coreSchema;
  instance._coreSchemaNames = coreSchema.map((s) => s.name);
  instance._schemas = schemas;
  return instance;
}

function createReq({ method = 'GET', authApp = null, authUser = null, body = {}, ip = undefined } = {}) {
  return {
    method,
    body,
    ip,
    context: {
      timer: { interval: 0, lapTime: 0 },
      id: 'req-1',
      authApp,
      authUser,
    },
  };
}

afterEach(() => {
  sinon.restore();
});

describe('access-control/AccessControl:__getOutcome', () => {
  it('rejects when the token has no policies at all', async () => {
    const instance = createInstance();
    await assert.rejects(
      () => instance.__getOutcome([], createReq(), 'user', 'app1'),
      (err) => {
        assert.ok(err instanceof PolicyError);
        assert.strictEqual(err.status, 403);
        assert.strictEqual(err.code, 'access_denied');
        assert.match(err.message, /does not have any policy associated/);
        return true;
      },
    );
  });

  it('rejects when no policy config matches the request verb/schema', async () => {
    const instance = createInstance();
    const tokenPolicies = [
      {
        id: 'p1',
        name: 'test',
        priority: 1,
        env: null,
        config: [{ verbs: ['POST'], schema: ['user'], query: {}, projection: null, condition: null }],
      },
    ];

    await assert.rejects(
      () => instance.__getOutcome(tokenPolicies, createReq({ method: 'GET' }), 'user', 'app1'),
      (err) => {
        assert.ok(err instanceof PolicyError);
        assert.strictEqual(err.status, 403);
        assert.strictEqual(err.code, 'access_denied');
        assert.match(err.message, /does not have any policy rules matching the request verb GET/);
        return true;
      },
    );
  });

  it('rejects when the schema does not exist for the app', async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [] } });
    const tokenPolicies = [
      {
        id: 'p1',
        name: 'test',
        priority: 1,
        env: null,
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null }],
      },
    ];

    await assert.rejects(
      () => instance.__getOutcome(tokenPolicies, createReq(), 'user', 'app1'),
      (err) => {
        assert.ok(err instanceof PolicyError);
        assert.strictEqual(err.status, 404);
        assert.strictEqual(err.code, 'unknown_schema');
        assert.deepStrictEqual(err.details, { schema: 'user' });
        assert.match(err.message, /does not exist in the app/);
        return true;
      },
    );
  });

  it('rejects when the policy condition is not fulfilled', async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [userSchema] } });
    const tokenPolicies = [
      {
        id: 'p1',
        name: 'test',
        priority: 1,
        env: null,
        config: [
          {
            verbs: ['GET'],
            schema: ['user'],
            query: {},
            projection: null,
            condition: { '#env.appId': { '@eq': 'other-app' } },
          },
        ],
      },
    ];

    await assert.rejects(
      () => instance.__getOutcome(tokenPolicies, createReq(), 'user', 'app1'),
      (err) => {
        assert.ok(err instanceof PolicyError);
        assert.strictEqual(err.status, 403);
        assert.strictEqual(err.code, 'access_denied');
        assert.match(err.message, /condition is not fulfilled/);
        return true;
      },
    );
  });

  it("applies a policy whose condition names the requester's IP address only to requests from it", async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [userSchema] } });
    const tokenPolicies = [
      {
        id: 'p1',
        name: 'office-only',
        priority: 1,
        env: null,
        config: [
          {
            verbs: ['GET'],
            schema: ['user'],
            query: {},
            projection: null,
            condition: { '#env.ipAddress': { '@eq': '203.0.113.7' } },
          },
        ],
      },
    ];

    const outcome = await instance.__getOutcome(tokenPolicies, createReq({ ip: '203.0.113.7' }), 'user', 'app1');
    assert.deepStrictEqual(outcome[0].policies, ['office-only#0']);

    await assert.rejects(
      () => instance.__getOutcome(tokenPolicies, createReq({ ip: '198.51.100.1' }), 'user', 'app1'),
      /condition is not fulfilled/,
    );
  });

  it('rejects when the remaining policies deny access to the requested properties', async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [userSchema] } });
    const tokenPolicies = [
      {
        id: 'p1',
        name: 'test',
        priority: 1,
        env: null,
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name'] }, condition: null }],
      },
    ];
    const req = createReq({ body: { query: { email: { $eq: 'test@test.com' } } } });

    await assert.rejects(
      () => instance.__getOutcome(tokenPolicies, req, 'user', 'app1'),
      (err) => {
        assert.ok(err instanceof PolicyError);
        assert.strictEqual(err.status, 403);
        assert.strictEqual(err.code, 'property_access_denied');
        assert.match(err.message, /Can not access\/edit properties/);
        return true;
      },
    );
  });

  it('merges the queries of two otherwise-equivalent matching policies with $or', async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [userSchema] } });
    const tokenPolicies = [
      {
        id: 'p1',
        name: 'policy-one',
        priority: 1,
        env: null,
        config: [{ verbs: ['GET'], schema: ['user'], query: { a: 1 }, projection: null, condition: null }],
      },
      {
        id: 'p2',
        name: 'policy-two',
        priority: 2,
        env: null,
        config: [{ verbs: ['GET'], schema: ['user'], query: { b: 2 }, projection: null, condition: null }],
      },
    ];

    const outcome = await instance.__getOutcome(tokenPolicies, createReq(), 'user', 'app1');

    assert.strictEqual(outcome.length, 1, 'matching policies with null projection should merge into one config');
    assert.deepStrictEqual(outcome[0].query, { $or: [{ a: 1 }, { b: 2 }] });
    assert.deepStrictEqual(outcome[0].policies, ['policy-one#0', 'policy-two#0']);
  });

  it('unions the projected keys of two matching policies that share the same query', async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [userSchema] } });
    const tokenPolicies = [
      {
        id: 'p1',
        name: 'policy-one',
        priority: 1,
        env: null,
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name'] }, condition: null }],
      },
      {
        id: 'p2',
        name: 'policy-two',
        priority: 2,
        env: null,
        config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['email'] }, condition: null }],
      },
    ];

    const outcome = await instance.__getOutcome(tokenPolicies, createReq(), 'user', 'app1');

    assert.strictEqual(outcome.length, 1, 'same-query policies should merge into one config');
    assert.deepStrictEqual(outcome[0].projection, { name: 1, email: 1 });
  });
});

describe('access-control/AccessControl:__getOutcome merging (BUG-17)', () => {
  const policy = (name, config) => ({
    id: `id-${name}`,
    name,
    priority: 1,
    env: null,
    config: [{ verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null, ...config }],
  });

  it("doesn't narrow a policy that reads every property by one with the same query that reads some", async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [userSchema] } });
    const tokenPolicies = [policy('names', { projection: { keys: ['name'] } }), policy('everything', {})];

    const outcome = await instance.__getOutcome(tokenPolicies, createReq(), 'user', 'app1');

    assert.strictEqual(outcome.length, 1);
    assert.ok(!outcome[0].projection, `projected ${JSON.stringify(outcome[0].projection)}`);
  });

  it('merges policies whatever other verbs their configs are for', async () => {
    const instance = createInstance({ coreSchema: [], schemas: { app1: [userSchema] } });
    const tokenPolicies = [policy('a', { query: { a: 1 } }), policy('b', { query: { b: 2 }, verbs: ['GET', 'SEARCH'] })];

    const outcome = await instance.__getOutcome(tokenPolicies, createReq(), 'user', 'app1');

    assert.strictEqual(outcome.length, 1);
    assert.deepStrictEqual(outcome[0].query, { $or: [{ a: 1 }, { b: 2 }] });
  });
});

describe('access-control/AccessControl:accessControlPolicyMiddleware', () => {
  it("refuses a token whose app no longer exists, rather than failing the request", async () => {
    sinon.stub(Model, 'getCoreModel').callsFake((model) => {
      if (model === TokenSchemaModel) return { Constants: { Type: { SYSTEM: 'system' } } };
      if (model === AppSchemaModel) return { findById: async () => null };
      throw new Error(`Unexpected model requested in test: ${model?.name}`);
    });
    sinon.stub(Logging, 'logError');
    const instance = createInstance({ coreSchema: [userSchema] });
    const req = createReq();
    req.originalUrl = '/api/v1/car';
    req.context.timings = {};
    req.context.token = { id: 'token-1', type: 'user', _appId: 'app-gone' };
    const res = { status: sinon.stub(), send: sinon.stub(), json: sinon.stub() };
    const next = sinon.spy();

    await instance.accessControlPolicyMiddleware(req, res, next);

    // The error handler answers it
    assert.ok(next.calledOnce);
    const [err] = next.firstCall.args;
    assert.ok(err instanceof PolicyError, `passed on ${err}`);
    assert.strictEqual(err.status, 401);
    assert.deepStrictEqual(err.toBody(), { code: 'app_not_found', message: "The token's app was not found" });
    assert.ok(res.status.notCalled);
  });
});

describe('access-control/AccessControl:__getInnerObjectValue', () => {
  it('returns null unchanged', () => {
    const instance = createInstance();
    assert.strictEqual(instance.__getInnerObjectValue(null), null);
  });

  it('strips the _schema key from the object', () => {
    const instance = createInstance();
    const result = instance.__getInnerObjectValue({ _schema: {}, name: 'test', age: 1 });
    assert.deepStrictEqual(result, { name: 'test', age: 1 });
  });
});

function stubModelWith(map) {
  return sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    const fake = map.get(modelClass);
    if (!fake) throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
    return fake;
  });
}

describe('access-control/AccessControl:_queuePolicyLimitDeleteEvent', () => {
  it('queues a policy whose limit came from the cache as a string, without throwing', async () => {
    sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    instance._nrp = { emit: sinon.spy() };
    stubModelWith(new Map());

    const policy = { id: 'policy-1', name: 'expiring', limit: '2025-06-03T00:00:00.000Z', selection: {} };
    assert.doesNotThrow(() => instance._queuePolicyLimitDeleteEvent([policy], { id: 'token-1', policyProperties: {} }, 'app1'));

    assert.strictEqual(instance._queuedLimitedPolicy.length, 1);
  });

  it('queues two policies with the same name but different ids', async () => {
    sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    instance._nrp = { emit: sinon.spy() };
    stubModelWith(new Map());

    const limit = new Date('2025-06-03T00:00:00.000Z');
    instance._queuePolicyLimitDeleteEvent(
      [{ id: 'policy-1', name: 'same', limit, selection: {} }, { id: 'policy-2', name: 'same', limit, selection: {} }],
      { id: 'token-1', policyProperties: {} },
      'app1',
    );

    assert.strictEqual(instance._queuedLimitedPolicy.length, 2);
  });

  it("removes every property an expiring policy's selection names, within @and and @or too", async () => {
    const clock = sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    instance._nrp = { emit: sinon.spy() };

    const setPolicyPropertiesById = sinon.stub().resolves();
    const findOne = sinon.stub().resolves({ id: 'token-1', policyProperties: { role: 'admin', team: 'red', grade: 3 } });
    stubModelWith(
      new Map([
        [PolicySchemaModel, { rm: sinon.stub().resolves() }],
        [TokenSchemaModel, { setPolicyPropertiesById, findOne, createId: (v) => v }],
      ]),
    );

    const policy = {
      id: 'policy-2',
      name: 'expiring-or',
      limit: new Date('2025-06-03T00:00:00.000Z'),
      selection: { '@or': [{ role: { '@eq': 'admin' } }, { '@and': [{ team: { '@eq': 'red' } }] }] },
    };

    instance._queuePolicyLimitDeleteEvent([policy], { id: 'token-1' }, 'app1');
    await clock.tickAsync(2 * 24 * 60 * 60 * 1000 + 1000);

    assert.deepStrictEqual(setPolicyPropertiesById.firstCall.args[1], { grade: 3 });
    clock.restore();
  });

  it("leaves a token the properties of an expiring policy's @or branches that didn't select it", async () => {
    const clock = sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    instance._nrp = { emit: sinon.spy() };

    const setPolicyPropertiesById = sinon.stub().resolves();
    const findOne = sinon.stub().resolves({ id: 'token-1', policyProperties: { role: 'admin', team: 'blue', grade: 3 } });
    stubModelWith(
      new Map([
        [PolicySchemaModel, { rm: sinon.stub().resolves() }],
        [TokenSchemaModel, { setPolicyPropertiesById, findOne, createId: (v) => v }],
      ]),
    );

    const policy = {
      id: 'policy-3',
      name: 'expiring-or',
      limit: new Date('2025-06-03T00:00:00.000Z'),
      selection: { '@or': [{ role: { '@eq': 'admin' } }, { team: { '@eq': 'red' } }] },
    };

    instance._queuePolicyLimitDeleteEvent([policy], { id: 'token-1' }, 'app1');
    await clock.tickAsync(2 * 24 * 60 * 60 * 1000 + 1000);

    assert.deepStrictEqual(setPolicyPropertiesById.firstCall.args[1], { team: 'blue', grade: 3 });
    clock.restore();
  });

  it('queues and then removes an expiring policy, busting the policy cache', async () => {
    const clock = sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    const nrp = { emit: sinon.spy() };
    instance._nrp = nrp;

    const rm = sinon.stub().resolves();
    const setPolicyPropertiesById = sinon.stub().resolves();
    // The token as stored when the limit is reached, which has gained a property since the request
    const findOne = sinon.stub().resolves({ id: 'token-1', policyProperties: { role: 'admin', team: 'red' } });
    stubModelWith(
      new Map([
        [PolicySchemaModel, { rm }],
        [TokenSchemaModel, { setPolicyPropertiesById, findOne, createId: (v) => v }],
      ]),
    );

    const policy = {
      id: 'policy-1',
      name: 'expiring',
      limit: new Date('2025-06-03T00:00:00.000Z'),
      selection: { role: {} },
    };
    const userToken = { id: 'token-1', policyProperties: { role: 'admin' } };

    instance._queuePolicyLimitDeleteEvent([policy], userToken, 'app1');
    assert.strictEqual(instance._queuedLimitedPolicy.length, 1);

    await clock.tickAsync(2 * 24 * 60 * 60 * 1000 + 1000);

    assert.ok(rm.calledWith('policy-1'));
    assert.ok(nrp.emit.calledWith('app-policy:bust-cache'));
    assert.deepStrictEqual(setPolicyPropertiesById.firstCall.args[1], { team: 'red' });
    assert.strictEqual(instance._queuedLimitedPolicy.length, 0, 'the queue entry should be cleared after it fires');

    clock.restore();
  });

  it('does not queue the same limited policy twice while it is already pending', async () => {
    sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    instance._nrp = { emit: sinon.spy() };
    stubModelWith(new Map());

    const policy = { id: 'policy-1', name: 'expiring', limit: new Date('2025-06-03T00:00:00.000Z'), selection: {} };
    const userToken = { id: 'token-1', policyProperties: {} };

    instance._queuePolicyLimitDeleteEvent([policy], userToken, 'app1');
    instance._queuePolicyLimitDeleteEvent([policy], userToken, 'app1');

    assert.strictEqual(instance._queuedLimitedPolicy.length, 1);
  });

  it('does not queue a policy whose limit is more than a week away', async () => {
    sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    instance._nrp = { emit: sinon.spy() };
    stubModelWith(new Map());

    const policy = { id: 'policy-1', name: 'far-future', limit: new Date('2025-12-01T00:00:00.000Z'), selection: {} };
    instance._queuePolicyLimitDeleteEvent([policy], { id: 'token-1', policyProperties: {} }, 'app1');

    assert.strictEqual(instance._queuedLimitedPolicy.length, 0);
  });

  it('ignores policies without a valid limit', () => {
    const instance = createInstance();
    instance._nrp = { emit: sinon.spy() };

    instance._queuePolicyLimitDeleteEvent(
      [{ id: 'policy-1', name: 'no-limit', selection: {} }],
      { id: 'token-1', policyProperties: {} },
      'app1',
    );

    assert.strictEqual(instance._queuedLimitedPolicy.length, 0);
  });
});

describe('access-control/helpers:isPolicyExpired', () => {
  it('is true only for a policy whose limit, as a Date or a string, has passed', () => {
    const now = new Date('2025-06-01T00:00:00.000Z');

    assert.strictEqual(isPolicyExpired({ limit: new Date('2025-05-31T00:00:00.000Z') }, now), true);
    assert.strictEqual(isPolicyExpired({ limit: '2025-05-31T00:00:00.000Z' }, now), true);
    assert.strictEqual(isPolicyExpired({ limit: '2025-06-02T00:00:00.000Z' }, now), false);
    assert.strictEqual(isPolicyExpired({ limit: null }, now), false);
    assert.strictEqual(isPolicyExpired({}, now), false);
  });
});
