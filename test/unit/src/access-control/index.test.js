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

function createReq({ method = 'GET', authApp = null, authUser = null, body = {} } = {}) {
  return {
    method,
    body,
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
        assert.strictEqual(err.statusCode, 401);
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
        assert.match(err.message, /condition is not fulfilled/);
        return true;
      },
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
  it('queues and then removes an expiring policy, busting the policy cache', async () => {
    const clock = sinon.useFakeTimers(new Date('2025-06-01T00:00:00.000Z'));
    const instance = createInstance();
    const nrp = { emit: sinon.spy() };
    instance._nrp = nrp;

    const rm = sinon.stub().resolves();
    const setPolicyPropertiesById = sinon.stub().resolves();
    stubModelWith(
      new Map([
        [PolicySchemaModel, { rm }],
        [TokenSchemaModel, { setPolicyPropertiesById }],
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
    assert.deepStrictEqual(setPolicyPropertiesById.firstCall.args[1], {});
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
