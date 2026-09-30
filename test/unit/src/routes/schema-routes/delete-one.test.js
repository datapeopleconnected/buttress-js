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

import { describe, it } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';

import DeleteOne from '../../../../../dist/routes/schema-routes/delete-one.js';
import { RequestError } from '../../../../../dist/helpers/errors.js';
import { createSchemaModel, newId } from '../../../../schema-model.js';

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
const USER_1 = newId();
const USER_2 = newId();

function createFakeModel(docs) {
  return createSchemaModel(schema, docs).model;
}

function createRoute(model) {
  const route = Object.create(DeleteOne.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/DeleteOne', () => {
  const makeDocs = () => [
    { id: DOC_1, ownerId: USER_1 },
    { id: DOC_2, ownerId: USER_2 },
  ];

  it('deletes the entity when the token has full access', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = { params: { id: DOC_1 }, context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.ok(!docs.some((d) => d.id === DOC_1));
  });

  it('keeps the entity it deletes, as it was, for the SPR to check against policies', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = { params: { id: DOC_1 }, context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    await route._exec(req, {}, await route._validate(req, {}));

    assert.deepStrictEqual(req.context.deletedEntities, [{ id: DOC_1, ownerId: USER_1 }]);
  });

  it('keeps the entity it found in scope rather than reading it again, when no policy restricts fields', async () => {
    const model = createFakeModel(makeDocs());
    const find = sinon.spy(model, 'find');
    const route = createRoute(model);
    const req = { params: { id: DOC_1 }, context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    await route._exec(req, {}, await route._validate(req, {}));

    assert.strictEqual(find.callCount, 1);
    assert.deepStrictEqual(req.context.deletedEntities, [{ id: DOC_1, ownerId: USER_1 }]);
  });

  it('reads the entity again, whole, when a policy restricts fields', async () => {
    const model = createFakeModel(makeDocs());
    const find = sinon.spy(model, 'find');
    const route = createRoute(model);
    const req = {
      params: { id: DOC_1 },
      context: { id: 'req-1', ac: { policyConfigs: [{ projection: { keys: ['name'] } }] } },
    };

    await route._exec(req, {}, await route._validate(req, {}));

    assert.strictEqual(find.callCount, 2);
    assert.strictEqual(find.secondCall.args[5], undefined, 'the second read projects nothing');
  });

  it('deletes the entity when it matches the access-control policy query', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: DOC_1 },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.ok(!docs.some((d) => d.id === DOC_1));
  });

  it('rejects with a 400 and leaves the entity intact when it exists but is outside the access-control policy scope', async () => {
    // DOC_2 exists, but belongs to USER_2 while the policy only scopes to USER_1's records.
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: DOC_2 },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    await assert.rejects(
      () => route._validate(req, {}),
      (err) => {
        assert.ok(err instanceof RequestError);
        assert.strictEqual(err.code, 400);
        return true;
      },
    );

    assert.ok(
      docs.some((d) => d.id === DOC_2),
      'entity outside the access-control scope must not be deleted',
    );
  });
});
