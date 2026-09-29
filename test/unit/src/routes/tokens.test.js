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

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import { Readable } from 'node:stream';

import RoutesTokens from '../../../../dist/routes/tokens.js';
import Model from '../../../../dist/model/index.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';

// The REST token cache, on a stand-in tokens collection that counts its queries
describe('routes/RoutesTokens:token cache', () => {
  let stored;
  // Ticks each findAll takes, in call order, one when none is given
  let loadTicks;
  let findAll;
  let findOne;

  const req = () => ({ context: { id: 'req-1', timer: null } });
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    stored = [{ id: 't1', value: 'known-1' }, { id: 't2', value: 'known-2' }];
    loadTicks = [];
    findAll = sinon.stub().callsFake(async () => {
      const snapshot = [...stored];
      const ticks = loadTicks.shift() ?? 1;
      for (let i = 0; i < ticks; i++) await tick();
      return Readable.from(snapshot, { objectMode: true });
    });
    findOne = sinon.stub().callsFake(async (query) => {
      const found = stored.find((t) => t.value === query.value) ?? null;
      await tick();
      return found;
    });
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
      if (modelClass !== TokenSchemaModel) throw new Error(`Unexpected core model ${modelClass?.name}`);
      return { findAll, findOne };
    });
  });

  afterEach(() => sinon.restore());

  const loaded = async () => {
    const cache = new RoutesTokens();
    await cache.loadTokens();
    findAll.resetHistory();
    return cache;
  };

  it('finds a cached token without querying', async () => {
    const cache = await loaded();

    assert.strictEqual((await cache._getToken(req(), 'known-2')).id, 't2');
    assert.strictEqual(findAll.callCount + findOne.callCount, 0);
  });

  it('looks an unknown token up by its value instead of reloading every token', async () => {
    const cache = await loaded();

    for (let i = 0; i < 5; i++) assert.strictEqual(await cache._getToken(req(), `unknown-${i}`), null);
    await Promise.all([1, 2, 3].map((i) => cache._getToken(req(), `unknown-concurrent-${i}`)));

    assert.strictEqual(findAll.callCount, 0);
    assert.strictEqual(findOne.callCount, 8);
    assert.deepStrictEqual(findOne.firstCall.args, [{ value: 'unknown-0' }]);
  });

  it('looks up nothing for a value that is not a non-empty string', async () => {
    const cache = await loaded();

    for (const value of [{ $ne: null }, ['known-1'], '', undefined]) {
      assert.strictEqual(await cache._getToken(req(), value), null);
    }
    assert.strictEqual(findOne.callCount, 0);
  });

  it('finds a token created since the cache was loaded, and caches it', async () => {
    const cache = await loaded();
    stored.push({ id: 't3', value: 'new-3' });

    assert.strictEqual((await cache._getToken(req(), 'new-3')).id, 't3');
    assert.strictEqual((await cache._getToken(req(), 'new-3')).id, 't3');
    assert.strictEqual(findOne.callCount, 1);
    assert.strictEqual(findAll.callCount, 0);
  });

  it('runs one reload for many cache busts, plus one after it for busts that arrive while it runs', async () => {
    const cache = await loaded();

    await Promise.all([1, 2, 3, 4, 5].map(() => cache.loadTokens()));

    assert.strictEqual(findAll.callCount, 2);
  });

  it('drops a token deleted while a reload was running, once the reload that follows it finishes', async () => {
    const cache = await loaded();
    // The reload that read the collection before the delete finishes last
    loadTicks = [5, 1];

    const first = cache.loadTokens();
    stored = stored.filter((t) => t.value !== 'known-1');
    await Promise.all([first, cache.loadTokens()]);

    assert.strictEqual(await cache._getToken(req(), 'known-1'), null);
  });

  it("doesn't cache a token found by value if the cache was reloaded meanwhile", async () => {
    const cache = await loaded();
    stored.push({ id: 't4', value: 'racing-4' });

    const lookup = cache._getToken(req(), 'racing-4');
    stored = stored.filter((t) => t.value !== 'racing-4');
    await cache.loadTokens();
    assert.strictEqual((await lookup).id, 't4');

    findOne.resetHistory();
    assert.strictEqual(await cache._getToken(req(), 'racing-4'), null);
    assert.strictEqual(findOne.callCount, 1);
  });
});
