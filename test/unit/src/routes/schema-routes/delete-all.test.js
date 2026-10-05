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

import Route from '../../../../../dist/routes/route.js';
import DeleteAll from '../../../../../dist/routes/schema-routes/delete-all.js';
import { createSchemaModel, newId } from '../../../../schema-model.js';

// A real schema model, so the route and access control run the real parseQuery, over rows in memory
const schema = {
  name: 'test-schema',
  properties: {
    owner: { __type: 'string' },
    shared: { __type: 'string' },
    body: { __type: 'string' },
  },
};
const NOTE_1 = newId();
const NOTE_2 = newId();
const NOTE_3 = newId();
const NOTE_4 = newId();

function createFakeModel(docs) {
  return createSchemaModel(schema, docs).model;
}

function createRoute(model) {
  const route = Object.create(DeleteAll.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

const makeDocs = () => [
  { id: NOTE_1, owner: 'alice', shared: 'no' },
  { id: NOTE_2, owner: 'bob', shared: 'no' },
  { id: NOTE_3, owner: 'bob', shared: 'yes' },
];

async function deleteAll(route, policyConfigs) {
  const req = { context: { id: 'req-1', ac: { policyConfigs } } };
  const result = await route._exec(req, {}, await route._validate(req, {}));
  return { req, result };
}

describe('schema-routes/DeleteAll', () => {
  afterEach(() => sinon.restore());

  it('deletes every entity when the token has no policy configs, as a system token has', async () => {
    const docs = makeDocs();
    const model = createFakeModel(docs);
    const rmAll = sinon.spy(model, 'rmAll');
    const find = sinon.spy(model, 'find');

    const { result } = await deleteAll(createRoute(model), []);

    assert.ok(rmAll.calledOnceWith({}));
    assert.strictEqual(find.callCount, 0);
    assert.strictEqual(result, true);
    assert.deepStrictEqual(docs, []);
  });

  it('deletes every entity when a policy config gives full access', async () => {
    // A %FULL_ACCESS% query is built down to {} by the policy middleware.
    const docs = makeDocs();
    const model = createFakeModel(docs);
    const rmAll = sinon.spy(model, 'rmAll');

    const { result } = await deleteAll(createRoute(model), [{ query: { owner: 'alice' } }, { query: {} }]);

    assert.ok(rmAll.calledOnceWith({}));
    assert.strictEqual(result, true);
    assert.deepStrictEqual(docs, []);
  });

  it('deletes only the entities the policy query selects', async () => {
    const docs = makeDocs();
    const model = createFakeModel(docs);
    const rmAll = sinon.spy(model, 'rmAll');

    const { result } = await deleteAll(createRoute(model), [{ query: { owner: 'alice' } }]);

    assert.strictEqual(rmAll.callCount, 0);
    assert.deepStrictEqual(result, [NOTE_1]);
    assert.deepStrictEqual(docs.map((d) => d.id), [NOTE_2, NOTE_3]);
  });

  it('deletes the entities any of several policy configs selects, once each, and nothing else', async () => {
    const docs = [...makeDocs(), { id: NOTE_4, owner: 'alice', shared: 'yes' }];
    const model = createFakeModel(docs);
    const rmBulk = sinon.spy(model, 'rmBulk');

    // NOTE_4 is selected by both configs.
    const { result } = await deleteAll(createRoute(model), [
      { query: { owner: 'alice' } },
      { query: { shared: 'yes' }, projection: { keys: ['owner'] } },
    ]);

    assert.deepStrictEqual(result.sort(), [NOTE_1, NOTE_3, NOTE_4]);
    assert.deepStrictEqual(rmBulk.firstCall.args[0].sort(), [NOTE_1, NOTE_3, NOTE_4]);
    assert.deepStrictEqual(docs.map((d) => d.id), [NOTE_2]);
  });

  it('deletes nothing when the policy query selects no entity', async () => {
    const docs = makeDocs();
    const model = createFakeModel(docs);
    const rmBulk = sinon.spy(model, 'rmBulk');
    const rmAll = sinon.spy(model, 'rmAll');

    const { result } = await deleteAll(createRoute(model), [{ query: { owner: 'carol' } }]);

    assert.deepStrictEqual(result, []);
    assert.strictEqual(rmBulk.callCount, 0);
    assert.strictEqual(rmAll.callCount, 0);
    assert.strictEqual(docs.length, 3);
  });

  it('keeps the entities a policy-limited delete removes, as they were, for the SPR to check against policies', async () => {
    const { req } = await deleteAll(createRoute(createFakeModel(makeDocs())), [{ query: { owner: 'bob' } }]);

    assert.deepStrictEqual(req.context.deletedEntities, [
      { id: NOTE_2, owner: 'bob', shared: 'no' },
      { id: NOTE_3, owner: 'bob', shared: 'yes' },
    ]);
  });

  it('keeps no entities for a delete of every entity', async () => {
    const { req } = await deleteAll(createRoute(createFakeModel(makeDocs())), []);

    assert.strictEqual(req.context.deletedEntities, undefined);
  });
});

describe('schema-routes/DeleteAll:_respond/_broadcast', () => {
  afterEach(() => sinon.restore());

  it('responds true and broadcasts true for a delete of every entity', async () => {
    const respond = sinon.stub(Route.prototype, '_respond').resolves();
    const broadcast = sinon.stub(Route.prototype, '_broadcast').resolves();
    const route = createRoute(createFakeModel(makeDocs()));

    const { req, result } = await deleteAll(route, []);
    await route._respond(req, {}, result);
    await route._broadcast(req, {}, result, '/test-schema');

    assert.strictEqual(respond.firstCall.args[2], true);
    assert.strictEqual(broadcast.firstCall.args[2], true);
  });

  it('responds true, but broadcasts the ids a policy-limited delete removed', async () => {
    const respond = sinon.stub(Route.prototype, '_respond').resolves();
    const broadcast = sinon.stub(Route.prototype, '_broadcast').resolves();
    const route = createRoute(createFakeModel(makeDocs()));

    const { req, result } = await deleteAll(route, [{ query: { owner: 'bob' } }]);
    await route._respond(req, {}, result);
    await route._broadcast(req, {}, result, '/test-schema', true);

    assert.strictEqual(respond.firstCall.args[2], true);
    const [, , broadcastResult, path, isSuper] = broadcast.firstCall.args;
    assert.deepStrictEqual(broadcastResult, [{ id: NOTE_2 }, { id: NOTE_3 }]);
    assert.strictEqual(path, '/test-schema');
    assert.strictEqual(isSuper, true);
  });

  describe('broadcasting a large policy-limited delete', () => {
    // The route's real broadcast, publishing to a stand-in for NRP
    function broadcastingRoute(docs) {
      const route = createRoute(createFakeModel(docs));
      route._nrp = { emit: sinon.spy() };
      route.activityBroadcast = true;
      route.core = false;
      route._dataApp = () => ({ id: 'app-1', apiPath: 'app' });
      const activities = () => route._nrp.emit.getCalls().map((call) => JSON.parse(call.args[1]));
      return { route, activities };
    }

    it('sends the deleted entities in batches of at most 1000, each with the entities of its own ids', async () => {
      const docs = Array.from({ length: 2500 }, (_, i) => ({ id: newId(), owner: 'bob' }));
      const { route, activities } = broadcastingRoute(docs);

      const { req, result } = await deleteAll(route, [{ query: { owner: 'bob' } }]);
      const kept = req.context.deletedEntities;
      await route._broadcast(req, {}, result, '/test-schema');

      const sent = activities();
      assert.deepStrictEqual(sent.map((a) => a.response.length), [1000, 1000, 500]);
      for (const activity of sent) {
        assert.deepStrictEqual(activity.deletedEntities.map((e) => e.id), activity.response.map((r) => r.id));
      }
      assert.strictEqual(new Set(sent.flatMap((a) => a.response.map((r) => r.id))).size, 2500);
      assert.strictEqual(req.context.deletedEntities, kept);
    });

    it('keeps each batch to about a megabyte of entities', async () => {
      const big = 'x'.repeat(600 * 1024);
      const docs = Array.from({ length: 3 }, (_, i) => ({ id: newId(), owner: 'bob', body: big }));
      const { route, activities } = broadcastingRoute(docs);

      const { req, result } = await deleteAll(route, [{ query: { owner: 'bob' } }]);
      await route._broadcast(req, {}, result, '/test-schema');

      assert.deepStrictEqual(activities().map((a) => a.response.length), [1, 1, 1]);
    });

    it("sends a system token's copy in batches too, without the entities", async () => {
      const docs = Array.from({ length: 1500 }, (_, i) => ({ id: newId(), owner: 'bob' }));
      const { route, activities } = broadcastingRoute(docs);

      const { req, result } = await deleteAll(route, [{ query: { owner: 'bob' } }]);
      await route._broadcast(req, {}, result, '/test-schema', true);

      assert.deepStrictEqual(activities().map((a) => [a.response.length, a.deletedEntities]), [[1000, undefined], [500, undefined]]);
    });
  });
});
