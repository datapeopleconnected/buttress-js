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
import { ObjectId } from 'bson';

import BootstrapSocket from '../../../dist/bootstrap-socket.js';
import Model from '../../../dist/model/index.js';
import TokenSchemaModel from '../../../dist/model/core/token.js';
import AppSchemaModel from '../../../dist/model/core/app.js';

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

  it('refuses a token that is not a string, without looking it up', async () => {
    for (const token of [{ $ne: null }, { $regex: '.' }, ['app-one-token'], 42, '']) {
      for (const inQuery of [false, true]) {
        const { next, socket, lookups } = await connect('/app-one', token, { inQuery });

        assert.strictEqual(next.firstCall.args[0]?.message, 'invalid-token', `accepted ${JSON.stringify(token)}`);
        assert.ok(socket.join.notCalled);
        assert.deepStrictEqual(lookups, []);
        sinon.restore();
      }
    }
  });

  it('still accepts a token in the query string', async () => {
    const { next } = await connect('/app-one', 'app-one-token', { inQuery: true });

    assert.deepStrictEqual(next.firstCall.args, []);
  });
});
