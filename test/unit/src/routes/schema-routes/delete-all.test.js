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
import { Readable } from 'stream';

import Route from '../../../../../dist/routes/route.js';
import DeleteAll from '../../../../../dist/routes/schema-routes/delete-all.js';

function createFakeModel(docs) {
  return {
    createId: (id) => id,
    flatSchemaData: {},
    parseQuery: (query) => query,
    find(query) {
      const matches = docs.filter((doc) => matchesQuery(doc, query));
      return Readable.from(matches, { objectMode: true });
    },
    async rmBulk(ids) {
      for (const id of ids) {
        const idx = docs.findIndex((d) => d.id === id);
        if (idx >= 0) docs.splice(idx, 1);
      }
      return true;
    },
    async rmAll() {
      docs.splice(0, docs.length);
      return true;
    },
  };
}

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (query.$and) return query.$and.every((q) => matchesQuery(doc, q));
  if (query.$or) return query.$or.some((q) => matchesQuery(doc, q));
  return Object.keys(query).every((key) => {
    const cond = query[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && '$in' in cond) {
      return cond.$in.some((v) => `${v}` === `${doc[key]}`);
    }
    return `${doc?.[key]}` === `${cond}`;
  });
}

function createRoute(model) {
  const route = Object.create(DeleteAll.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

const makeDocs = () => [
  { id: 'note-1', owner: 'alice', shared: 'no' },
  { id: 'note-2', owner: 'bob', shared: 'no' },
  { id: 'note-3', owner: 'bob', shared: 'yes' },
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
    assert.deepStrictEqual(result, ['note-1']);
    assert.deepStrictEqual(docs.map((d) => d.id), ['note-2', 'note-3']);
  });

  it('deletes the entities any of several policy configs selects, once each, and nothing else', async () => {
    const docs = [...makeDocs(), { id: 'note-4', owner: 'alice', shared: 'yes' }];
    const model = createFakeModel(docs);
    const rmBulk = sinon.spy(model, 'rmBulk');

    // note-4 is selected by both configs.
    const { result } = await deleteAll(createRoute(model), [
      { query: { owner: 'alice' } },
      { query: { shared: 'yes' }, projection: { keys: ['owner'] } },
    ]);

    assert.deepStrictEqual(result.sort(), ['note-1', 'note-3', 'note-4']);
    assert.deepStrictEqual(rmBulk.firstCall.args[0].sort(), ['note-1', 'note-3', 'note-4']);
    assert.deepStrictEqual(docs.map((d) => d.id), ['note-2']);
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
      { id: 'note-2', owner: 'bob', shared: 'no' },
      { id: 'note-3', owner: 'bob', shared: 'yes' },
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
    assert.deepStrictEqual(broadcastResult, [{ id: 'note-2' }, { id: 'note-3' }]);
    assert.strictEqual(path, '/test-schema');
    assert.strictEqual(isSuper, true);
  });
});
