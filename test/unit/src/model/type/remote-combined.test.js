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
import ButtressAdapter from '../../../../../dist/datastore/adapters/buttress.js';

// RemoteCombinedModel's real constructor/initAdapter need a live app + datastore
// connections, so bypass them and set only the fields count() actually touches.
function createModel(localCount, remoteCounts) {
  const model = Object.create(RemoteCombinedModel.prototype);
  model._localModel = { count: async () => localCount };
  model._remoteModels = remoteCounts.map((count, idx) => ({ dataSharingId: `agreement-${idx + 1}`, count: async () => count }));
  model._schemaData = { name: 'car' };
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

    it("adds a partner's count given as text as a number", async () => {
      const model = createModel(3, ['2', 4]);

      const total = await model.count({});

      assert.strictEqual(total, 9);
    });

    it("leaves out a partner's count that isn't a count", async () => {
      const model = createModel(3, ['two', 4, null, {}, '', -1, 1.5]);

      const total = await model.count({});

      assert.strictEqual(total, 7);
    });
  });

  // App b's collection reads app a's records through agreement-1 and app c's through agreement-2, as the agreements
  // record. A partner's records can name any app as their source, so a create never goes by what they say.
  describe('creating', () => {
    const createCreatingModel = ({
      partnerAppIds = { 'agreement-1': 'app-a', 'agreement-2': 'app-c' },
      unreachable = [],
      agreements = {},
    } = {}) => {
      const created = [];
      const source = (name) => ({
        dataSharingId: name,
        add: async (body) => {
          const entities = (Array.isArray(body) ? body : [body]).map((entity) => ({ ...entity, from: name }));
          created.push([name, entities.map((entity) => entity.name)]);
          return Readable.from(entities);
        },
        findById: async (id) => ({ id, from: name }),
        isDuplicate: async () => false,
      });
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      Object.defineProperty(model, 'schemaData', { value: { name: 'car' } });
      model._localModel = source('local');
      model._remoteModels = Object.keys(partnerAppIds).filter((id) => !unreachable.includes(id)).map(source);
      model._partnerAppIds = new Map(Object.entries(partnerAppIds));
      model._partnerAskedAt = new Map();
      model._unreachable = new Set(unreachable);
      // The agreements as stored, which may know a partner's app the model doesn't yet
      model.__modelManager = { getCoreModel: () => ({ findById: async (id) => agreements[id] ?? null }) };
      return { model, created };
    };
    const madeWhere = async (result) => (await result.toArray()).map((entity) => [entity.name, entity.from]);

    it('creates an entity that names no source, or the app itself, as its own', async () => {
      const { model } = createCreatingModel();

      assert.deepStrictEqual(
        [...(await madeWhere(await model.add({ name: 'ours' }))), ...(await madeWhere(await model.add({ name: 'also ours', sourceId: 'APP-B' })))],
        [
          ['ours', 'local'],
          ['also ours', 'local'],
        ],
      );
    });

    it("creates an entity naming a partner's app through the agreement that reaches it, whatever its case", async () => {
      const { model } = createCreatingModel();

      assert.deepStrictEqual(await madeWhere(await model.add({ name: 'theirs', sourceId: 'APP-C' })), [['theirs', 'agreement-2']]);
    });

    it('creates each entity of a list where its source is, a source at a time, in the order they came', async () => {
      const { model, created } = createCreatingModel();

      const result = await model.add([
        { name: 'ours' },
        { name: 'a-1', sourceId: 'app-a' },
        { name: 'c-1', sourceId: 'app-c' },
        { name: 'a-2', sourceId: 'app-a' },
      ]);

      assert.deepStrictEqual(await madeWhere(result), [
        ['ours', 'local'],
        ['a-1', 'agreement-1'],
        ['c-1', 'agreement-2'],
        ['a-2', 'agreement-1'],
      ]);
      assert.deepStrictEqual(created, [
        ['local', ['ours']],
        ['agreement-1', ['a-1', 'a-2']],
        ['agreement-2', ['c-1']],
      ]);
    });

    it('creates a list for one source in one request', async () => {
      const { model, created } = createCreatingModel();

      await model.add([
        { name: 'a-1', sourceId: 'app-a' },
        { name: 'a-2', sourceId: 'app-a' },
      ]);

      assert.deepStrictEqual(created, [['agreement-1', ['a-1', 'a-2']]]);
    });

    it('creates nothing from a list when one of its entities names a source it can\'t create in', async () => {
      const { model, created } = createCreatingModel();

      await assert.rejects(() => model.add([{ name: 'a-1', sourceId: 'app-a' }, { name: 'x-1', sourceId: 'app-x' }]), {
        status: 400,
        code: 'unknown_source',
      });
      assert.deepStrictEqual(created, []);
    });

    it('refuses a source no agreement reaches', async () => {
      const { model } = createCreatingModel();

      await assert.rejects(() => model.add({ name: 'x', sourceId: 'app-x' }), { status: 400, code: 'unknown_source' });
    });

    it('refuses a source more than one agreement says it reaches', async () => {
      const { model } = createCreatingModel({ partnerAppIds: { 'agreement-1': 'app-a', 'agreement-2': 'app-a' } });

      await assert.rejects(() => model.add({ name: 'x', sourceId: 'app-a' }), { status: 409, code: 'ambiguous_source' });
    });

    it("refuses a source it can't place while an agreement doesn't know which app it reaches", async () => {
      const { model } = createCreatingModel({ partnerAppIds: { 'agreement-1': 'app-a', 'agreement-2': null } });

      await assert.rejects(() => model.add({ name: 'x', sourceId: 'app-c' }), {
        status: 409,
        code: 'data_sharing_partner_unknown',
      });
    });

    it("learns a partner's app its agreement has since been given, by its owner or another process", async () => {
      const { model } = createCreatingModel({
        partnerAppIds: { 'agreement-1': 'app-a', 'agreement-2': null },
        agreements: { 'agreement-2': { id: 'agreement-2', remoteApp: { appId: 'app-c' } } },
      });

      assert.deepStrictEqual(await madeWhere(await model.add({ name: 'theirs', sourceId: 'app-c' })), [['theirs', 'agreement-2']]);
    });

    it("answers as unavailable for a partner that can't be reached", async () => {
      const { model } = createCreatingModel({ unreachable: ['agreement-2'] });

      await assert.rejects(() => model.add({ name: 'x', sourceId: 'app-c' }), {
        status: 503,
        code: 'data_sharing_partner_unavailable',
      });
    });

    it('finds an entity by the source a create named', async () => {
      const { model } = createCreatingModel();

      assert.deepStrictEqual(await model.findById('car-1', 'app-c'), { id: 'car-1', from: 'agreement-2' });
    });
  });

  // An agreement paired before pairing told each side the other's app: the partner is asked when it's connected
  describe("a partner whose app the agreement doesn't record", () => {
    const createModel = async (answer) => {
      const recorded = [];
      const asked = { times: 0, answer };
      const services = new Map([
        ['nrp', { on: async () => () => {} }],
        [
          'modelManager',
          {
            getCoreModel: () => ({
              findById: async () => null,
              recordPartnerAppId: async (...args) => recorded.push(args),
            }),
          },
        ],
      ]);
      const adapter = Object.assign(Object.create(ButtressAdapter.prototype), {
        connect: async () => {},
        setCollection: async () => {},
        getSchema: async () => [],
        partnerAppId: async () => {
          asked.times++;
          return asked.answer;
        },
      });
      const datastore = { dataSharingId: 'agreement-1', partnerAppId: null, adapter: { cloneAdapterConnection: () => adapter } };
      const model = new RemoteCombinedModel({ name: 'car', type: 'collection', properties: {} }, { id: ObjectIdHelper.new() }, services);
      await model.initAdapter(null, [datastore]);
      return { model, recorded, asked };
    };

    it('asks the partner which app it is, and records it on the agreement', async () => {
      const { model, recorded } = await createModel('app-a');

      assert.deepStrictEqual(recorded, [['agreement-1', 'app-a']]);
      assert.strictEqual((await model._createTarget('app-a')).via, 'agreement-1');
      await model.destroy();
    });

    it("refuses a create that names a partner that doesn't say which app it is", async () => {
      const { model, recorded } = await createModel(null);

      assert.deepStrictEqual(recorded, []);
      await assert.rejects(() => model._createTarget('app-a'), { status: 409, code: 'data_sharing_partner_unknown' });
      await model.destroy();
    });

    // A partner upgraded after the app connected to it can say which app it is, so a create that needs to know asks
    it('asks a partner that said nothing again when a create needs it, at most every so often', async () => {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
      try {
        const { model, asked, recorded } = await createModel(null);
        asked.answer = 'app-a';

        await assert.rejects(() => model._createTarget('app-a'), { status: 409 });
        assert.strictEqual(asked.times, 1, 'asked again straight away');

        clock.tick(10000);
        assert.strictEqual((await model._createTarget('app-a')).via, 'agreement-1');
        assert.deepStrictEqual([asked.times, recorded], [2, [['agreement-1', 'app-a']]]);
        await model.destroy();
      } finally {
        clock.restore();
      }
    });
  });

  // App b reads its own records and two partners'. agreement-1's partner names app-c, agreement-2's partner app, as the
  // source of its record.
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
      model._partnerAppIds = new Map([
        ['agreement-1', 'app-a'],
        ['agreement-2', 'app-c'],
      ]);
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

    // Each source sorts as MongoDB does, which takes 1, -1, 'asc', 'desc', 'ascending' and 'descending' in any case
    it('merges its sources in the direction they are sorted in, however it is given', async () => {
      const cars = (...ns) => ns.map((n) => ({ id: `car-${n}`, n }));
      const directions = [-1, '-1', 'desc', 'DESCENDING', 1, 'asc', 'ascending'];

      for (const direction of directions) {
        const descending = directions.indexOf(direction) < 4;
        const model = descending
          ? createQueryModel(cars(5, 3, 1), cars(6, 4, 2))
          : createQueryModel(cars(1, 3, 5), cars(2, 4, 6));

        const list = await (await model.find({}, {}, 0, 0, { n: direction })).toArray();

        const order = descending ? [6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6];
        assert.deepStrictEqual(list.map((car) => car.n), order, `sorted ${JSON.stringify(direction)}`);
      }
    });
  });

  describe('removing', () => {
    const createRemovingModel = () => {
      const removed = [];
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
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
      model._partnerAppIds = new Map([
        ['agreement-1', 'app-a'],
        ['agreement-2', 'app-c'],
      ]);
      model._unreachable = new Set();
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

