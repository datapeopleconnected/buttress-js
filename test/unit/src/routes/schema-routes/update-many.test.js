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
import UpdateMany from '../../../../../dist/routes/schema-routes/update-many.js';
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
const DOC_9 = newId();
const USER_1 = newId();
const USER_2 = newId();

function createFakeModel(docs) {
  return createSchemaModel(schema, docs).model;
}

function createRes() {
  const headers = {};
  return { headers, set: (name, value) => (headers[name] = value) };
}

function createRoute(model) {
  const route = Object.create(UpdateMany.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/UpdateMany', () => {
  const makeDocs = () => [
    { id: DOC_1, ownerId: USER_1, value: 'original' },
    { id: DOC_2, ownerId: USER_2, value: 'original' },
  ];

  it('updates every entity when the token has full access', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [
        { id: DOC_1, body: { path: 'value', value: 'updated' } },
        { id: DOC_2, body: { path: 'value', value: 'updated' } },
      ],
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, createRes(), validate);

    assert.strictEqual(docs.find((d) => d.id === DOC_1).value, 'updated');
    assert.strictEqual(docs.find((d) => d.id === DOC_2).value, 'updated');
  });

  it('marks an entity outside the access-control policy scope invalid and does not apply its update', async () => {
    // DOC_2 belongs to USER_2, but the policy only scopes to USER_1's records.
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [
        { id: DOC_1, body: { path: 'value', value: 'updated' } },
        { id: DOC_2, body: { path: 'value', value: 'updated' } },
      ],
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: USER_1 } }] } },
    };

    const validate = await route._validate(req, {});

    const doc1Update = validate.find((u) => u.id === DOC_1);
    const doc2Update = validate.find((u) => u.id === DOC_2);
    assert.strictEqual(doc1Update.validation, true);
    assert.notStrictEqual(doc2Update.validation, true);

    await route._exec(req, createRes(), validate);

    assert.strictEqual(docs.find((d) => d.id === DOC_1).value, 'updated');
    assert.strictEqual(
      docs.find((d) => d.id === DOC_2).value,
      'original',
      'entity outside the access-control scope must not be updated by _exec, even though it was included in the batch',
    );
  });
});

describe('schema-routes/UpdateMany: per-item results', () => {
  // Like StandardModel.validateUpdate, this returns the body as an array of updates; any update to `bad` is refused.
  function createPathCheckingModel(docs) {
    const model = createFakeModel(docs);
    model.exists = sinon.spy(async (id) => docs.some((doc) => doc.id === id));
    model.validateUpdate = (body) => {
      const updates = Array.isArray(body) ? body : [body];
      const refused = updates.find((u) => u.path === 'bad');
      return {
        validation: refused ? { isValid: false, isPathValid: false, invalidPath: 'bad' } : { isValid: true },
        body: updates,
      };
    };
    model.updateByPath = async (updates, id) => {
      const doc = docs.find((d) => d.id === id);
      updates.forEach((u) => (doc[u.path] = u.value));
      return updates.map((u) => ({ type: 'scalar', path: u.path, value: u.value }));
    };
    return model;
  }

  const fullAccess = { id: 'req-1', ac: { policyConfigs: [{}] } };

  it('applies a valid update even when another update to the same entity is refused', async () => {
    const docs = [{ id: DOC_1, value: 'original' }];
    const route = createRoute(createPathCheckingModel(docs));
    const req = {
      body: [
        { id: DOC_1, body: { path: 'value', value: 'updated' } },
        { id: DOC_1, body: { path: 'bad', value: 'x' } },
      ],
      context: fullAccess,
    };

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.strictEqual(docs[0].value, 'updated');
    assert.deepStrictEqual(output[0].results, [{ type: 'scalar', path: 'value', value: 'updated' }]);
    assert.strictEqual(output[1].results, null);
    assert.deepStrictEqual(output[1].validation, {
      status: 400,
      code: 'invalid_update',
      message: 'test-schema: Update path is invalid: bad',
      details: { schema: 'test-schema' },
    });
  });

  it('returns one result per request item, in request order', async () => {
    const docs = [{ id: DOC_1 }, { id: DOC_2 }];
    const route = createRoute(createPathCheckingModel(docs));
    const req = {
      body: [
        { id: DOC_2, body: { path: 'value', value: 'a' } },
        { id: DOC_1, body: { path: 'value', value: 'b' } },
        { id: DOC_2, body: { path: 'value', value: 'c' } },
      ],
      context: fullAccess,
    };

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(
      output.map((o) => [o.id, o.results[0].value]),
      [
        [DOC_2, 'a'],
        [DOC_1, 'b'],
        [DOC_2, 'c'],
      ],
    );
    assert.strictEqual(docs[1].value, 'c');
  });

  it('refuses an update to an entity that does not exist, saying so', async () => {
    const route = createRoute(createPathCheckingModel([]));
    const req = { body: [{ id: DOC_9, body: { path: 'value', value: 'x' } }], context: fullAccess };

    const [item] = await route._validate(req, {});

    assert.deepStrictEqual(item.validation, {
      status: 404,
      code: 'not_found',
      message: 'No test-schema was found with that id',
      details: { schema: 'test-schema', id: DOC_9 },
    });
  });

  it('looks each entity up once, however many updates it has', async () => {
    const model = createPathCheckingModel([{ id: DOC_1 }]);
    const route = createRoute(model);
    const req = {
      body: [
        { id: DOC_1, body: { path: 'value', value: 'a' } },
        { id: DOC_1, body: { path: 'value', value: 'b' } },
      ],
      context: fullAccess,
    };

    await route._validate(req, {});

    assert.strictEqual(model.exists.callCount, 1);
  });
});

describe('schema-routes/UpdateMany: items that fail while being written', () => {
  const fullAccess = { id: 'req-1', ac: { policyConfigs: [{}] } };

  // Writes DOC_1 and DOC_3; DOC_2's write fails in the datastore with `error`.
  function createFailingModel(docs, error) {
    const { model, datastore } = createSchemaModel(schema, docs);
    const updateByPaths = datastore.updateByPaths.bind(datastore);
    datastore.updateByPaths = async (id, updates) => {
      if (id === DOC_2) throw error;
      return updateByPaths(id, updates);
    };
    return model;
  }

  const threeItems = () => ({
    body: [
      { id: DOC_1, body: { path: 'value', value: 'a' } },
      { id: DOC_2, body: { path: 'value', value: 'b' } },
      { id: DOC_3, body: { path: 'value', value: 'c' } },
    ],
    context: fullAccess,
  });

  const makeDocs = () => [{ id: DOC_1 }, { id: DOC_2 }, { id: DOC_3 }];

  it('reports an item whose write fails as refused, and carries on with the rest', async () => {
    const docs = makeDocs();
    const error = new ApiError(400, 'invalid_update', "Update can't be applied: Cannot create field 'x' in element {meta: null}");
    const route = createRoute(createFailingModel(docs, error));
    const req = threeItems();

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(
      output.map((o) => o.validation ?? o.results[0].value),
      ['a', { status: 400, code: 'invalid_update', message: error.message }, 'c'],
    );
    assert.strictEqual(output[1].results, null);
    assert.deepStrictEqual(
      docs.map((d) => d.value),
      ['a', undefined, 'c'],
    );
  });

  it('marks the failed item refused on the request, so it triggers no path lambdas', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new ApiError(409, 'update_conflict', 'The entity changed')));
    const req = threeItems();

    await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(req.body[1].validation, { status: 409, code: 'update_conflict', message: 'The entity changed' });
  });

  it('reports an unexpected failure as a 500 for that item, without its details', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new Error('connection reset')));
    const req = threeItems();

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(output[1].validation, { status: 500, code: 'internal_error', message: 'Internal server error' });
    assert.strictEqual(output[2].results[0].value, 'c');
  });

  it('counts the refused items, however they were refused, in the x-bulk-refused header', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new ApiError(400, 'refused', 'refused')));
    const req = threeItems();
    req.body.push({ id: DOC_9, body: { path: 'value', value: 'd' } });
    const res = createRes();

    await route._exec(req, res, await route._validate(req, {}));

    assert.strictEqual(res.headers['x-bulk-refused'], '2');
  });

  it('sends x-bulk-refused: 0 when every item was applied', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new ApiError(400, 'refused', 'refused')));
    const req = { body: [{ id: DOC_1, body: { path: 'value', value: 'a' } }], context: fullAccess };
    const res = createRes();

    await route._exec(req, res, await route._validate(req, {}));

    assert.strictEqual(res.headers['x-bulk-refused'], '0');
  });
});

describe('schema-routes/UpdateMany:_broadcast', () => {
  const applied = { id: DOC_1, sourceId: 'app-1', results: [{ type: 'scalar', path: 'value', value: 'updated' }] };
  const refused = { id: DOC_2, sourceId: 'app-1', results: null, validation: { code: 400, message: 'refused' } };

  afterEach(() => sinon.restore());

  it('broadcasts only the items that were applied', async () => {
    const broadcast = sinon.stub(Route.prototype, '_broadcast').resolves();
    const route = createRoute(createFakeModel([]));

    await route._broadcast({}, {}, [applied, refused], '/test-schema/bulk/update', true);

    assert.strictEqual(broadcast.callCount, 1);
    const [, , result, path, isSuper] = broadcast.firstCall.args;
    assert.deepStrictEqual(result, [applied]);
    assert.strictEqual(path, '/test-schema/bulk/update');
    assert.strictEqual(isSuper, true);
  });

  it('broadcasts nothing when every item was refused', async () => {
    const broadcast = sinon.stub(Route.prototype, '_broadcast').resolves();
    const route = createRoute(createFakeModel([]));

    await route._broadcast({}, {}, [refused], '/test-schema/bulk/update');

    assert.strictEqual(broadcast.called, false);
  });
});

// SR-DPC-001 S4
describe('schema-routes/UpdateMany:_withoutPrivate', () => {
  it("leaves each item's changes to a private property out of what realtime listeners are told", () => {
    const route = createRoute(createFakeModel([]));
    route._privatePaths = [['secret']];
    const items = [
      {
        id: DOC_1,
        results: [
          { type: 'scalar', path: 'value', value: 'updated' },
          { type: 'scalar', path: 'secret', value: 'hidden' },
        ],
      },
    ];

    assert.deepStrictEqual(route._withoutPrivate(items), [
      { id: DOC_1, results: [{ type: 'scalar', path: 'value', value: 'updated' }] },
    ]);
  });
});

// A bulk update's response is its items' changes, stripped as its activity is
describe('schema-routes/UpdateMany:_respond', () => {
  it("leaves each item's changes to a private property out of the response", async () => {
    const route = createRoute(createFakeModel([]));
    route._privatePaths = [['secret']];
    route.redactResults = false;
    route._close = () => {};
    const res = { json: sinon.spy(), set: sinon.spy(), statusCode: 200 };

    await route._respond({ context: { id: 'req-1', timer: { interval: 0, lapTime: 0 }, timings: {} } }, res, [
      { id: DOC_1, results: [{ type: 'scalar', path: 'secret', value: 'hidden' }, { type: 'scalar', path: 'value', value: 'v' }] },
    ]);

    assert.deepStrictEqual(res.json.firstCall.args[0], [{ id: DOC_1, results: [{ type: 'scalar', path: 'value', value: 'v' }] }]);
  });
});

describe('schema-routes/UpdateMany: a collection with remotes', () => {
  afterEach(() => sinon.restore());

  // agreement-1's partner names app-c, agreement-2's partner app, as its record's source, as when a partner names
  // another partner's app
  it('applies each item where its entity was read, whatever source it names, and tells the SPR where', async () => {
    const own = [{ id: DOC_1, value: 'original' }];
    const partner = [{ id: DOC_2, sourceId: 'app-c', value: 'original' }];
    const { model, datastores } = createFederatedSchemaModel(
      schema,
      own,
      { 'agreement-1': partner, 'agreement-2': [] },
      { 'agreement-1': 'app-a', 'agreement-2': 'app-c' },
    );
    const route = createRoute(model);
    const req = {
      body: [
        { id: DOC_1, body: { path: 'value', value: 'updated' } },
        { id: DOC_2, sourceId: 'app-c', body: { path: 'value', value: 'updated' } },
      ],
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };
    const broadcast = sinon.stub(Route.prototype, '_broadcast').resolves();

    const output = await route._exec(req, createRes(), await route._validate(req, {}));
    await route._broadcast(req, {}, output, '/test-schema/bulk/update');

    assert.deepStrictEqual([own[0].value, partner[0].value], ['updated', 'updated']);
    assert.deepStrictEqual(datastores['agreement-2'].calls.filter(([call]) => call !== 'find'), []);
    assert.deepStrictEqual(req.context.dataShareIds, [null, 'agreement-1']);
    assert.strictEqual(broadcast.callCount, 1);
  });

  it('refuses an item whose entity more than one partner has, when it names no source', async () => {
    const { model } = createFederatedSchemaModel(schema, [], {
      'agreement-1': [{ id: DOC_1, sourceId: 'app-a', value: 'original' }],
      'agreement-2': [{ id: DOC_1, sourceId: 'app-c', value: 'original' }],
    });
    const route = createRoute(model);
    const req = {
      body: [{ id: DOC_1, body: { path: 'value', value: 'updated' } }],
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };

    const [item] = await route._validate(req, {});

    assert.strictEqual(item.validation.status, 409);
    assert.strictEqual(item.validation.code, 'ambiguous_source');
  });
});
