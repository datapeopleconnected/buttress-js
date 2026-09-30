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

import GetMany from '../../../../../dist/routes/schema-routes/get-many.js';
import { streamAll } from '../../../../../dist/helpers/index.js';
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
const DOC_3 = newId();
const USER_1 = newId();
const USER_2 = newId();

function createFakeModel(docs) {
  return createSchemaModel(schema, docs).model;
}

function createRoute(model) {
  const route = Object.create(GetMany.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/GetMany', () => {
  const docs = [
    { id: DOC_1, ownerId: USER_1 },
    { id: DOC_2, ownerId: USER_2 },
    { id: DOC_3, ownerId: USER_1 },
  ];

  it('refuses a request with no query, or an id that is not one, as an invalid id', async () => {
    const route = createRoute(createFakeModel(docs));
    const request = (body) => route._validate({ body, context: { id: 'req-1', ac: { policyConfigs: [{}] } } }, {});

    for (const body of [{}, { query: {} }, { query: { ids: [] } }, { query: { ids: [DOC_1, 'not-an-id'] } }, undefined]) {
      await assert.rejects(request(body), (err) => err.code === 400 && err.message === 'invalid_id', JSON.stringify(body));
    }
  });

  it('returns all requested docs when the token has full access', async () => {
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: { query: { ids: [DOC_1, DOC_2, DOC_3] } },
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };

    const validate = await route._validate(req, {});
    const result = await streamAll(await route._exec(req, {}, validate));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), [DOC_1, DOC_2, DOC_3]);
  });

  it('only returns the subset of requested docs that fall within the access-control policy scope', async () => {
    // DOC_2 belongs to USER_2, so it must be excluded even though it was requested by id.
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: { query: { ids: [DOC_1, DOC_2, DOC_3] } },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    const validate = await route._validate(req, {});
    const result = await streamAll(await route._exec(req, {}, validate));

    assert.deepStrictEqual(result.map((d) => d.id).sort(), [DOC_1, DOC_3]);
  });
});
