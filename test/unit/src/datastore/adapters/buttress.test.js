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
import net from 'node:net';
import { Readable } from 'node:stream';
import sinon from 'sinon';

import ButtressAdapter from '../../../../../dist/datastore/adapters/buttress.js';
import DatastoreFactory from '../../../../../dist/datastore/adapter-factory.js';

// An adapter that talks to a fake remote collection, without connecting to anything
function createAdapter(collection) {
  const adapter = Object.create(ButtressAdapter.prototype);
  adapter.collection = collection;
  adapter._resolvedApiCall = (_name, call) => call();
  adapter.convertBSONObjects = (value) => value;
  return adapter;
}

describe('datastore/adapters/buttress:rmAll', () => {
  afterEach(() => sinon.restore());

  // @buttress/api refuses a delete-all that is given anything, as it takes no filter and would remove everything
  const createCollection = (entities = []) => ({
    removeAll: sinon.spy((...args) => {
      if (args.length > 0 && args[0] !== null && args[0] !== undefined) throw new Error('removeAll takes no filter');
      return Promise.resolve(true);
    }),
    bulkRemove: sinon.stub().resolves(true),
    // The partner's answer is a stream of a JSON array, an entity to a line
    search: sinon.stub().callsFake(() => {
      const body = new Readable({ read() {} });
      body.push(`[\n${entities.map((entity) => JSON.stringify(entity)).join(',\n')}\n]`);
      body.push(null);
      return Promise.resolve(body);
    }),
  });

  it('deletes everything through the partner when it is given no query', async () => {
    const collection = createCollection();

    await createAdapter(collection).rmAll();

    sinon.assert.calledOnceWithExactly(collection.removeAll);
    sinon.assert.notCalled(collection.bulkRemove);
  });

  it('deletes everything through the partner when it is given an empty query, as the delete-all route does', async () => {
    const collection = createCollection();

    await createAdapter(collection).rmAll({});

    sinon.assert.calledOnceWithExactly(collection.removeAll);
  });

  it('deletes only the entities a query matches, by id, rather than everything', async () => {
    const collection = createCollection([{ id: 'a' }, { id: 'b' }]);

    await createAdapter(collection).rmAll({ name: { $eq: 'x' } });

    sinon.assert.calledOnceWithExactly(collection.search, { name: { $eq: 'x' } }, 0, 0, undefined, sinon.match.object);
    sinon.assert.calledOnceWithExactly(collection.bulkRemove, ['a', 'b']);
    sinon.assert.notCalled(collection.removeAll);
  });

  it('deletes nothing when a query matches nothing', async () => {
    const collection = createCollection([]);

    await createAdapter(collection).rmAll({ name: { $eq: 'x' } });

    sinon.assert.notCalled(collection.bulkRemove);
    sinon.assert.notCalled(collection.removeAll);
  });
});

describe('datastore/adapters/buttress:connect', () => {
  let server;
  afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  // A partner that drops every connection, counting how many times it's asked
  const startDroppingPartner = () =>
    new Promise((resolve) => {
      const partner = { attempts: 0 };
      server = net.createServer((socket) => {
        partner.attempts++;
        socket.destroy();
      });
      server.listen(0, '127.0.0.1', () => {
        partner.port = server.address().port;
        resolve(partner);
      });
    });

  // The data sharing model tries a partner it can't reach again later, so the connection isn't retried as well
  it("fails straight away, without retrying, when the partner can't be reached", async () => {
    const partner = await startDroppingPartner();
    const adapter = new ButtressAdapter(new URL(`butt://127.0.0.1:${partner.port}/partner?token=t`), {});

    await assert.rejects(adapter.connect());

    assert.strictEqual(partner.attempts, 1);
  });

  // Data sharing connects to butt://<endpoint>/<apiPath>?token=..., and an agreement's apiPath can be empty
  it("keeps a bare '/' as the path, the partner app's api path, rather than giving it the default database", () => {
    const adapter = DatastoreFactory.create('butt://localhost:8000/?token=t');

    assert.strictEqual(adapter.uri.pathname, '/');
  });
});

// Each side of a pairing tells the other which app it is, and an agreement paired before asks the partner
describe('datastore/adapters/buttress: which app a partner is', () => {
  afterEach(() => sinon.restore());

  const createConnected = (appDataSharing) => {
    const adapter = new ButtressAdapter(new URL('butt://localhost:8000/partner?token=agreement-token'), {});
    adapter.init = true;
    adapter.__connection = { AppDataSharing: appDataSharing };
    return adapter;
  };

  it("tells the partner which app it's paired with when it activates the agreement", async () => {
    const activate = sinon.stub().resolves({ status: true, token: 'new-token' });
    const adapter = createConnected({ activate });

    await adapter.activateDataSharing('registration-token', 'new-token', '6abd05000000000000000001');

    assert.deepStrictEqual(activate.firstCall.args, [
      'registration-token',
      'new-token',
      { params: { appId: '6abd05000000000000000001' } },
    ]);
  });

  it("asks the partner which app the agreement's token is for, with that token", async () => {
    const request = sinon.stub().resolves({ appId: '6abd05000000000000000002' });
    const adapter = createConnected({ _request: request });

    assert.strictEqual(await adapter.partnerAppId(), '6abd05000000000000000002');
    const [method, path, options] = request.firstCall.args;
    assert.deepStrictEqual([method, path, options.token], ['get', 'identity', 'agreement-token']);
  });

  it("gives no app for an answer that doesn't name one", async () => {
    const adapter = createConnected({ _request: sinon.stub().resolves({ appId: 'not-an-id' }) });

    assert.strictEqual(await adapter.partnerAppId(), null);
  });
});
