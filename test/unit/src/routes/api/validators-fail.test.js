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

import Model from '../../../../../dist/model/index.js';
import PolicyRoutes from '../../../../../dist/routes/api/policy.js';
import LambdaRoutes from '../../../../../dist/routes/api/lambda.js';
import LambdaExecutionRoutes from '../../../../../dist/routes/api/lambda-execution.js';
import UserRoutes from '../../../../../dist/routes/api/user.js';
import AppDataSharingRoutes from '../../../../../dist/routes/api/app-data-sharing.js';
import TrackingRoutes from '../../../../../dist/routes/api/tracking.js';

const HEX_ID = '507f1f77bcf86cd799439011';
const byName = (routes, name) => routes.find((r) => r.name === name);

// Every datastore call fails, as when the database is unreachable
const failingModel = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === 'validateUpdate') return () => ({ validation: { isValid: true }, body: [{ path: 'name', value: 'x' }] });
    if (prop === 'createId') return (v) => v;
    if (prop === 'Constants') return { Type: { SYSTEM: 'system' } };
    if (prop === 'then') return undefined;
    return () => Promise.reject(new Error('datastore unreachable'));
  },
});

describe('routes/api: validators whose datastore calls fail', () => {
  afterEach(() => sinon.restore());

  for (const [routes, name] of [
    [PolicyRoutes, 'UpdatePolicy'],
    [LambdaRoutes, 'UpdateLambda'],
    [LambdaExecutionRoutes, 'UpdateLambdaExecution'],
    [UserRoutes, 'UpdateUser'],
    [UserRoutes, 'clearUserLocalData'],
    [AppDataSharingRoutes, 'UpdateAppDataSharingPolicy'],
    [TrackingRoutes, 'UpdateTracking'],
  ]) {
    it(`${name} fails the request rather than leaving it without an answer`, async () => {
      sinon.stub(Model, 'getCoreModel').returns(failingModel);
      const RouteClass = byName(routes, name);
      assert.ok(RouteClass, name);
      const route = Object.create(RouteClass.prototype);
      const req = {
        params: { id: HEX_ID, dataSharingId: HEX_ID },
        body: [{ path: 'name', value: 'x' }],
        context: { id: 'req-1', authApp: { id: 'app-1' }, token: { type: 'app' } },
      };

      const outcome = await Promise.race([
        Promise.resolve(route._validate(req, {})).then(() => 'resolved', () => 'rejected'),
        new Promise((resolve) => setTimeout(() => resolve('no answer'), 500)),
      ]);
      assert.strictEqual(outcome, 'rejected');
    });
  }
});
