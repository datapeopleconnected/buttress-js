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

import DeploymentSchemaModel from '../../../../../dist/model/core/deployment.js';

import { createSchemaModel } from '../../../../schema-model.js';

// What's stored for a lambda's deployment, through the real model over a datastore in memory
describe('model/core/DeploymentSchemaModel: what a deployment is stored as', () => {
  const APP_ID = '6abd05000000000000000001';
  const LAMBDA_ID = '6abd03000000000000000001';

  it('stores the lambda, hash and branch, deployed now', async () => {
    const services = new Map([
      ['nrp', { on: () => () => {}, emit: () => {} }],
      ['modelManager', {}],
    ]);
    const model = new DeploymentSchemaModel(services);
    const { datastore } = createSchemaModel({ name: 'unused', properties: {} });
    model.adapter = datastore;
    const before = Date.now();

    const deployment = await model.add({ lambdaId: LAMBDA_ID, hash: 'abc123', branch: 'main', other: 1 }, { _appId: APP_ID });

    const { deployedAt, ...row } = datastore.rows[0];
    assert.deepStrictEqual(row, { id: deployment.id, lambdaId: LAMBDA_ID, hash: 'abc123', branch: 'main', _appId: APP_ID });
    assert(deployedAt instanceof Date && deployedAt.getTime() >= before - 1000);
  });
});
