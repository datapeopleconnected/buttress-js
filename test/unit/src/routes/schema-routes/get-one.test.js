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

import GetOne from '../../../../../dist/routes/schema-routes/get-one.js';
import { ApiError } from '../../../../../dist/helpers/errors.js';
import { createSchemaModel, newId } from '../../../../schema-model.js';

// A real schema model, so the route and access control run the real parseQuery, over rows in memory
const schema = { name: 'test-schema', properties: { ownerId: { __type: 'id' } } };
const USER_1 = newId();
const USER_2 = newId();
const DOC_1 = newId();
const DOC_2 = newId();

function createFakeModel(docs) {
  return createSchemaModel(schema, docs).model;
}

function createRoute(model) {
  const route = Object.create(GetOne.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/GetOne', () => {
  const docs = [
    { id: DOC_1, ownerId: USER_1 },
    { id: DOC_2, ownerId: USER_2 },
  ];

  it('returns the entity when the token has full access (no policy query)', async () => {
    const route = createRoute(createFakeModel(docs));
    const req = { params: { id: DOC_1 }, context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    const validate = await route._validate(req, {});
    const entity = await route._exec(req, {}, validate);

    assert.strictEqual(entity.id, DOC_1);
  });

  it('returns the entity when it matches the access-control policy query', async () => {
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: DOC_1 },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    const validate = await route._validate(req, {});
    const entity = await route._exec(req, {}, validate);

    assert.strictEqual(entity.id, DOC_1);
  });

  it('rejects with a 404 when the entity exists but is outside the access-control policy scope', async () => {
    // DOC_2 exists, but belongs to USER_2 while the policy only scopes to USER_1's records.
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: DOC_2 },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    const validate = await route._validate(req, {});
    await assert.rejects(
      () => route._exec(req, {}, validate),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.status, 404);
        assert.strictEqual(err.code, 'not_found');
        return true;
      },
    );
  });

  it('rejects with a 404 when the id does not exist at all', async () => {
    const route = createRoute(createFakeModel(docs));
    const req = { params: { id: newId() }, context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    const validate = await route._validate(req, {});
    await assert.rejects(
      () => route._exec(req, {}, validate),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.status, 404);
        assert.strictEqual(err.code, 'not_found');
        return true;
      },
    );
  });
});
