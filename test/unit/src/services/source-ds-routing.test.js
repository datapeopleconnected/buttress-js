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

import { SourceDataSharingRouting } from '../../../../dist/services/source-ds-routing.js';

// A Redis shared by every routing service in a test, standing in for the one each process and worker connects to
const createRedis = () => {
  const data = new Map();
  const redis = {
    calls: 0,
    async get(key) {
      redis.calls++;
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value) {
      redis.calls++;
      data.set(key, value);
      return 'OK';
    },
  };
  return redis;
};

describe('services/SourceDataSharingRouting', () => {
  let clock;
  let redis;
  const routings = [];
  const createRouting = () => {
    const routing = new SourceDataSharingRouting(redis);
    routings.push(routing);
    return routing;
  };

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    redis = createRedis();
  });
  afterEach(() => {
    routings.splice(0).forEach((routing) => routing.clean());
    clock.restore();
  });

  it('routes a source it has been told about', async () => {
    const routing = createRouting();
    routing.inform('app-b', 'app-a', 'agreement-1');

    assert.strictEqual(await routing.get('app-b', 'app-a'), 'agreement-1');
  });

  it('routes a source that another process was told about', async () => {
    createRouting().inform('app-b', 'app-a', 'agreement-1');
    await clock.tickAsync(1000);

    assert.strictEqual(await createRouting().get('app-b', 'app-a'), 'agreement-1');
  });

  it("doesn't route a source for another app", async () => {
    createRouting().inform('app-b', 'app-a', 'agreement-1');
    await clock.tickAsync(1000);

    assert.strictEqual(await createRouting().get('app-c', 'app-a'), undefined);
  });

  it('takes a new route for a source', async () => {
    const routing = createRouting();
    routing.inform('app-b', 'app-a', 'agreement-1');
    await clock.tickAsync(1000);
    routing.inform('app-b', 'app-a', 'agreement-2');
    await clock.tickAsync(1000);

    assert.strictEqual(await routing.get('app-b', 'app-a'), 'agreement-2');
    assert.strictEqual(await createRouting().get('app-b', 'app-a'), 'agreement-2');
  });

  it('stops using Redis once its routes are stored', async () => {
    const routing = createRouting();
    routing.inform('app-b', 'app-a', 'agreement-1');
    await clock.tickAsync(1000);
    const calls = redis.calls;

    routing.inform('app-b', 'app-a', 'agreement-1');
    await clock.tickAsync(10000);

    assert.strictEqual(redis.calls, calls);
  });
});
