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

import BootstrapSocket from '../../../dist/bootstrap-socket.js';
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
