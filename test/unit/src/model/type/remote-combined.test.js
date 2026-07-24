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

import RemoteCombinedModel from '../../../../../dist/model/type/remote-combined.js';

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
});
