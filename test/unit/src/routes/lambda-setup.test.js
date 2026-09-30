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

import { RoutesLambdaSetup } from '../../../../dist/routes/lambda-setup.js';
import Model from '../../../../dist/model/index.js';
import AppSchemaModel from '../../../../dist/model/core/app.js';
import LambdaSchemaModel from '../../../../dist/model/core/lambda.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';
import DeploymentSchemaModel from '../../../../dist/model/core/deployment.js';
import LambdaExecutionSchemaModel from '../../../../dist/model/core/lambda-execution.js';

afterEach(() => {
  sinon.restore();
});

describe('routes/RoutesLambdaSetup:__configureAppLambdaEndpoints', () => {
  it("registers an app's lambda endpoints once, however often it's asked to", async () => {
    const app = { all: sinon.spy(), use: sinon.spy() };
    const setup = new RoutesLambdaSetup(app, undefined, [], () => {});

    await setup.__configureAppLambdaEndpoints('app-one');
    await setup.__configureAppLambdaEndpoints('app-one');
    await setup.__configureAppLambdaEndpoints('app-two');

    assert.deepStrictEqual(app.all.args.map(([path]) => path), ['/lambda/v1/app-one/*endpoint', '/lambda/v1/app-two/*endpoint']);
    assert.strictEqual(app.use.callCount, 2);
  });
});

describe('routes/RoutesLambdaSetup: calling a lambda endpoint', () => {
  const apiTrigger = (url, method, type, extra = {}) => ({
    type: 'API_ENDPOINT',
    apiEndpoint: { url, method, type, redirect: false, useCallerToken: false, ...extra },
  });

  // NRP where a lambda's result comes back as soon as its call is queued, as fast as the manager and a runner could
  function createNrp(result) {
    const handlers = new Map();
    const nrp = {
      on: async (channel, handler) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return async () => handlers.set(channel, handlers.get(channel).filter((h) => h !== handler));
      },
      emit: async (channel, message) => {
        (handlers.get(channel) ?? []).forEach((handler) => handler(message));
        if (channel === 'rest:worker:exec-lambda-api') {
          const { executionId } = JSON.parse(message);
          await nrp.emit('lambda:worker:execution-result', JSON.stringify({ code: 200, reqId: 'req-1', executionId, ...result }));
        }
      },
    };
    return nrp;
  }

  // Calls the app's endpoint with `method` on `endpoint`, for a lambda with `triggers`, giving the response
  async function call({ triggers, method = 'GET', endpoint = 'hello', result = { res: { hello: 'world' } } }) {
    const executionAdd = sinon.stub().resolves({ id: 'exec-1' });
    const models = new Map([
      [AppSchemaModel, { findByApiPath: async () => ({ id: 'app-1' }) }],
      [LambdaSchemaModel, {
        createId: (v) => v,
        findOne: async () => ({ id: 'lambda-1', _appId: 'app-1', executable: true, git: { hash: 'HEAD' }, trigger: triggers }),
      }],
      [TokenSchemaModel, { createId: (v) => v }],
      [DeploymentSchemaModel, { createId: (v) => v, findOne: async () => ({ id: 'deployment-1' }) }],
      [LambdaExecutionSchemaModel, { add: executionAdd }],
    ]);
    sinon.stub(Model, 'getCoreModel').callsFake((model) => models.get(model));

    const app = { all: sinon.spy(), use: sinon.spy() };
    const setup = new RoutesLambdaSetup(app, createNrp(result), [], () => {});
    await setup.__configureAppLambdaEndpoints('app-one');
    const handler = app.all.firstCall.args[2];

    const req = {
      method, params: { endpoint }, query: {}, headers: {}, body: method === 'POST' ? { a: 1 } : undefined,
      context: { id: 'req-1' },
    };
    const res = { headers: {} };
    const answered = new Promise((resolve) => {
      res.set = (key, value) => (res.headers[key] = value);
      res.status = (code) => ((res.code = code), res);
      res.send = (body) => resolve(Object.assign(res, { body }));
      res.redirect = (url) => resolve(Object.assign(res, { redirectedTo: url }));
    });
    handler(req, res);
    const waiting = new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200));
    return { res: await Promise.race([answered, waiting]), executionAdd };
  }

  it('answers a SYNC call whose result comes back straight away', async () => {
    const { res } = await call({ triggers: [apiTrigger('hello', 'GET', 'SYNC')] });

    assert.notStrictEqual(res, 'still waiting');
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(res.body.res, { hello: 'world' });
  });

  it('calls the lambda through the trigger the request matched, and tells the runner which', async () => {
    const triggers = [apiTrigger('first', 'POST', 'ASYNC'), apiTrigger('second', 'GET', 'SYNC')];

    const { res, executionAdd } = await call({ triggers, endpoint: 'second' });

    assert.notStrictEqual(res, 'still waiting');
    assert.strictEqual(res.code, 200);
    assert.deepStrictEqual(res.body.res, { hello: 'world' });
    const { metadata, priority } = executionAdd.firstCall.args[0];
    assert.deepStrictEqual(metadata.find((m) => m.key === 'API_ENDPOINT'), {
      key: 'API_ENDPOINT',
      value: JSON.stringify({ url: 'second', method: 'GET' }),
    });
    assert.strictEqual(priority, 90);
  });

  it("encodes a redirect's query", async () => {
    const result = { res: { redirect: true, url: 'https://example.com/done', query: { next: '/a b&c=d', n: 1 } } };

    const { res } = await call({ triggers: [apiTrigger('hello', 'GET', 'SYNC', { redirect: true })], result });

    assert.strictEqual(res.redirectedTo, 'https://example.com/done?next=%2Fa%20b%26c%3Dd&n=1');
  });

  it('adds a redirect query to one the url already has', async () => {
    const result = { res: { redirect: true, url: 'https://example.com/done?from=lambda', query: { ok: 'yes' } } };

    const { res } = await call({ triggers: [apiTrigger('hello', 'GET', 'SYNC', { redirect: true })], result });

    assert.strictEqual(res.redirectedTo, 'https://example.com/done?from=lambda&ok=yes');
  });
});
