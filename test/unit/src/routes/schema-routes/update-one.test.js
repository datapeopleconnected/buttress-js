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

import UpdateOne from '../../../../../dist/routes/schema-routes/update-one.js';
import StandardModel from '../../../../../dist/model/type/standard.js';
import { ApiError } from '../../../../../dist/helpers/errors.js';
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
  const route = Object.create(UpdateOne.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/UpdateOne', () => {
  const makeDocs = () => [
    { id: DOC_1, ownerId: USER_1, value: 'original' },
    { id: DOC_2, ownerId: USER_2, value: 'original' },
  ];

  it('updates the entity when the token has full access', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: DOC_1 },
      body: { path: 'value', value: 'updated' },
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.strictEqual(docs.find((d) => d.id === DOC_1).value, 'updated');
  });

  it('updates the entity when it matches the access-control policy query', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: DOC_1 },
      body: { path: 'value', value: 'updated' },
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, {}, validate);

    assert.strictEqual(docs.find((d) => d.id === DOC_1).value, 'updated');
  });

  it('rejects with a 404 and leaves the entity untouched when it exists but is outside the access-control policy scope', async () => {
    // DOC_2 exists, but belongs to USER_2 while the policy only scopes to USER_1's records.
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      params: { id: DOC_2 },
      body: { path: 'value', value: 'updated' },
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

    assert.strictEqual(docs.find((d) => d.id === DOC_2).value, 'original');
  });
});

describe('schema-routes/UpdateOne: refusal messages', () => {
  // The fake model, validating with a real StandardModel's validateUpdate.
  const schema = {
    name: 'test-schema',
    type: 'collection',
    extends: [],
    properties: {
      value: { __type: 'string', __default: null, __allowUpdate: true },
      qty: { __type: 'number', __default: 0, __allowUpdate: true },
    },
  };
  const refusal = async (body) => {
    const services = new Map([
      ['nrp', { on: () => {}, emit: () => {} }],
      ['modelManager', {}],
    ]);
    const validator = new StandardModel(schema, null, services);
    const model = { ...createFakeModel([{ id: DOC_1 }]), validateUpdate: (b) => validator.validateUpdate(b) };
    const req = { params: { id: DOC_1 }, body, context: { id: 'req-1', ac: { policyConfigs: [{}] } } };

    const err = await createRoute(model)._validate(req, {}).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof ApiError, 'expected the update to be refused');
    assert.strictEqual(err.status, 400);
    return err.message;
  };

  it('names the invalid value without a path of undefined', async () => {
    assert.strictEqual(await refusal({ path: 'qty', value: 'lots' }), 'test-schema: Update value is invalid: qty failed schema test');
  });

  it('says when the value is missing rather than that the path is invalid', async () => {
    assert.strictEqual(await refusal({ path: 'qty' }), 'test-schema: Update is missing its value');
  });

  it('refuses an update with no path with a 400, not a 500', async () => {
    assert.strictEqual(await refusal({ value: 'x' }), 'test-schema: Update is missing its path');
  });

  it('still names an invalid path', async () => {
    assert.match(await refusal({ path: 'nope', value: 'x' }), /^test-schema: Update path is invalid: nope/);
  });
});
