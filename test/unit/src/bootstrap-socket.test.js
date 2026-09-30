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
import { ObjectId } from 'bson';

import BootstrapSocket, { relayedDataShareActivity } from '../../../dist/bootstrap-socket.js';
import Logging from '../../../dist/helpers/logging.js';
import Model from '../../../dist/model/index.js';
import TokenSchemaModel from '../../../dist/model/core/token.js';
import AppSchemaModel from '../../../dist/model/core/app.js';

describe('bootstrap-socket:token authentication', () => {
  const app = { id: new ObjectId(), apiPath: 'app-one' };
  const token = { id: new ObjectId(), value: 'app-one-token', type: 'app', _appId: app.id };

  // The token values the connection handler looked up.
  let lookups;

  beforeEach(() => {
    lookups = [];
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass === TokenSchemaModel) {
        return {
          findOne: async (q) => {
            lookups.push(q.value);
            return q.value === token.value ? token : null;
          },
        };
      }
      if (modelClass === AppSchemaModel) return { findOne: async (q) => (app.id.equals(q.id) ? app : null) };
      throw new Error(`Unexpected core model ${modelClass.name}`);
    });
  });

  afterEach(() => sinon.restore());

  // Runs the namespace middleware for a socket connecting to /app-one with `auth` and `query` in its handshake.
  async function connect({ auth = {}, query = {} }) {
    const bootstrap = new BootstrapSocket();
    bootstrap.__nrp = { emit: sinon.spy() };

    const socket = { id: 'socket-1', nsp: { name: '/app-one' }, handshake: { auth, query }, data: {} };
    socket.join = sinon.spy();
    socket.on = () => {};

    const next = sinon.spy();
    await bootstrap._workerHandleSocketConnection(socket, next);
    return { socket, next };
  }

  it('refuses a token that is not a string, without looking it up', async () => {
    for (const value of [{ $ne: null }, { $regex: '.' }, ['app-one-token'], 42, true]) {
      const { next, socket } = await connect({ auth: { token: value } });

      assert.strictEqual(next.firstCall.args[0]?.message, 'invalid-token', `accepted ${JSON.stringify(value)}`);
      assert.ok(socket.join.notCalled);
    }

    assert.deepStrictEqual(lookups, []);
  });

  it('refuses a missing or empty token, without looking it up', async () => {
    for (const handshake of [{}, { query: { token: '' } }]) {
      const { next } = await connect(handshake);

      assert.strictEqual(next.firstCall.args[0]?.message, 'invalid-token', `accepted ${JSON.stringify(handshake)}`);
    }

    assert.deepStrictEqual(lookups, []);
  });

  it('accepts a token sent in auth', async () => {
    const { next, socket } = await connect({ auth: { token: 'app-one-token' } });

    assert.deepStrictEqual(next.firstCall.args, []);
    assert.ok(socket.join.calledOnceWith(token.id.toString()));
  });

  it('still accepts a token in the query string', async () => {
    const { next } = await connect({ query: { token: 'app-one-token' } });

    assert.deepStrictEqual(next.firstCall.args, []);
  });
});

describe('bootstrap-socket:namespace authentication', () => {
  const apps = [
    { id: new ObjectId(), apiPath: 'app-one' },
    { id: new ObjectId(), apiPath: 'app-two' },
  ];
  const tokens = [
    { id: new ObjectId(), value: 'app-one-token', type: 'app', _appId: apps[0].id },
    { id: new ObjectId(), value: 'system-token', type: 'system', _appId: apps[1].id },
  ];

  afterEach(() => sinon.restore());

  // Matches a token's value as Mongo would, operators included, so a query object finds a token.
  const matchesValue = (value, wanted) =>
    wanted !== null && typeof wanted === 'object' && '$ne' in wanted ? value !== wanted.$ne : value === wanted;

  // Runs the namespace middleware for a socket connecting to `namespace` with `token`, sent as `auth` or in the query.
  async function connect(namespace, token, { inQuery = false } = {}) {
    const bootstrap = new BootstrapSocket();
    bootstrap.__nrp = { emit: sinon.spy() };

    const lookups = [];
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass === TokenSchemaModel) {
        return {
          findOne: async (q) => {
            lookups.push(q.value);
            return tokens.find((t) => matchesValue(t.value, q.value)) || null;
          },
        };
      }
      if (modelClass === AppSchemaModel) return { findOne: async (q) => apps.find((a) => a.id.equals(q.id)) || null };
      throw new Error(`Unexpected core model ${modelClass.name}`);
    });

    const handshake = inQuery ? { auth: {}, query: { token } } : { auth: { token }, query: {} };
    const socket = { id: 'socket-1', nsp: { name: namespace }, handshake, data: {} };
    socket.join = sinon.spy();
    socket.on = () => {};

    const next = sinon.spy();
    await bootstrap._workerHandleSocketConnection(socket, next);
    return { socket, next, nrp: bootstrap.__nrp, lookups };
  }

  it("accepts a token on its own app's namespace", async () => {
    const { next, socket } = await connect('/app-one', 'app-one-token');

    assert.deepStrictEqual(next.firstCall.args, []);
    assert.ok(socket.join.calledOnce);
  });

  it("refuses a token on another app's namespace with invalid-namespace", async () => {
    const { next, socket, nrp } = await connect('/app-two', 'app-one-token');

    assert.strictEqual(next.firstCall.args[0].message, 'invalid-namespace');
    assert.ok(socket.join.notCalled);
    assert.ok(nrp.emit.notCalled, 'the token should not be registered as connected');
  });

  it("still lets a system token join any app's namespace", async () => {
    const { next } = await connect('/app-one', 'system-token');

    assert.deepStrictEqual(next.firstCall.args, []);
  });

  it('warns about a token in the query string, naming the token but never its value', async () => {
    const warn = sinon.stub(Logging, 'logWarn');

    await connect('/app-one', 'app-one-token', { inQuery: true });

    const warnings = warn.args.map(([message]) => message);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`token ${tokens[0].id}.*query string`));
    assert.doesNotMatch(warnings[0], /app-one-token/);
  });

  it('does not warn about a token sent as auth', async () => {
    const warn = sinon.stub(Logging, 'logWarn');

    await connect('/app-one', 'app-one-token');

    assert.strictEqual(warn.callCount, 0);
  });
});

// A socket opened with a token that's since been deleted would keep receiving activity.
describe('bootstrap-socket: deleted tokens', () => {
  it("closes a deleted token's sockets on every namespace, and no others", async () => {
    const bootstrap = new BootstrapSocket();
    const handlers = {};
    bootstrap.__nrp = { on: (event, handler) => (handlers[event] = handler), emit: () => {} };

    const disconnected = [];
    const namespace = (name) => ({
      in: (room) => ({ local: { disconnectSockets: () => disconnected.push(`${name} ${room}`) } }),
    });
    bootstrap.io = { _nsps: new Map(['/', '/app-one', '/app-two'].map((name) => [name, namespace(name)])) };

    await bootstrap.__registerNRPWorkerListeners();
    handlers['token:deleted'](JSON.stringify({ tokenIds: ['token-1', 'token-2'] }));

    assert.deepStrictEqual(disconnected.sort(), [
      '/ token-1',
      '/ token-2',
      '/app-one token-1',
      '/app-one token-2',
      '/app-two token-1',
      '/app-two token-2',
    ]);
  });
});

// A peer's activity, relayed into this instance for one of the app's remote schemas
describe('bootstrap-socket:relayedDataShareActivity', () => {
  const app = { id: 'local-app', apiPath: 'local-path' };
  const remote = {
    title: 'Private Activity', description: 'UPDATE car', visibility: 'private', broadcast: true,
    path: '/car/1', pathSpec: 'car/:id', verb: 'put', permissions: 'write', params: { id: '1' },
    timestamp: '2026-09-30T00:00:00.000Z', response: [{ path: 'name', value: 'x' }],
    user: 'remote-user', clientSessionId: 'remote-session',
    appAPIPath: 'remote-path', appId: 'remote-app', schemaName: 'car',
  };

  it("never relays an activity as a system token's copy or a core schema's", () => {
    const activity = relayedDataShareActivity({ ...remote, isSuper: true, isCoreSchema: true }, app, 'car');

    assert.strictEqual(activity.isSuper, false);
    assert.strictEqual(activity.isCoreSchema, false);
  });

  it("gives the activity this app's id and path and drops the peer's user and session", () => {
    const activity = relayedDataShareActivity(remote, app, 'car');

    assert.strictEqual(activity.appId, 'local-app');
    assert.strictEqual(activity.appAPIPath, 'local-path');
    assert.strictEqual(activity.user, '');
    assert.strictEqual(activity.clientSessionId, null);
    assert.strictEqual(activity.isSameApp, false);
    assert.deepStrictEqual(activity.response, remote.response);
    assert.deepStrictEqual(activity.params, { id: '1' });
  });

  it('keeps only the fields an activity has', () => {
    const activity = relayedDataShareActivity({ ...remote, tokens: ['t1'], extra: 'x' }, app, 'car');

    assert.ok(!('tokens' in activity));
    assert.ok(!('extra' in activity));
  });

  it('relays nothing that is not a write of the schema', () => {
    for (const bad of [null, 'x', { ...remote, verb: 'get' }, { ...remote, verb: { $ne: 1 } }]) {
      assert.strictEqual(relayedDataShareActivity(bad, app, 'car'), null, JSON.stringify(bad));
    }
    assert.deepStrictEqual(relayedDataShareActivity({ ...remote, params: 'x' }, app, 'car').params, {});
  });
});

// Activity forwarded to the instances an app shares data with
describe('bootstrap-socket:_primaryForwardDataShareActivity', () => {
  const activity = { appId: 'app-1', appAPIPath: 'app-one', verb: 'post', path: '/car', broadcast: true, response: { id: 'c1' } };

  function forwarder() {
    const socket = new BootstrapSocket();
    const sent = { partnerA: [], partnerB: [] };
    socket._dataShareSockets = {
      'app-1': [
        { socket: { emit: (event, payload) => sent.partnerA.push([event, payload]) }, tokenId: 'share-token-a' },
        { socket: { emit: (event, payload) => sent.partnerB.push([event, payload]) }, tokenId: 'share-token-b' },
      ],
    };
    return { socket, sent };
  }

  it("sends a partner only the activity addressed to its agreement's token, without this instance's token ids", () => {
    const { socket, sent } = forwarder();

    socket._primaryForwardDataShareActivity({ tokens: ['user-token', 'share-token-a'], activity });

    assert.deepStrictEqual(sent.partnerA, [['dataShareSocket:share', { tokens: [], activity }]]);
    assert.deepStrictEqual(sent.partnerB, []);
  });

  it("sends nothing for activity addressed only to this instance's own tokens", () => {
    const { socket, sent } = forwarder();

    socket._primaryForwardDataShareActivity({ tokens: ['user-token', 'system-token'], activity });

    assert.deepStrictEqual(sent, { partnerA: [], partnerB: [] });
  });
});
