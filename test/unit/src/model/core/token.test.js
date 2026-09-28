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
import { Readable } from 'node:stream';

import TokenSchemaModel from '../../../../../dist/model/core/token.js';

function createModel({ policyCache } = {}) {
  const nrp = { on: () => {}, emit: sinon.spy() };
  const services = new Map([
    ['nrp', nrp],
    ['modelManager', {}],
    ['policyCache', policyCache || { setTokenIdAsStale: sinon.stub().resolves() }],
  ]);
  const model = new TokenSchemaModel(services);
  model.adapter = {
    ID: { isValid: () => true, new: (v) => (v !== undefined ? { id: v } : { id: 'generated' }) },
    add: sinon.stub().resolves({ id: 'added' }),
    updateById: sinon.stub().resolves(),
    find: sinon.stub().callsFake(() => Readable.from([])),
  };
  return { model, nrp };
}

describe('model/core/TokenSchemaModel:constructor', () => {
  it('throws when policyCache is missing from services', () => {
    const nrp = { on: () => {} };
    const services = new Map([
      ['nrp', nrp],
      ['modelManager', {}],
    ]);
    assert.throws(() => new TokenSchemaModel(services), /Unable to find policyCache/);
  });

  it('exposes the token type constants', () => {
    const { model } = createModel();
    assert.deepStrictEqual(model.Constants.Type, {
      SYSTEM: 'system',
      APP: 'app',
      USER: 'user',
      DATA_SHARING: 'dataSharing',
      LAMBDA: 'lambda',
    });
  });
});

describe('model/core/TokenSchemaModel:createTokenString', () => {
  it('generates a 36-character alphanumeric token', () => {
    const { model } = createModel();
    const token = model.createTokenString();
    assert.strictEqual(token.length, 36);
    assert.match(token, /^[A-Za-z0-9]{36}$/);
  });

  it('generates a different token on each call', () => {
    const { model } = createModel();
    const a = model.createTokenString();
    const b = model.createTokenString();
    assert.notStrictEqual(a, b);
  });
});

describe('model/core/TokenSchemaModel:add', () => {
  it('always overwrites the value with a freshly generated token string', async () => {
    const { model } = createModel();

    await model.add({ type: 'user', value: 'client-supplied-value' }, {});

    assert.ok(model.adapter.add.calledOnce);
    const [body] = model.adapter.add.firstCall.args;
    assert.match(body.value, /^[A-Za-z0-9]{36}$/);
    assert.notStrictEqual(body.value, 'client-supplied-value');
  });
});

describe('model/core/TokenSchemaModel:findUserAuthTokens/findByValue', () => {
  it('queries by both app id and user id', () => {
    const { model } = createModel();
    const find = sinon.stub(model, 'find').returns('stream');

    const result = model.findUserAuthTokens('user-1', 'app-1');

    assert.strictEqual(result, 'stream');
    assert.deepStrictEqual(find.firstCall.args[0], {
      _appId: { id: 'app-1' },
      _userId: { id: 'user-1' },
    });
  });

  it('looks up a token by its value', async () => {
    const { model } = createModel();
    const findOne = sinon.stub(model, 'findOne').resolves('a-token');

    const result = await model.findByValue('token-value');

    assert.strictEqual(result, 'a-token');
    assert.deepStrictEqual(findOne.firstCall.args[0], { value: 'token-value' });
  });
});

describe('model/core/TokenSchemaModel:setPolicyPropertiesById', () => {
  it('persists the policy properties, busts the policy cache, and notifies routes', async () => {
    const policyCache = { setTokenIdAsStale: sinon.stub().resolves() };
    const { model, nrp } = createModel({ policyCache });

    await model.setPolicyPropertiesById('token-1', { role: 'admin' });

    assert.ok(model.adapter.updateById.calledOnce);
    const [id, update] = model.adapter.updateById.firstCall.args;
    assert.deepStrictEqual(id, { id: 'token-1' });
    assert.deepStrictEqual(update, { $set: { policyProperties: { role: 'admin' } } });
    assert.ok(policyCache.setTokenIdAsStale.calledWith('token-1'));
    assert.ok(nrp.emit.calledWith('app-routes:bust-cache', '{}'));
  });

  it('strips a stray query key from the policy properties before saving', async () => {
    const { model } = createModel();

    await model.setPolicyPropertiesById('token-1', { role: 'admin', query: { should: 'not-persist' } });

    const [, update] = model.adapter.updateById.firstCall.args;
    assert.deepStrictEqual(update.$set.policyProperties, { role: 'admin' });
  });
});

describe('model/core/TokenSchemaModel:updatePolicyProperties', () => {
  it('merges new policy properties on top of the existing ones', async () => {
    const policyCache = { setTokenIdAsStale: sinon.stub().resolves() };
    const { model, nrp } = createModel({ policyCache });
    const token = { id: 'token-1', policyProperties: { role: 'user', department: 'sales' } };

    await model.updatePolicyProperties(token, { role: 'admin' });

    const [id, update] = model.adapter.updateById.firstCall.args;
    assert.deepStrictEqual(id, { id: 'token-1' });
    assert.deepStrictEqual(update.$set.policyProperties, { role: 'admin', department: 'sales' });
    assert.ok(policyCache.setTokenIdAsStale.calledWith('token-1'));
    assert.ok(nrp.emit.calledWith('app-routes:bust-cache', '{}'));
  });

  it('starts from an empty base when the token has no existing policy properties', async () => {
    const { model } = createModel();
    const token = { id: 'token-1', policyProperties: null };

    await model.updatePolicyProperties(token, { role: 'admin' });

    const [, update] = model.adapter.updateById.firstCall.args;
    assert.deepStrictEqual(update.$set.policyProperties, { role: 'admin' });
  });

  it('strips a stray query key from the incoming policy properties', async () => {
    const { model } = createModel();
    const token = { id: 'token-1', policyProperties: {} };

    await model.updatePolicyProperties(token, { role: 'admin', query: { should: 'not-persist' } });

    const [, update] = model.adapter.updateById.firstCall.args;
    assert.deepStrictEqual(update.$set.policyProperties, { role: 'admin' });
  });
});

describe('model/core/TokenSchemaModel:clearPolicyPropertiesById', () => {
  it('clears the policy properties, busts the policy cache, and notifies routes', async () => {
    const policyCache = { setTokenIdAsStale: sinon.stub().resolves() };
    const { model, nrp } = createModel({ policyCache });

    await model.clearPolicyPropertiesById('token-1');

    const [id, update] = model.adapter.updateById.firstCall.args;
    assert.deepStrictEqual(id, { id: 'token-1' });
    assert.deepStrictEqual(update, { $set: { policyProperties: {} } });
    assert.ok(policyCache.setTokenIdAsStale.calledWith('token-1'));
    assert.ok(nrp.emit.calledWith('app-routes:bust-cache', '{}'));
  });
});

// REST keeps tokens in an in-memory cache (routes/tokens.ts), so a delete that didn't bust it
// would leave the deleted token working on REST.
describe('model/core/TokenSchemaModel:rm/rmBulk/rmAll', () => {
  const cases = [
    ['rm', 'token-1'],
    ['rmBulk', ['token-1', 'token-2']],
    ['rmAll', { _appId: 'app-1' }],
  ];

  for (const [method, arg] of cases) {
    it(`${method}() deletes the tokens, then notifies routes to reload their token cache`, async () => {
      const { model, nrp } = createModel();
      model.adapter[method] = sinon.stub().resolves('adapter-result');

      const result = await model[method](arg);

      assert.strictEqual(result, 'adapter-result');
      assert.deepStrictEqual(model.adapter[method].firstCall.args, [arg]);
      assert.ok(nrp.emit.calledWith('app-routes:bust-cache', '{}'));
      assert.ok(nrp.emit.calledAfter(model.adapter[method]), 'the cache should be busted after the delete');
    });
  }
});

// A socket already open with a token would keep receiving activity after the token was deleted, so every delete says
// which tokens went, for the Socket processes to close their sockets.
describe('model/core/TokenSchemaModel: token:deleted', () => {
  const deletedIds = (nrp) =>
    nrp.emit.args.filter(([event]) => event === 'token:deleted').map(([, json]) => JSON.parse(json).tokenIds);

  it('rm() and rmBulk() name the tokens they deleted, after deleting them', async () => {
    const { model, nrp } = createModel();
    model.adapter.rm = sinon.stub().resolves();
    model.adapter.rmBulk = sinon.stub().resolves();

    await model.rm('token-1');
    await model.rmBulk(['token-2', 'token-3']);

    assert.deepStrictEqual(deletedIds(nrp), [['token-1'], ['token-2', 'token-3']]);
    assert.ok(nrp.emit.withArgs('token:deleted').firstCall.calledAfter(model.adapter.rm.firstCall));
  });

  it('rmAll() looks up the tokens its query matches before deleting them, and names them', async () => {
    const { model, nrp } = createModel();
    model.adapter.find = sinon.stub().callsFake(() => Readable.from([{ id: 'token-1' }, { id: 'token-2' }]));
    model.adapter.rmAll = sinon.stub().resolves();

    await model.rmAll({ _appId: 'app-1' });

    assert.deepStrictEqual(model.adapter.find.firstCall.args[0], { _appId: 'app-1' });
    assert.ok(model.adapter.find.calledBefore(model.adapter.rmAll));
    assert.deepStrictEqual(model.adapter.rmAll.firstCall.args, [{ _appId: 'app-1' }]);
    assert.deepStrictEqual(deletedIds(nrp), [['token-1', 'token-2']]);
  });

  it('rmAll() names no tokens when its query matched none', async () => {
    const { model, nrp } = createModel();
    model.adapter.rmAll = sinon.stub().resolves();

    await model.rmAll({ _appId: 'app-1' });

    assert.deepStrictEqual(deletedIds(nrp), []);
  });
});

// A token's value can be changed in place (data-sharing activation does), and the old value would keep working on
// REST from the cache.
describe('model/core/TokenSchemaModel:updateById', () => {
  it('notifies routes to reload their token cache after the update', async () => {
    const { model, nrp } = createModel();

    await model.updateById('token-1', { $set: { value: 'new-value' } });

    assert.deepStrictEqual(model.adapter.updateById.firstCall.args, ['token-1', { $set: { value: 'new-value' } }]);
    assert.ok(nrp.emit.calledWith('app-routes:bust-cache', '{}'));
    assert.ok(nrp.emit.calledAfter(model.adapter.updateById));
  });

  it('still busts the cache once when policy properties are set', async () => {
    const { model, nrp } = createModel();

    await model.setPolicyPropertiesById('token-1', { role: 'admin' });

    assert.strictEqual(nrp.emit.withArgs('app-routes:bust-cache').callCount, 1);
  });
});
