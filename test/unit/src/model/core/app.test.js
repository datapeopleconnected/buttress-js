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
import { Readable } from 'node:stream';
import ButtressExport from '@buttress/api';

import AppSchemaModel from '../../../../../dist/model/core/app.js';
import StandardModel from '../../../../../dist/model/type/standard.js';
import { restProcessIdentity } from '../../../../../dist/services/schema-applied.js';
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
import Logging from '../../../../../dist/helpers/logging.js';

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

describe('model/core/AppSchemaModel:apiPathProblem', () => {
  const model = Object.create(AppSchemaModel.prototype);
  model.adapter = { find: () => Readable.from([{ id: 'app-1', apiPath: 'shop' }], { objectMode: true }) };

  it('accepts a plain, unused api path, or the app keeping its own', async () => {
    assert.strictEqual(await model.apiPathProblem('new-app_2'), null);
    assert.strictEqual(await model.apiPathProblem('shop', 'app-1'), null);
  });

  it("refuses another app's api path, whatever its case", async () => {
    assert.strictEqual(await model.apiPathProblem('shop'), 'duplicate_api_path');
    assert.strictEqual(await model.apiPathProblem('SHOP', 'app-2'), 'duplicate_api_path');
  });

  it('refuses a reserved or malformed api path', async () => {
    for (const apiPath of ['api', 'Lambda', 'core', 'plugin-x'])
      assert.strictEqual(await model.apiPathProblem(apiPath), 'reserved_api_path');
    for (const apiPath of ['', '-x', 'a/b', 'a.b', '../x', 'a b', null, { $ne: 1 }]) {
      assert.strictEqual(await model.apiPathProblem(apiPath), 'invalid_api_path', JSON.stringify(apiPath));
    }
  });
});

describe('model/core/AppSchemaModel:mergeRemoteSchema', () => {
  it("gives a collection with remotes as it is while its partner can't be reached", async () => {
    const agreement = {
      name: 'from-partner',
      active: true,
      // Nothing listens on the discard port
      remoteApp: { endpoint: 'http://127.0.0.1:9', apiPath: 'partner', token: 'partner-token' },
    };
    const model = Object.create(AppSchemaModel.prototype);
    model.__modelManager = { getCoreModel: () => ({ find: async () => Readable.from([agreement]) }) };
    const collections = [
      { name: 'car', type: 'collection', properties: {}, remotes: [{ name: 'from-partner', schema: 'car' }] },
    ];

    const merged = await model.mergeRemoteSchema({ context: { authApp: { id: 'app-1' } } }, collections);

    assert.deepStrictEqual(
      merged.map((schema) => schema.name),
      ['car'],
    );
  });

  describe('a partner that answers with something other than a list of schemas', () => {
    afterEach(() => sinon.restore());

    // Partners that answer the schema request with what they're given, by their api path
    const answering = (answers) => {
      sinon.stub(ButtressExport.default, 'new').callsFake(() => {
        const api = {
          init: async ({ apiPath }) => {
            api.App = { getSchema: async () => answers[apiPath] };
          },
        };
        return api;
      });
      const agreements = Object.keys(answers).map((apiPath) => ({
        id: `dsa-${apiPath}`,
        name: `from-${apiPath}`,
        active: true,
        remoteApp: { endpoint: 'http://partner.test', apiPath, token: 'partner-token' },
      }));
      const model = Object.create(AppSchemaModel.prototype);
      model.__modelManager = { getCoreModel: () => ({ find: async () => Readable.from(agreements) }) };
      return model;
    };
    const collections = () => [
      { name: 'car', type: 'collection', properties: {}, remotes: [{ name: 'from-a', schema: 'car' }] },
      { name: 'boat', type: 'collection', properties: {}, remotes: [{ name: 'from-b', schema: 'boat' }] },
    ];
    const boat = { name: 'boat', type: 'collection', properties: { hull: { __type: 'string' } } };

    for (const [label, answer] of [
      ['an object', { statusCode: 500, message: 'Internal Server Error' }],
      ['a string', 'Bad Gateway'],
      ['nothing', undefined],
    ]) {
      it(`is left out when it answers with ${label}, keeping the other partners' schemas`, async () => {
        const warn = sinon.stub(Logging, 'logWarn');
        const model = answering({ a: answer, b: [boat] });

        const merged = await model.mergeRemoteSchema({ context: { authApp: { id: 'app-1' } } }, collections());

        assert.deepStrictEqual(merged.find((schema) => schema.name === 'car').properties, {});
        assert.deepStrictEqual(merged.find((schema) => schema.name === 'boat').properties, boat.properties);
        sinon.assert.calledOnceWithMatch(warn, 'dsa-a');
      });
    }

    it("passes over an item in a partner's list that isn't a schema", async () => {
      sinon.stub(Logging, 'logWarn');
      const model = answering({ a: [null, 'car'], b: [boat] });

      const merged = await model.mergeRemoteSchema({ context: { authApp: { id: 'app-1' } } }, collections());

      assert.deepStrictEqual(merged.find((schema) => schema.name === 'car').properties, {});
      assert.deepStrictEqual(merged.find((schema) => schema.name === 'boat').properties, boat.properties);
    });
  });
});

describe('model/core/AppSchemaModel:updateSchema', () => {
  afterEach(() => sinon.restore());

  // A pub/sub that announces a change as applied once the model has announced it, if asked to
  const createUpdater = ({ answers }) => {
    const handlers = new Map();
    const published = [];
    const nrp = {
      on: async (channel, handler) => handlers.set(channel, handler),
      emit: (channel, json) => {
        published.push([channel, JSON.parse(json)]);
        if (channel === 'app-schema:updated' && answers) {
          const { changeId, appId } = JSON.parse(json);
          if (changeId)
            setImmediate(() =>
              handlers.get('app-schema:applied')(JSON.stringify({ changeId, appId, ...restProcessIdentity() })),
            );
        }
      },
    };
    sinon.stub(StandardModel.prototype, 'updateById').resolves();
    sinon.stub(StandardModel.prototype, 'findById').resolves({ __rawSchema: '[]' });
    const model = Object.create(AppSchemaModel.prototype);
    model.__nrp = nrp;
    return { model, published };
  };

  it('answers once the workers have the change, when asked to wait for them', async () => {
    const { model, published } = createUpdater({ answers: true });
    let done = false;

    const update = model.updateSchema('app-1', [], '[]', { waitForWorkers: true }).then(() => (done = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(done, false, 'answered before the workers had it');

    await update;
    const [, message] = published.find(([channel]) => channel === 'app-schema:updated');
    assert.strictEqual(message.appId, 'app-1');
    assert.strictEqual(typeof message.changeId, 'string');
  });

  it('answers as soon as the change is announced when not asked to wait', async () => {
    const { model, published } = createUpdater({ answers: false });

    await model.updateSchema('app-1', [], '[]');

    const [, message] = published.find(([channel]) => channel === 'app-schema:updated');
    assert.strictEqual(message.changeId, undefined);
  });
});
