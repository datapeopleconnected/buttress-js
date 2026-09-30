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
import AppDataSharingSchemaModel from '../../../dist/model/core/app-data-sharing.js';

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
    for (const handshake of [{}, { auth: { token: '' } }]) {
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

  it('refuses a token in the query string, without looking it up', async () => {
    const { next, socket } = await connect({ query: { token: 'app-one-token' } });

    assert.strictEqual(next.firstCall.args[0].message, 'token-in-query-not-supported');
    assert.ok(socket.join.notCalled);
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

  it('refuses a token in the query string on a namespace, without looking it up', async () => {
    const { next, lookups } = await connect('/app-one', 'app-one-token', { inQuery: true });

    assert.strictEqual(next.firstCall.args[0].message, 'token-in-query-not-supported');
    assert.deepStrictEqual(lookups, []);
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

describe('bootstrap-socket: data share connections', () => {
  afterEach(() => sinon.restore());

  const share = (id, active = true) => ({
    id,
    _appId: 'app-1',
    _tokenId: `${id}-token`,
    active,
    remoteApp: { endpoint: 'https://partner.example.com', apiPath: 'partner', token: `${id}-remote-token` },
  });

  // The primary Socket main, which holds the connections to partners, here stand-ins, with its NRP listeners
  async function socketMain({ shares = {} } = {}) {
    sinon.stub(Model, 'getCoreModel').callsFake((model) => {
      if (model === AppDataSharingSchemaModel) return { findById: async (id) => shares[id] ?? null };
      throw new Error(`Unexpected model requested in test: ${model?.name}`);
    });
    const handlers = {};
    const main = new BootstrapSocket();
    main.__nrp = { on: async (channel, handler) => (handlers[channel] = handler), emit: sinon.spy() };
    const connections = [];
    main._connectDataShare = (url, token) => {
      const connection = { url, token, on: () => {}, destroy: sinon.spy() };
      connections.push(connection);
      return connection;
    };
    await main.__registerNRPPrimaryListeners();
    const publish = (channel, id) => handlers[channel](JSON.stringify({ appDataSharingId: id }));
    return { main, connections, publish };
  }

  const open = (main) => Object.values(main._dataShareSockets).flat().map(({ dataShareId }) => dataShareId);

  it('replaces the connection of an agreement activated again, rather than adding another', async () => {
    const { main, connections, publish } = await socketMain({ shares: { 'ds-1': share('ds-1') } });

    await publish('dataShare:activated', 'ds-1');
    await publish('dataShare:activated', 'ds-1');

    assert.deepStrictEqual(open(main), ['ds-1']);
    assert.strictEqual(connections.length, 2);
    assert.ok(connections[0].destroy.calledOnce);
    assert.strictEqual(connections[1].destroy.called, false);
  });

  it('closes the connection of an agreement that is deactivated, and keeps the others', async () => {
    const shares = { 'ds-1': share('ds-1'), 'ds-2': share('ds-2') };
    const { main, connections, publish } = await socketMain({ shares });
    await publish('dataShare:activated', 'ds-1');
    await publish('dataShare:activated', 'ds-2');

    await publish('dataShare:deactivated', 'ds-1');

    assert.deepStrictEqual(open(main), ['ds-2']);
    assert.ok(connections[0].destroy.calledOnce);
  });

  it("doesn't connect for an agreement that is gone or no longer active", async () => {
    const { main, connections, publish } = await socketMain({ shares: { 'ds-2': share('ds-2', false) } });

    await publish('dataShare:activated', 'ds-1');
    await publish('dataShare:activated', 'ds-2');

    assert.deepStrictEqual(open(main), []);
    assert.strictEqual(connections.length, 0);
  });
});

describe('bootstrap-socket: connected sockets', () => {
  const app = { id: new ObjectId(), apiPath: 'app-one' };
  const token = { id: new ObjectId(), value: 'app-one-token', type: 'app', _appId: app.id };

  afterEach(() => sinon.restore());

  it('tells the SPR which socket of a token connected and disconnected', async () => {
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass === TokenSchemaModel) return { findOne: async () => token };
      if (modelClass === AppSchemaModel) return { findOne: async () => app };
      throw new Error(`Unexpected core model ${modelClass.name}`);
    });
    const bootstrap = new BootstrapSocket();
    bootstrap.__nrp = { emit: sinon.spy() };
    const handlers = {};
    const socket = { id: 'socket-1', nsp: { name: '/app-one' }, handshake: { auth: { token: token.value }, query: {} }, data: {} };
    socket.join = () => {};
    socket.on = (event, handler) => (handlers[event] = handler);

    await bootstrap._workerHandleSocketConnection(socket, () => {});
    handlers.disconnect();

    const tokenId = token.id.toString();
    assert.deepStrictEqual(
      bootstrap.__nrp.emit.getCalls().map((call) => [call.args[0], JSON.parse(call.args[1])]),
      [
        ['worker:socket:connection', { tokenId, socketId: 'socket-1' }],
        ['worker:socket:disconnect', { tokenId, socketId: 'socket-1' }],
      ],
    );
  });

  it('names the tokens of the sockets it has open in its heartbeat, once each', () => {
    const bootstrap = new BootstrapSocket();
    bootstrap.__nrp = { emit: sinon.spy() };
    const sockets = (...tokenIds) => ({ sockets: new Map(tokenIds.map((tokenId, i) => [`s${i}`, { data: { tokenId } }])) });
    bootstrap.io = { _nsps: new Map([['/app-one', sockets('t1', 't2', 't1')], ['/app-two', sockets('t3')]]) };

    bootstrap._publishSocketHeartbeat();

    assert.ok(bootstrap.__nrp.emit.calledOnceWith('worker:socket:heartbeat', JSON.stringify({ tokenIds: ['t1', 't2', 't3'] })));
  });
});
