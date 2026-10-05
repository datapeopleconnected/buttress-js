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
import { Readable } from 'stream';

import Model from '../../../../../dist/model/index.js';
import TokenSchemaModel from '../../../../../dist/model/core/token.js';
import AppSchemaModel from '../../../../../dist/model/core/app.js';
import AppDataSharingSchemaModel from '../../../../../dist/model/core/app-data-sharing.js';
import DeploymentSchemaModel from '../../../../../dist/model/core/deployment.js';
import LambdaSchemaModel from '../../../../../dist/model/core/lambda.js';
import LambdaExecutionSchemaModel from '../../../../../dist/model/core/lambda-execution.js';
import PolicySchemaModel from '../../../../../dist/model/core/policy.js';
import UserSchemaModel from '../../../../../dist/model/core/user.js';
import AppRoutes from '../../../../../dist/routes/api/app.js';
import AppDataSharingRoutes from '../../../../../dist/routes/api/app-data-sharing.js';
import DeploymentRoutes from '../../../../../dist/routes/api/deployment.js';
import LambdaRoutes from '../../../../../dist/routes/api/lambda.js';
import LambdaExecutionRoutes from '../../../../../dist/routes/api/lambda-execution.js';
import PolicyRoutes from '../../../../../dist/routes/api/policy.js';
import UserRoutes from '../../../../../dist/routes/api/user.js';

import { realQueryParser } from '../../../../query-parser.js';

// The core search and count routes, run with the real parseQuery, so the tenant clause is checked as
// find() and count() receive it.

const APP_ID = '507f1f77bcf86cd799439011';

const byName = (routes, name) => {
  const RouteClass = routes.find((r) => r.name === name);
  if (!RouteClass) throw new Error(`No route class named ${name}`);
  return RouteClass;
};

const ROUTES = [
  { routes: PolicyRoutes, name: 'SearchPolicyList', SchemaModel: PolicySchemaModel, kind: 'search' },
  { routes: PolicyRoutes, name: 'PolicyCount', SchemaModel: PolicySchemaModel, kind: 'count' },
  { routes: LambdaRoutes, name: 'SearchLambdaList', SchemaModel: LambdaSchemaModel, kind: 'search' },
  { routes: LambdaRoutes, name: 'LambdaCount', SchemaModel: LambdaSchemaModel, kind: 'count' },
  {
    routes: LambdaExecutionRoutes,
    name: 'SearchExecutionList',
    SchemaModel: LambdaExecutionSchemaModel,
    kind: 'search',
  },
  {
    routes: LambdaExecutionRoutes,
    name: 'LambdaExecutionCount',
    SchemaModel: LambdaExecutionSchemaModel,
    kind: 'count',
  },
  { routes: DeploymentRoutes, name: 'SearchDeploymentList', SchemaModel: DeploymentSchemaModel, kind: 'search' },
  { routes: DeploymentRoutes, name: 'DeploymentCount', SchemaModel: DeploymentSchemaModel, kind: 'count' },
  { routes: UserRoutes, name: 'SearchUserList', SchemaModel: UserSchemaModel, kind: 'search' },
  { routes: UserRoutes, name: 'UserCount', SchemaModel: UserSchemaModel, kind: 'count' },
  { routes: AppRoutes, name: 'SearchAppList', SchemaModel: AppSchemaModel, kind: 'search', tenantKey: 'id' },
  {
    routes: AppDataSharingRoutes,
    name: 'SearchAppDataSharingAgreement',
    SchemaModel: AppDataSharingSchemaModel,
    kind: 'search',
  },
  {
    routes: AppDataSharingRoutes,
    name: 'AppDataSharingAgreementCount',
    SchemaModel: AppDataSharingSchemaModel,
    kind: 'count',
  },
];

const OTHER_APP_ID = '507f1f77bcf86cd799439022';

// Whether a query, as find() or count() receive it, selects a row: enough of the query language for these queries
const selects = (query, row) =>
  Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every((part) => selects(part, row));
    const field = key === '_id' ? 'id' : key;
    if (value && typeof value === 'object' && '$eq' in value) return String(row[field]) === String(value.$eq);
    return String(row[field]) === String(value);
  });

// The route's model, with the real parseQuery, recording the query each find and count receives
function stubModels(SchemaModel) {
  const parser = realQueryParser(SchemaModel);
  const queries = [];
  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    // The apps list looks up the tokens of the apps it finds, which here are none
    if (modelClass === TokenSchemaModel) {
      return { Constants: TokenSchemaModel.Constants, createId: (v) => v, find: async () => Readable.from([]) };
    }
    if (modelClass === SchemaModel) {
      return {
        ...parser,
        createId: (v) => v,
        find: async (query) => queries.push(query) && Readable.from([]),
        count: async (query) => queries.push(query) && 0,
      };
    }
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });
  return queries;
}

// The query the route's find or count receives, for a request with this body and token
async function queryOf(RouteClass, SchemaModel, { body, tokenType }) {
  const queries = stubModels(SchemaModel);
  const route = Object.create(RouteClass.prototype);
  const req = { body, params: {}, context: { id: 'req-1', authApp: { id: APP_ID }, token: { type: tokenType } } };
  await route._exec(req, {}, await route._validate(req, {}));
  assert.strictEqual(queries.length, 1, 'the route runs one find or count');
  return queries[0];
}

afterEach(() => {
  sinon.restore();
});

describe('routes/api: core search and count routes scope to the caller app', () => {
  for (const { routes, name, SchemaModel, kind, tenantKey = '_appId' } of ROUTES) {
    const RouteClass = byName(routes, name);
    const row = (appId, fields = {}) => ({ [tenantKey]: appId, ...fields });
    const bodies = kind === 'search' ? [{}, undefined] : [undefined, {}];

    describe(name, () => {
      for (const body of bodies) {
        it(`reaches only the caller's app for an app token, with body ${JSON.stringify(body)}`, async () => {
          const query = await queryOf(RouteClass, SchemaModel, { body, tokenType: 'app' });

          assert.deepStrictEqual([selects(query, row(APP_ID)), selects(query, row(OTHER_APP_ID))], [true, false]);
        });
      }

      it("keeps the caller's query alongside the app's", async () => {
        const query = await queryOf(RouteClass, SchemaModel, { body: { query: { name: 'x' } }, tokenType: 'app' });

        assert.deepStrictEqual(
          [
            selects(query, row(APP_ID, { name: 'x' })),
            selects(query, row(APP_ID, { name: 'y' })),
            selects(query, row(OTHER_APP_ID, { name: 'x' })),
          ],
          [true, false, false],
        );
      });

      it('reaches every app for a system token', async () => {
        const query = await queryOf(RouteClass, SchemaModel, { body: undefined, tokenType: 'system' });

        assert.strictEqual(selects(query, row(OTHER_APP_ID)), true);
      });
    });
  }
});
