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
import UpdateMany from '../../../../../dist/routes/schema-routes/update-many.js';
import { RequestError } from '../../../../../dist/helpers/errors.js';

function createFakeModel(docs) {
  return {
    createId: (id) => id,
    flatSchemaData: {},
    parseQuery: (query) => query,
    find(query) {
      const matches = docs.filter((doc) => matchesQuery(doc, query));
      return Readable.from(matches, { objectMode: true });
    },
    validateUpdate(body) {
      return { validation: { isValid: true }, body };
    },
    async exists(id) {
      return docs.some((doc) => doc.id === id);
    },
    async updateByPath(body, id) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) return null;
      doc.value = body.value;
      return doc;
    },
  };
}

function matchesQuery(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  if (query.$and) return query.$and.every((q) => matchesQuery(doc, q));
  return Object.keys(query).every((key) => {
    const cond = query[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && '$in' in cond) {
      return cond.$in.some((v) => `${v}` === `${doc[key]}`);
    }
    return `${doc?.[key]}` === `${cond}`;
  });
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
    { id: 'doc-1', ownerId: 'user-1', value: 'original' },
    { id: 'doc-2', ownerId: 'user-2', value: 'original' },
  ];

  it('updates every entity when the token has full access', async () => {
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [
        { id: 'doc-1', body: { path: 'value', value: 'updated' } },
        { id: 'doc-2', body: { path: 'value', value: 'updated' } },
      ],
      context: { id: 'req-1', ac: { policyConfigs: [{}] } },
    };

    const validate = await route._validate(req, {});
    await route._exec(req, createRes(), validate);

    assert.strictEqual(docs.find((d) => d.id === 'doc-1').value, 'updated');
    assert.strictEqual(docs.find((d) => d.id === 'doc-2').value, 'updated');
  });

  it('marks an entity outside the access-control policy scope invalid and does not apply its update', async () => {
    // doc-2 belongs to user-2, but the policy only scopes to user-1's records.
    const docs = makeDocs();
    const route = createRoute(createFakeModel(docs));
    const req = {
      body: [
        { id: 'doc-1', body: { path: 'value', value: 'updated' } },
        { id: 'doc-2', body: { path: 'value', value: 'updated' } },
      ],
      context: { id: 'req-1', ac: { policyConfigs: [{ query: { ownerId: 'user-1' } }] } },
    };

    const validate = await route._validate(req, {});

    const doc1Update = validate.find((u) => u.id === 'doc-1');
    const doc2Update = validate.find((u) => u.id === 'doc-2');
    assert.strictEqual(doc1Update.validation, true);
    assert.notStrictEqual(doc2Update.validation, true);

    await route._exec(req, createRes(), validate);

    assert.strictEqual(docs.find((d) => d.id === 'doc-1').value, 'updated');
    assert.strictEqual(
      docs.find((d) => d.id === 'doc-2').value,
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
    const docs = [{ id: 'doc-1', value: 'original' }];
    const route = createRoute(createPathCheckingModel(docs));
    const req = {
      body: [
        { id: 'doc-1', body: { path: 'value', value: 'updated' } },
        { id: 'doc-1', body: { path: 'bad', value: 'x' } },
      ],
      context: fullAccess,
    };

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.strictEqual(docs[0].value, 'updated');
    assert.deepStrictEqual(output[0].results, [{ type: 'scalar', path: 'value', value: 'updated' }]);
    assert.strictEqual(output[1].results, null);
    assert.deepStrictEqual(output[1].validation, { code: 400, message: 'test-schema: Update path is invalid: bad' });
  });

  it('returns one result per request item, in request order', async () => {
    const docs = [{ id: 'doc-1' }, { id: 'doc-2' }];
    const route = createRoute(createPathCheckingModel(docs));
    const req = {
      body: [
        { id: 'doc-2', body: { path: 'value', value: 'a' } },
        { id: 'doc-1', body: { path: 'value', value: 'b' } },
        { id: 'doc-2', body: { path: 'value', value: 'c' } },
      ],
      context: fullAccess,
    };

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(
      output.map((o) => [o.id, o.results[0].value]),
      [
        ['doc-2', 'a'],
        ['doc-1', 'b'],
        ['doc-2', 'c'],
      ],
    );
    assert.strictEqual(docs[1].value, 'c');
  });

  it('refuses an update to an entity that does not exist, saying so', async () => {
    const route = createRoute(createPathCheckingModel([]));
    const req = { body: [{ id: 'doc-9', body: { path: 'value', value: 'x' } }], context: fullAccess };

    const [item] = await route._validate(req, {});

    assert.deepStrictEqual(item.validation, { code: 400, message: 'test-schema: Invalid ID: doc-9' });
  });

  it('looks each entity up once, however many updates it has', async () => {
    const model = createPathCheckingModel([{ id: 'doc-1' }]);
    const route = createRoute(model);
    const req = {
      body: [
        { id: 'doc-1', body: { path: 'value', value: 'a' } },
        { id: 'doc-1', body: { path: 'value', value: 'b' } },
      ],
      context: fullAccess,
    };

    await route._validate(req, {});

    assert.strictEqual(model.exists.callCount, 1);
  });
});

describe('schema-routes/UpdateMany: items that fail while being written', () => {
  const fullAccess = { id: 'req-1', ac: { policyConfigs: [{}] } };

  // Writes doc-1 and doc-3; doc-2's write fails with `error`.
  function createFailingModel(docs, error) {
    const model = createFakeModel(docs);
    model.updateByPath = async (body, id) => {
      if (id === 'doc-2') throw error;
      docs.find((d) => d.id === id).value = body.value;
      return [{ type: 'scalar', path: 'value', value: body.value }];
    };
    return model;
  }

  const threeItems = () => ({
    body: [
      { id: 'doc-1', body: { path: 'value', value: 'a' } },
      { id: 'doc-2', body: { path: 'value', value: 'b' } },
      { id: 'doc-3', body: { path: 'value', value: 'c' } },
    ],
    context: fullAccess,
  });

  const makeDocs = () => [{ id: 'doc-1' }, { id: 'doc-2' }, { id: 'doc-3' }];

  it('reports an item whose write fails as refused, and carries on with the rest', async () => {
    const docs = makeDocs();
    const error = new RequestError(400, "Update can't be applied: Cannot create field 'x' in element {meta: null}");
    const route = createRoute(createFailingModel(docs, error));
    const req = threeItems();

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(
      output.map((o) => o.validation ?? o.results[0].value),
      ['a', { code: 400, message: error.message }, 'c'],
    );
    assert.strictEqual(output[1].results, null);
    assert.deepStrictEqual(
      docs.map((d) => d.value),
      ['a', undefined, 'c'],
    );
  });

  it('marks the failed item refused on the request, so it triggers no path lambdas', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new RequestError(409, 'The entity changed')));
    const req = threeItems();

    await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(req.body[1].validation, { code: 409, message: 'The entity changed' });
  });

  it('reports an unexpected failure as a 500 for that item, without its details', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new Error('connection reset')));
    const req = threeItems();

    const output = await route._exec(req, createRes(), await route._validate(req, {}));

    assert.deepStrictEqual(output[1].validation, { code: 500, message: 'Internal Server Error' });
    assert.strictEqual(output[2].results[0].value, 'c');
  });

  it('counts the refused items, however they were refused, in the x-bulk-refused header', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new RequestError(400, 'refused')));
    const req = threeItems();
    req.body.push({ id: 'doc-9', body: { path: 'value', value: 'd' } });
    const res = createRes();

    await route._exec(req, res, await route._validate(req, {}));

    assert.strictEqual(res.headers['x-bulk-refused'], '2');
  });

  it('sends x-bulk-refused: 0 when every item was applied', async () => {
    const route = createRoute(createFailingModel(makeDocs(), new RequestError(400, 'refused')));
    const req = { body: [{ id: 'doc-1', body: { path: 'value', value: 'a' } }], context: fullAccess };
    const res = createRes();

    await route._exec(req, res, await route._validate(req, {}));

    assert.strictEqual(res.headers['x-bulk-refused'], '0');
  });
});

describe('schema-routes/UpdateMany:_broadcast', () => {
  const applied = { id: 'doc-1', sourceId: 'app-1', results: [{ type: 'scalar', path: 'value', value: 'updated' }] };
  const refused = { id: 'doc-2', sourceId: 'app-1', results: null, validation: { code: 400, message: 'refused' } };

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
