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
import DeleteMany from '../../../../../dist/routes/schema-routes/delete-many.js';
import { ApiError } from '../../../../../dist/helpers/errors.js';
import { createFederatedSchemaModel, createSchemaModel, newId } from '../../../../schema-model.js';

// A real schema model, so the route and access control run the real parseQuery, over rows in memory
const schema = {
  name: 'test-schema',
  properties: {
    ownerId: { __type: 'id' },
    value: { __type: 'string', __default: null, __allowUpdate: true },
  },
};
const DOC_1 = newId();
const DOC_2 = newId();
const DOC_3 = newId();
const USER_1 = newId();
const USER_2 = newId();

function createFakeModel(docs) {
  return createSchemaModel(schema, docs).model;
}

function createRoute(model) {
  const route = Object.create(DeleteMany.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/DeleteMany', () => {
  const makeDocs = () => [
    { id: DOC_1, ownerId: USER_1 },
    { id: DOC_2, ownerId: USER_2 },
    { id: DOC_3, ownerId: USER_1 },
  ];

  it('deletes every requested entity when the token has full access', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = { body: [DOC_1, DOC_3], context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.deepStrictEqual(
      docs.map((d) => d.id),
      [DOC_2],
    );
  });

  it('deletes the requested entities when they all fall within the access-control policy scope', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [DOC_1, DOC_3],
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.deepStrictEqual(
      docs.map((d) => d.id),
      [DOC_2],
    );
  });

  it('keeps the entities it deletes, as they were, for the SPR to check against policies', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = { body: [DOC_1, DOC_3], context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    await route._exec(req, {}, await route._validate(req, {}));

    assert.deepStrictEqual(req.context.deletedEntities, [
      { id: DOC_1, ownerId: USER_1 },
      { id: DOC_3, ownerId: USER_1 },
    ]);
  });

  it('keeps the entities it found in scope rather than reading them again, when no policy restricts fields', async () => {
    const model = createFakeModel(makeDocs());
    const find = sinon.spy(model, 'find');
    const route = createRoute(model);
    const req = { body: [DOC_1, DOC_3], context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    await route._exec(req, {}, await route._validate(req, {}));

    assert.strictEqual(find.callCount, 1);
    assert.deepStrictEqual(req.context.deletedEntities.map((entity) => entity.id), [DOC_1, DOC_3]);
  });

  it('reads the entities again, whole, when a policy restricts fields', async () => {
    const model = createFakeModel(makeDocs());
    const find = sinon.spy(model, 'find');
    const route = createRoute(model);
    const req = {
      body: [DOC_1, DOC_3],
      context: { id: 'req-1', ac: { policyConfigs: [{ projection: { keys: ['ownerId'] } }] } },
    };

    await route._exec(req, {}, await route._validate(req, {}));

    assert.strictEqual(find.callCount, 2);
  });

  it('rejects the whole batch and deletes nothing when any requested id is outside the access-control policy scope', async () => {
    // DOC_2 belongs to USER_2; the policy only scopes to USER_1's records, so the whole
    // batch (including DOC_1, which the caller *is* allowed to delete) must be rejected.
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [DOC_1, DOC_2],
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    await assert.rejects(
      () => route._validate(req, {}),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.status, 404);
        assert.strictEqual(err.code, 'not_found');
        return true;
      },
    );

    assert.deepStrictEqual(
      docs.map((d) => d.id).sort(),
      [DOC_1, DOC_2, DOC_3],
      'no entity should be deleted when any id in the batch is outside the access-control scope',
    );
  });
});

describe('schema-routes/DeleteMany:_respond/_broadcast', () => {
  afterEach(() => sinon.restore());

  it('still responds true, but broadcasts the deleted ids once each', async () => {
    const respond = sinon.stub(Route.prototype, '_respond').resolves();
    const broadcast = sinon.stub(Route.prototype, '_broadcast').resolves();
    const route = createRoute(createFakeModel([{ id: DOC_1 }, { id: DOC_2 }]));
    const req = { body: [DOC_1, DOC_2, DOC_1], context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    const result = await route._exec(req, {}, await route._validate(req, {}));
    await route._respond(req, {}, result);
    await route._broadcast(req, {}, result, '/test-schema/bulk/delete', true);

    assert.strictEqual(respond.firstCall.args[2], true);
    const [, , broadcastResult, path, isSuper] = broadcast.firstCall.args;
    assert.deepStrictEqual(broadcastResult, [{ id: DOC_1 }, { id: DOC_2 }]);
    assert.strictEqual(path, '/test-schema/bulk/delete');
    assert.strictEqual(isSuper, true);
  });
});

describe('schema-routes/DeleteMany: a collection with remotes', () => {
  // agreement-1's partner names app-c as its record's source, and the route reads learnt for app-c leads to agreement-2,
  // as when a partner names another partner's app
  it('deletes each record from where it was read, whatever source it names', async () => {
    const own = [{ id: DOC_1 }, { id: DOC_3 }];
    const partner = [{ id: DOC_2, sourceId: 'app-c' }];
    const { model, datastores } = createFederatedSchemaModel(
      schema,
      own,
      { 'agreement-1': partner, 'agreement-2': [] },
      { 'app-c': 'agreement-2' },
    );
    const route = createRoute(model);
    const req = { body: [DOC_1, DOC_2], context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    await route._exec(req, {}, await route._validate(req, {}));

    assert.deepStrictEqual([own.map((row) => row.id), partner], [[DOC_3], []]);
    assert.deepStrictEqual(datastores['agreement-2'].calls.filter(([call]) => call !== 'find'), []);
  });
});
