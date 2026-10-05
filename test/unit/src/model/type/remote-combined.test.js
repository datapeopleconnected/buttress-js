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
import sinon from 'sinon';
import assert from 'assert';
import { Readable } from 'stream';

import RemoteCombinedModel from '../../../../../dist/model/type/remote-combined.js';
import StandardModel from '../../../../../dist/model/type/standard.js';
import ObjectIdHelper from '../../../../../dist/datastore/adapters/object-id.js';
import { SourceDataSharingRouting } from '../../../../../dist/services/source-ds-routing.js';

// RemoteCombinedModel's real constructor/initAdapter need a live app + datastore
// connections, so bypass them and set only the fields count() actually touches.
function createModel(localCount, remoteCounts) {
  const model = Object.create(RemoteCombinedModel.prototype);
  model._localModel = { count: async () => localCount };
  model._remoteModels = remoteCounts.map((count) => ({ count: async () => count }));
  return model;
}

describe('model/type/RemoteCombinedModel', () => {
  describe('count', () => {
    it('sums the local datastore count together with every remote count', async () => {
      const model = createModel(3, [2, 4]);

      const total = await model.count({});

      assert.strictEqual(total, 9);
    });

    it('still includes the local count when there are no remotes', async () => {
      const model = createModel(5, []);

      const total = await model.count({});

      assert.strictEqual(total, 5);
    });

    it('still includes remote counts when the local count is zero', async () => {
      const model = createModel(0, [7]);

      const total = await model.count({});

      assert.strictEqual(total, 7);
    });
  });

  // App b's collection reads app a's records through agreement-1. Each routing service shares one Redis, as the
  // processes and workers of an instance do. Only a create, which has no record to read first, goes by these routes.
  describe('routing a create to a partner', () => {
    const routings = [];
    afterEach(() => routings.splice(0).forEach((routing) => routing.clean()));

    const createRedis = () => {
      const data = new Map();
      return {
        get: async (key) => (data.has(key) ? data.get(key) : null),
        set: async (key, value) => data.set(key, value) && 'OK',
      };
    };
    const createRouting = (redis) => {
      const routing = new SourceDataSharingRouting(redis);
      routings.push(routing);
      return routing;
    };
    const createFederatedModel = (routing, partnerCars) => {
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      model._sdsRouting = routing;
      model._localModel = { find: async () => Readable.from([]) };
      model._remoteModels = [
        {
          dataSharingId: 'agreement-1',
          find: async () => Readable.from(partnerCars),
          add: async (body) => ({ agreement: 'agreement-1', body }),
        },
      ];
      return model;
    };
    const waitForRoutesStored = () => new Promise((resolve) => setTimeout(resolve, 150));

    it("routes a lone partner's records once they're read", async () => {
      const routing = createRouting(createRedis());
      const model = createFederatedModel(routing, [{ id: 'car-1', sourceId: 'app-a' }]);

      await (await model.find({})).toArray();

      assert.strictEqual(await routing.get('app-b', 'app-a'), 'agreement-1');
    });

    it('creates a record at a partner that another process read', async () => {
      const redis = createRedis();
      const reader = createFederatedModel(createRouting(redis), [{ id: 'car-1', sourceId: 'app-a' }]);
      await (await reader.find({})).toArray();
      await waitForRoutesStored();

      const writer = createFederatedModel(createRouting(redis), []);
      const result = await writer.add({ name: 'new', sourceId: 'app-a' });

      assert.deepStrictEqual(result, { agreement: 'agreement-1', body: { name: 'new', sourceId: 'app-a' } });
    });
  });

  // App b reads its own records and two partners'. agreement-1's partner names app-c, agreement-2's app, as the source
  // of its record, and the route reads learnt for app-c leads to agreement-2.
  describe("writing to a record it read", () => {
    const createWritingModel = () => {
      const written = [];
      const source = (name, cars) => ({
        dataSharingId: name,
        find: async () => Readable.from(cars),
        exists: async (id) => written.push([name, 'exists', id]) > 0,
        updateByPath: async (body, id) => written.push([name, 'updateByPath', id]),
        rm: async (id) => written.push([name, 'rm', id]),
      });
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      model._sdsRouting = { inform: () => {}, get: async () => 'agreement-2' };
      model._unreachable = new Set();
      model._localModel = source('local', [{ id: 'car-b', sourceId: null }]);
      model._remoteModels = [
        source('agreement-1', [{ id: 'car-1', sourceId: 'app-c' }]),
        source('agreement-2', [{ id: 'car-2', sourceId: 'app-c' }]),
      ];
      return { model, written };
    };

    it('tells where each record it read came from, whatever source the record names', async () => {
      const { model } = createWritingModel();

      const cars = await (await model.find({})).toArray();

      assert.deepStrictEqual(
        cars.map((car) => [car.id, model.sourceOf(car)]),
        [
          ['car-1', 'agreement-1'],
          ['car-2', 'agreement-2'],
          ['car-b', null],
        ],
      );
      assert.strictEqual(model.sourceOf({ id: 'car-1', sourceId: 'app-c' }), undefined);
    });

    it('writes through the agreement a record was read through, not the route its source leads to', async () => {
      const { model, written } = createWritingModel();
      const cars = await (await model.find({})).toArray();
      const car = cars.find((c) => c.id === 'car-1');

      await model.exists(car.id, model.sourceOf(car));
      await model.updateByPath([{ path: 'name', value: 'renamed' }], car.id, model.sourceOf(car));
      await model.rm(car.id, model.sourceOf(car));

      assert.deepStrictEqual(written, [
        ['agreement-1', 'exists', 'car-1'],
        ['agreement-1', 'updateByPath', 'car-1'],
        ['agreement-1', 'rm', 'car-1'],
      ]);
    });

    it("writes the app's own record locally", async () => {
      const { model, written } = createWritingModel();
      const cars = await (await model.find({})).toArray();
      const own = cars.find((c) => c.id === 'car-b');

      await model.updateByPath([{ path: 'name', value: 'renamed' }], own.id, model.sourceOf(own));

      assert.deepStrictEqual(written, [['local', 'updateByPath', 'car-b']]);
    });
  });

  describe('querying', () => {
    // A source that honours limit and skip, as a datastore does
    const createSource = (cars) => ({
      find: async (query, excludes, limit, skip) => Readable.from(cars.slice(skip, limit ? skip + limit : undefined)),
    });
    const createQueryModel = (localCars, partnerCars) => {
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      model._sdsRouting = { inform: () => {} };
      const localModel = Object.create(StandardModel.prototype);
      localModel.adapter = { ID: ObjectIdHelper };
      model._localModel = Object.assign(localModel, createSource(localCars));
      model._remoteModels = [{ dataSharingId: 'agreement-1', ...createSource(partnerCars) }];
      return model;
    };

    it('parses a query by id', () => {
      const model = createQueryModel([], []);
      const id = ObjectIdHelper.new();

      assert.deepStrictEqual(model.parseQuery({ id }, {}, { id: { __type: 'id' } }), { id: { $eq: id } });
    });

    it('pages through its sources as one list', async () => {
      const cars = (...ns) => ns.map((n) => ({ id: `car-${n}`, n }));
      const model = createQueryModel(cars(1, 3, 5), cars(2, 4, 6));

      const page = await (await model.find({}, {}, 2, 2, { n: 1 })).toArray();

      assert.deepStrictEqual(page.map((car) => car.n), [3, 4]);
    });
  });

  describe('removing', () => {
    const createRemovingModel = () => {
      const removed = [];
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      model._sdsRouting = { get: async (appId, sourceId) => (sourceId === 'app-a' ? 'agreement-1' : undefined) };
      model._localModel = { rm: async (id) => removed.push(['local', id]) };
      model._remoteModels = [{ dataSharingId: 'agreement-1', rm: async (id) => removed.push(['agreement-1', id]) }];
      return { model, removed };
    };

    it("removes a partner's record from the partner it was read through", async () => {
      const { model, removed } = createRemovingModel();

      await model.rm('car-1', 'agreement-1');

      assert.deepStrictEqual(removed, [['agreement-1', 'car-1']]);
    });

    it('removes its own record locally', async () => {
      const { model, removed } = createRemovingModel();

      await model.rm('car-2');

      assert.deepStrictEqual(removed, [['local', 'car-2']]);
    });
  });

  describe('finding by id', () => {
    const createFindingModel = () => {
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      model._sdsRouting = { get: async (appId, sourceId) => (sourceId === 'app-a' ? 'agreement-1' : undefined) };
      model._localModel = { findById: async (id) => ({ id, from: 'local' }) };
      model._remoteModels = [
        { dataSharingId: 'agreement-1', findById: async (id) => ({ id, from: 'agreement-1' }) },
        { dataSharingId: 'agreement-2', findById: async (id) => ({ id, from: 'agreement-2' }) },
      ];
      return model;
    };

    it("finds a partner's record by its source", async () => {
      assert.deepStrictEqual(await createFindingModel().findById('car-1', 'app-a'), { id: 'car-1', from: 'agreement-1' });
    });

    it('finds its own record locally', async () => {
      assert.deepStrictEqual(await createFindingModel().findById('car-2'), { id: 'car-2', from: 'local' });
    });

    it('finds a record through the agreement it was shared by', async () => {
      assert.deepStrictEqual(await createFindingModel().findSharedById('car-3', 'agreement-2'), {
        id: 'car-3',
        from: 'agreement-2',
      });
    });

    it('tells whether it reads a partner through an agreement', () => {
      const model = createFindingModel();

      assert.deepStrictEqual([model.sharesThrough('agreement-2'), model.sharesThrough('agreement-3')], [true, false]);
    });
  });

  describe("a partner that can't be reached", () => {
    let clock;
    beforeEach(() => {
      // Only timeouts, since streams need their immediates
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => clock.restore());

    const services = new Map([
      ['nrp', { on: async () => () => {} }],
      ['modelManager', {}],
    ]);
    const unreachable = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8200'), { code: 'ECONNREFUSED' });

    // A partner's datastore whose connections fail until it's up. Each connection is new, as a Buttress adapter's
    // clone is.
    const createPartner = (dataSharingId) => {
      const partner = { up: false, connections: 0 };
      partner.datastore = {
        dataSharingId,
        adapter: {
          cloneAdapterConnection: () => {
            partner.connections++;
            return {
              connect: async () => {
                if (!partner.up) throw unreachable();
              },
              setCollection: async () => {},
              find: async () => Readable.from([{ id: 'car-a', sourceId: 'app-a' }]),
            };
          },
        },
      };
      return partner;
    };
    const createModel = async (partner) => {
      const app = { id: ObjectIdHelper.new() };
      const model = new RemoteCombinedModel({ name: 'car', type: 'collection', properties: {} }, app, services);
      model._sdsRouting = { inform: () => {}, get: async () => partner.datastore.dataSharingId };
      await model.initAdapter(null, [partner.datastore]);
      model._localModel = { find: async () => Readable.from([{ id: 'car-b' }]) };
      return model;
    };

    it('starts without it, and reads only its own records', async () => {
      const model = await createModel(createPartner('agreement-1'));

      const cars = await (await model.find({})).toArray();

      assert.deepStrictEqual(cars.map((car) => car.id), ['car-b']);
      await model.destroy();
    });

    it("refuses a write to the partner's record as unavailable", async () => {
      const model = await createModel(createPartner('agreement-1'));

      await assert.rejects(() => model.updateByPath([{ path: 'name', value: 'x' }], 'car-a', 'agreement-1'), { status: 503, code: 'data_sharing_partner_unavailable' });
      await model.destroy();
    });

    it('reads the partner once it can be reached, on a new connection', async () => {
      const partner = createPartner('agreement-1');
      const model = await createModel(partner);

      partner.up = true;
      await clock.tickAsync(60000);
      const cars = await (await model.find({})).toArray();

      assert.deepStrictEqual(cars.map((car) => car.id).sort(), ['car-a', 'car-b']);
      assert.ok(partner.connections > 1);
      await model.destroy();
    });

    it('stops trying once it is let go of', async () => {
      const partner = createPartner('agreement-1');
      const model = await createModel(partner);

      await model.destroy();
      const connections = partner.connections;
      await clock.tickAsync(600000);

      assert.strictEqual(partner.connections, connections);
    });
  });

  describe('removing in bulk', () => {
    const createBulkModel = ({ unreachable = [] } = {}) => {
      const removed = [];
      const source = (name) => ({
        rmBulk: async (ids) => removed.push([name, 'rmBulk', ids]),
        rmAll: async (query) => removed.push([name, 'rmAll', query]),
      });
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      model._sdsRouting = {
        get: async (appId, sourceId) => ({ 'app-a': 'agreement-1', 'app-c': 'agreement-2' })[sourceId],
      };
      model._localModel = source('local');
      model._remoteModels = [{ dataSharingId: 'agreement-1', ...source('agreement-1') }];
      if (!unreachable.includes('agreement-2')) model._remoteModels.push({ dataSharingId: 'agreement-2', ...source('agreement-2') });
      model._unreachable = new Set(unreachable);
      return { model, removed };
    };

    it('removes each record from where it was read', async () => {
      const { model, removed } = createBulkModel();

      await model.rmBulk(['own-1', 'a-1', 'c-1', 'a-2'], [undefined, 'agreement-1', 'agreement-2', 'agreement-1']);

      assert.deepStrictEqual(removed.sort(), [
        ['agreement-1', 'rmBulk', ['a-1', 'a-2']],
        ['agreement-2', 'rmBulk', ['c-1']],
        ['local', 'rmBulk', ['own-1']],
      ]);
    });

    it('removes every record, its own and each partner\'s', async () => {
      const { model, removed } = createBulkModel();

      await model.rmAll({});

      assert.deepStrictEqual(removed.sort(), [
        ['agreement-1', 'rmAll', {}],
        ['agreement-2', 'rmAll', {}],
        ['local', 'rmAll', {}],
      ]);
    });

    it("removes nothing, as unavailable, when a partner can't be reached", async () => {
      const { model, removed } = createBulkModel({ unreachable: ['agreement-2'] });

      await assert.rejects(() => model.rmAll({}), { status: 503, code: 'data_sharing_partner_unavailable' });
      assert.deepStrictEqual(removed, []);
    });
  });
});

