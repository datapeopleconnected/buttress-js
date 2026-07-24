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

import AppSchemaModel from '../../../../../dist/model/core/app.js';
import ActivitySchemaModel from '../../../../../dist/model/core/activity.js';
import TrackingSchemaModel from '../../../../../dist/model/core/tracking.js';
import AppDataSharingSchemaModel from '../../../../../dist/model/core/app-data-sharing.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import DeploymentSchemaModel from '../../../../../dist/model/core/deployment.js';
import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';
import SecureStoreSchemaModel from '../../../../../dist/model/core/secure-store.js';
import PolicySchemaModel from '../../../../../dist/model/core/policy.js';

// AppSchemaModel.rm()'s real constructor/adapter setup need a live datastore, so bypass
// it and only wire up what rm() itself touches: __modelManager, __nrp, and adapter.rm.
function createModel() {
  const rmAllCalls = [];
  const getCoreModelCalls = [];

  const modelManager = {
    getCoreModel(modelClass) {
      getCoreModelCalls.push(modelClass);
      return { rmAll: async (query) => rmAllCalls.push({ model: modelClass, query }) };
    },
    dropAndCleanAppModels: async () => {},
  };

  const model = Object.create(AppSchemaModel.prototype);
  model.__modelManager = modelManager;
  model.__nrp = { emit: () => {}, on: () => {} };
  model.adapter = { rm: async () => true };

  return { model, rmAllCalls, getCoreModelCalls };
}

describe('model/core/AppSchemaModel', () => {
  describe('rm', () => {
    it('cascades the delete to Tracking, scoped to the deleted app', async () => {
      const { model, rmAllCalls } = createModel();
      const entity = { id: 'app-1', apiPath: '/test' };

      await model.rm(entity);

      const trackingCall = rmAllCalls.find((c) => c.model === TrackingSchemaModel);
      assert.ok(trackingCall, 'Tracking.rmAll should have been called');
      assert.deepStrictEqual(trackingCall.query, { _appId: 'app-1' });
    });

    it('does not cascade the delete to Activity (kept intentionally as an audit trail)', async () => {
      const { model, getCoreModelCalls } = createModel();
      const entity = { id: 'app-1', apiPath: '/test' };

      await model.rm(entity);

      assert.ok(
        !getCoreModelCalls.includes(ActivitySchemaModel),
        'Activity must not be part of the app-deletion cascade',
      );
    });

    it('still cascades the delete to every other previously-covered collection', async () => {
      const { model, getCoreModelCalls } = createModel();
      const entity = { id: 'app-1', apiPath: '/test' };

      await model.rm(entity);

      for (const expected of [
        AppDataSharingSchemaModel,
        TokenSchemaModel,
        UserSchemaModel,
        LambdaSchemaModel,
        DeploymentSchemaModel,
        LambdaExecutionSchemaModel,
        SecureStoreSchemaModel,
        PolicySchemaModel,
      ]) {
        assert.ok(getCoreModelCalls.includes(expected), `${expected.name} should still be part of the cascade`);
      }
    });
  });
});
