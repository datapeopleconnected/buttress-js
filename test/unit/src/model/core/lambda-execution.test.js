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

import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';

import { createSchemaModel } from '../../../../schema-model.js';

// What's stored for a lambda execution, through the real model over a datastore in memory
describe('model/core/LambdaExecutionSchemaModel: what an execution is stored as', () => {
  const APP_ID = '6abd05000000000000000001';
  const TOKEN_ID = '6abd02000000000000000001';
  const CALLER_TOKEN_ID = '6abd02000000000000000009';
  const LAMBDA_ID = '6abd03000000000000000001';
  const DEPLOYMENT_ID = '6abd06000000000000000001';

  function createModel() {
    const services = new Map([
      ['nrp', { on: () => () => {}, emit: () => {} }],
      ['modelManager', { getCoreModel: () => ({ createId: (id) => id }) }],
    ]);
    const model = new LambdaExecutionSchemaModel(services);
    const { datastore } = createSchemaModel({ name: 'unused', properties: {} });
    model.adapter = datastore;
    return { model, datastore };
  }

  it("stores the execution's own properties, pending, with the schema's defaults for the rest", async () => {
    const { model, datastore } = createModel();
    const executeAfter = new Date('2030-01-01T00:00:00.000Z');

    const execution = await model.add(
      {
        lambdaId: LAMBDA_ID,
        deploymentId: DEPLOYMENT_ID,
        triggerType: 'API_ENDPOINT',
        executeAfter,
        metadata: [{ key: 'HEADERS', value: '{}' }],
        other: 'dropped',
      },
      { _appId: APP_ID, _tokenId: TOKEN_ID },
    );

    const rows = datastore.rows.map(({ createdAt, updatedAt, ...row }) => {
      assert(createdAt instanceof Date && updatedAt instanceof Date);
      return row;
    });
    assert.deepStrictEqual(rows, [
      {
        id: execution.id,
        lambdaId: LAMBDA_ID,
        deploymentId: DEPLOYMENT_ID,
        triggerType: 'API_ENDPOINT',
        status: 'PENDING',
        priority: 0,
        logs: [],
        executeAfter,
        startedAt: null,
        endedAt: null,
        nextCronExpression: null,
        metadata: [{ key: 'HEADERS', value: '{}' }],
        _appId: APP_ID,
        _tokenId: TOKEN_ID,
        _callerTokenId: null,
      },
    ]);
  });

  it("stores the token of the execution's caller, which is not the one it runs with", async () => {
    const { model, datastore } = createModel();

    await model.add(
      { lambdaId: LAMBDA_ID, deploymentId: DEPLOYMENT_ID },
      { _appId: APP_ID, _tokenId: null, _callerTokenId: CALLER_TOKEN_ID },
    );

    assert.strictEqual(datastore.rows[0]._callerTokenId, CALLER_TOKEN_ID);
    assert.strictEqual(datastore.rows[0]._tokenId, null);
  });

  it('stores no caller for an execution that was not called by a token', async () => {
    const { model, datastore } = createModel();

    await model.add({ lambdaId: LAMBDA_ID, deploymentId: DEPLOYMENT_ID }, { _appId: APP_ID, _callerTokenId: null });

    assert.strictEqual(datastore.rows[0]._callerTokenId, null);
  });

  it("takes the caller from the internals only, not from the execution's body", async () => {
    const { model, datastore } = createModel();

    await model.add(
      { lambdaId: LAMBDA_ID, deploymentId: DEPLOYMENT_ID, _callerTokenId: CALLER_TOKEN_ID, _tokenId: CALLER_TOKEN_ID },
      { _appId: APP_ID },
    );

    assert.strictEqual(datastore.rows[0]._callerTokenId, null);
    assert.strictEqual(datastore.rows[0]._tokenId, null);
  });

  it('stores an execution without a trigger type as a CRON one, its default', async () => {
    const { model, datastore } = createModel();

    await model.add({ lambdaId: LAMBDA_ID, deploymentId: DEPLOYMENT_ID }, { _appId: APP_ID });

    assert.strictEqual(datastore.rows[0].triggerType, 'CRON');
  });
});
