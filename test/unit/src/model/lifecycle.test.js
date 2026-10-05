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

import Model from '../../../../dist/model/index.js';
import StandardModel from '../../../../dist/model/type/standard.js';

const ModelManager = Model.constructor;

const carSchema = (properties = {}) => ({
  name: 'car',
  type: 'collection',
  extends: [],
  properties: { name: { __type: 'string', __default: '', __allowUpdate: true }, ...properties },
});

// NRP that delivers to what's subscribed, and says how many subscriptions are open
function createNrp() {
  const handlers = new Map();
  return {
    on: async (channel, handler) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return async () => handlers.set(channel, (handlers.get(channel) ?? []).filter((h) => h !== handler));
    },
    emit: (channel, message) => (handlers.get(channel) ?? []).forEach((handler) => handler(message)),
    subscriptions: (channel) => (handlers.get(channel) ?? []).length,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('model/type/StandardModel: lifecycle', () => {
  const app = { id: '507f1f77bcf86cd799439011' };

  function createModel(nrp, modelApp = app) {
    return new StandardModel(carSchema(), modelApp, new Map([['nrp', nrp], ['modelManager', {}]]));
  }

  it("flattens a schema change it's sent, so queries see the new properties", async () => {
    const nrp = createNrp();
    const model = createModel(nrp);
    await settle();

    const schemas = [carSchema({ colour: { __type: 'string', __default: '', __allowUpdate: true } })];
    nrp.emit('app:update-schema', JSON.stringify({ appId: app.id, schemas }));

    assert.ok(model.schemaData.properties.colour);
    assert.ok(model.flatSchemaData.colour);
  });

  it('stops listening for schema changes once destroyed', async () => {
    const nrp = createNrp();
    const model = createModel(nrp);
    await settle();
    assert.strictEqual(nrp.subscriptions('app:update-schema'), 1);

    await model.destroy();

    assert.strictEqual(nrp.subscriptions('app:update-schema'), 0);
  });

  it("doesn't listen for app schema changes for a core model, which has no app", async () => {
    const nrp = createNrp();
    createModel(nrp, null);
    await settle();

    assert.strictEqual(nrp.subscriptions('app:update-schema'), 0);
  });
});

describe('model/ModelManager: app model lifecycle', () => {
  afterEach(() => sinon.restore());

  function createManager() {
    const nrp = createNrp();
    const manager = new ModelManager();
    manager._services = new Map([['nrp', nrp], ['modelManager', manager]]);
    return { manager, nrp };
  }
  const app = { id: '507f1f77bcf86cd799439011', name: 'app one' };

  it('lets go of the model a rebuild replaces', async () => {
    const { manager, nrp } = createManager();

    for (let i = 0; i < 5; i++) await manager._initSchemaModel(app, carSchema(), null);
    await settle();

    assert.strictEqual(nrp.subscriptions('app:update-schema'), 1);
  });

  it("lets go of an app's models when they're dropped", async () => {
    const { manager, nrp } = createManager();
    await manager._initSchemaModel(app, carSchema(), null);
    sinon.stub(StandardModel.prototype, 'drop').resolves();
    await settle();

    await manager.dropAndCleanAppModels(app.id);

    assert.strictEqual(nrp.subscriptions('app:update-schema'), 0);
  });
});
