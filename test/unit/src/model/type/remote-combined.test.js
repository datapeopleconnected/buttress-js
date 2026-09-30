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
import { Readable } from 'stream';

import RemoteCombinedModel from '../../../../../dist/model/type/remote-combined.js';
import { SourceDataSharingRouting } from '../../../../../dist/services/source-ds-routing.js';

// RemoteCombinedModel's real constructor/initAdapter need a live app + datastore
// connections, so bypass them and set only the fields count() actually touches.
function createModel(localCount, remoteCounts) {
  const model = Object.create(RemoteCombinedModel.prototype);
  model._localModel = { count: async () => localCount };
  model._remoteModels = remoteCounts.map((count) => ({ count: async () => count }));
  return model;
}

describe('model/type/RemoteCombinedModel', () => {
  describe('count', () => {
    it('sums the local datastore count together with every remote count', async () => {
      const model = createModel(3, [2, 4]);

      const total = await model.count({});

      assert.strictEqual(total, 9);
    });

    it('still includes the local count when there are no remotes', async () => {
      const model = createModel(5, []);

      const total = await model.count({});

      assert.strictEqual(total, 5);
    });

    it('still includes remote counts when the local count is zero', async () => {
      const model = createModel(0, [7]);

      const total = await model.count({});

      assert.strictEqual(total, 7);
    });
  });

  // App b's collection reads app a's records through agreement-1. Each routing service shares one Redis, as the
  // processes and workers of an instance do.
  describe('routing to a partner', () => {
    const routings = [];
    afterEach(() => routings.splice(0).forEach((routing) => routing.clean()));

    const createRedis = () => {
      const data = new Map();
      return {
        get: async (key) => (data.has(key) ? data.get(key) : null),
        set: async (key, value) => data.set(key, value) && 'OK',
      };
    };
    const createRouting = (redis) => {
      const routing = new SourceDataSharingRouting(redis);
      routings.push(routing);
      return routing;
    };
    const createFederatedModel = (routing, partnerCars) => {
      const model = Object.create(RemoteCombinedModel.prototype);
      model.app = { id: 'app-b' };
      model._sdsRouting = routing;
      model._localModel = { find: async () => Readable.from([]) };
      model._remoteModels = [
        {
          dataSharingId: 'agreement-1',
          find: async () => Readable.from(partnerCars),
          updateByPath: async (body, id) => ({ agreement: 'agreement-1', id, body }),
        },
      ];
      return model;
    };
    const waitForRoutesStored = () => new Promise((resolve) => setTimeout(resolve, 150));

    it("routes a lone partner's records once they're read", async () => {
      const routing = createRouting(createRedis());
      const model = createFederatedModel(routing, [{ id: 'car-1', sourceId: 'app-a' }]);

      await (await model.find({})).toArray();

      assert.strictEqual(await routing.get('app-b', 'app-a'), 'agreement-1');
    });

    it('updates a partner record that another process read', async () => {
      const redis = createRedis();
      const reader = createFederatedModel(createRouting(redis), [{ id: 'car-1', sourceId: 'app-a' }]);
      await (await reader.find({})).toArray();
      await waitForRoutesStored();

      const writer = createFederatedModel(createRouting(redis), []);
      const result = await writer.updateByPath([{ path: 'name', value: 'renamed' }], 'car-1', 'app-a');

      assert.deepStrictEqual(result, { agreement: 'agreement-1', id: 'car-1', body: [{ path: 'name', value: 'renamed' }] });
    });
  });
});
