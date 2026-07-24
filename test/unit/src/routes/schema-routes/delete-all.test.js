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

import DeleteAll from '../../../../../dist/routes/schema-routes/delete-all.js';

function createRoute(model) {
  const route = Object.create(DeleteAll.prototype);
  route.schemaName = 'test-schema';
  route.routeModel = async () => model;
  return route;
}

describe('schema-routes/DeleteAll', () => {
  it('_validate always resolves true', async () => {
    const route = createRoute({ rmAll: sinon.stub().resolves() });
    assert.strictEqual(await route._validate({}, {}), true);
  });

  it('_exec removes every entity in the collection and resolves true', async () => {
    const rmAll = sinon.stub().resolves();
    const route = createRoute({ rmAll });

    const result = await route._exec({}, {}, true);

    assert.ok(rmAll.calledOnceWith({}));
    assert.strictEqual(result, true);
  });
});
