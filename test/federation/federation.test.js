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

// Two instances sharing data through real data sharing agreements. Stack a's app shares its cars with stack b's
// app, which reads, writes and follows them through a collection with remotes. Each scenario names the plan item it
// covers when it's a known gap.

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';

import AdminAccessPolicy from '../data/policy/admin-access.json' with { type: 'json' };
import { stacks, waitFor } from './stacks.mjs';

const { a, b } = stacks;

const carSchema = {
  name: 'car',
  type: 'collection',
  properties: {
    name: { __type: 'string', __default: null, __required: true, __allowUpdate: true },
    colour: { __type: 'string', __default: null, __required: false, __allowUpdate: true },
    n: { __type: 'number', __default: 0, __required: false, __allowUpdate: true },
  },
};
const COLOURS = ['red', 'blue'];
const SEED = 12;

// An app on a stack, with the car schema if it's to have its own cars
const createApp = async (stack, apiPath, schema) => {
  const app = await stack.call('POST', 'api/v1/app', {
    body: { name: apiPath, apiPath, policyPropertiesList: { adminAccess: [true] } },
  });
  if (schema) {
    await stack.call('PUT', 'api/v1/app/schema', { token: app.token, body: schema });
    await waitFor(`${apiPath}'s car routes`, async () => (await stack.request('GET', `${apiPath}/api/v1/car`, { token: app.token })).status === 200);
  }
  return app;
};

// A user of the app whose policy reads and writes everything, for realtime
const createAdminUser = async (stack, app, key) => {
  await stack.request('POST', 'api/v1/policy', { token: app.token, body: AdminAccessPolicy });
  const user = await stack.call('POST', 'api/v1/user', {
    token: app.token,
    body: {
      auth: [{ app: 'federation', appId: key, email: `${key}@example.com` }],
      token: { domains: [`localhost:${stack.restPort}`], policyProperties: { adminAccess: true } },
    },
  });
  return user.tokens[0].value;
};

/**
 * Pairs a sharing app on one stack with a consuming app on another, through the real handshake: the sharer
 * registers an agreement naming the consumer, and the consumer registers one back with its registration token, which
 * activates both. The consumer's car collection then reads the sharer's cars.
 */
const pair = async ({ sharer, sharerApp, consumer, consumerApp, name, query = { access: '%FULL_ACCESS%' } }) => {
  const agreement = (remoteStack, remoteApp, token) => ({
    remoteApp: { endpoint: remoteStack.rest, ws: remoteStack.sock, apiPath: remoteApp.apiPath, token },
    policyConfig: [{ verbs: ['%ALL%'], schema: ['%ALL%'], query }],
  });
  const shared = await sharer.call('POST', 'api/v1/app-data-sharing', {
    token: sharerApp.token,
    body: { name: `${name}-out`, ...agreement(consumer, consumerApp, null) },
  });
  const consuming = await consumer.call('POST', 'api/v1/app-data-sharing', {
    token: consumerApp.token,
    body: { name: `${name}-in`, ...agreement(sharer, sharerApp, shared.registrationToken) },
  });
  assert.strictEqual(consuming.active, true, 'the consuming agreement is active');

  await consumer.call('PUT', 'api/v1/app/schema', {
    token: consumerApp.token,
    body: [{ name: 'car', type: 'collection', remotes: [{ name: `${name}-in`, schema: 'car' }] }],
  });
  await waitFor(`${consumerApp.apiPath}'s car routes`, async () => (await consumer.request('GET', `${consumerApp.apiPath}/api/v1/car`, { token: consumerApp.token })).status === 200);
  return { shared, consuming };
};

describe('Federation', function () {
  this.timeout(60000);
  const env = {};

  before(async () => {
    env.appA = await createApp(a, 'fed-a', [carSchema]);
    env.cars = await a.call('POST', 'fed-a/api/v1/car/bulk/add', {
      token: env.appA.token,
      body: Array.from({ length: SEED }, (_, n) => ({ name: `car ${n}`, colour: COLOURS[n % 2], n })),
    });
    env.appB = await createApp(b, 'fed-b');
    env.agreements = await pair({ sharer: a, sharerApp: env.appA, consumer: b, consumerApp: env.appB, name: 'fed' });
    // The partner's cars as the consumer sees them, with their source
    const listed = await b.call('GET', 'fed-b/api/v1/car', { token: env.appB.token });
    env.cars = env.cars.map((car) => listed.find((seen) => seen.id === car.id) ?? car);
  });

  const fromB = (method, urlPath, body) => b.request(method, `fed-b/api/v1/${urlPath}`, { token: env.appB.token, body });

  describe('Reading a partner\'s data', () => {
    it("lists the partner's cars", async () => {
      const res = await fromB('GET', 'car');
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.map((car) => car.name).sort(), env.cars.map((car) => car.name).sort());
    });

    it("finds the partner's cars by a query (BUG-20)", async () => {
      const res = await fromB('SEARCH', 'car', { query: { colour: { $eq: 'red' } } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.length, SEED / 2);
      assert.ok(res.body.every((car) => car.colour === 'red'));
    });

    it("pages through the partner's cars", async () => {
      const res = await fromB('SEARCH', 'car', { query: {}, limit: 5, skip: 5, sort: { n: 1 } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.map((car) => car.n), [5, 6, 7, 8, 9]);
    });

    it("counts the partner's cars", async () => {
      const res = await fromB('SEARCH', 'car/count', { query: {} });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body, SEED);
    });

    it("gets one of the partner's cars by id (BUG-20: get has no :sourceId route)", async () => {
      const res = await fromB('GET', `car/${env.cars[3].id}`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.name, 'car 3');
    });
  });

  describe('Changing a partner\'s data', () => {
    const nameOnA = async (id) => (await a.call('GET', `fed-a/api/v1/car/${id}`, { token: env.appA.token })).name;

    // A partner's record is addressed by its source, the partner app
    const partnerCar = (car) => `car/${car.sourceId}/${car.id}`;

    it("updates one of the partner's cars (BUG-42: a read never records a lone partner's records)", async () => {
      await fromB('GET', 'car');
      const res = await fromB('PUT', partnerCar(env.cars[0]), { path: 'name', value: 'renamed from b' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(await nameOnA(env.cars[0].id), 'renamed from b');
    });

    it("updates one of the partner's cars after a restart, without a read first (BUG-42)", async () => {
      await b.restart(['rest']);
      const res = await fromB('PUT', partnerCar(env.cars[1]), { path: 'name', value: 'renamed after restart' });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(await nameOnA(env.cars[1].id), 'renamed after restart');
    });

    it("deletes one of the partner's cars (BUG-20: delete has no :sourceId route)", async () => {
      const res = await fromB('DELETE', `car/${env.cars[11].id}`);
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const onA = await a.request('GET', `fed-a/api/v1/car/${env.cars[11].id}`, { token: env.appA.token });
      assert.strictEqual(onA.status, 404);
    });
  });

  describe('Realtime', () => {
    const sockets = [];
    after(() => sockets.forEach((socket) => socket.close()));

    it("sends a change on the partner to the consumer's sockets (BUG-43)", async () => {
      const token = await createAdminUser(b, env.appB, 'fed-b-watcher');
      const watcher = await b.connectSocket('fed-b', token);
      sockets.push(watcher);

      await a.call('POST', 'fed-a/api/v1/car', { token: env.appA.token, body: { name: 'made on a', colour: 'red' } });

      await waitFor("a's new car on b's socket", () => watcher.received.some((activity) => activity.response?.name === 'made on a'));
    });

    it("sends a change made through the consumer to the partner's sockets (needs the update, BUG-42)", async () => {
      const token = await createAdminUser(a, env.appA, 'fed-a-watcher');
      const watcher = await a.connectSocket('fed-a', token);
      sockets.push(watcher);

      await fromB('PUT', `car/${env.cars[2].sourceId}/${env.cars[2].id}`, { path: 'name', value: 'changed through b' });

      await waitFor("b's change on a's socket", () =>
        watcher.received.some((activity) => JSON.stringify(activity.response ?? '').includes('changed through b')),
      );
    });
  });

  describe('Sharing limited by the agreement\'s policy', () => {
    before(async () => {
      env.appA2 = await createApp(a, 'fed-a2', [carSchema]);
      await a.call('POST', 'fed-a2/api/v1/car/bulk/add', {
        token: env.appA2.token,
        body: [{ name: 'red one', colour: 'red' }, { name: 'blue one', colour: 'blue' }],
      });
      env.appB2 = await createApp(b, 'fed-b2');
      await pair({
        sharer: a, sharerApp: env.appA2, consumer: b, consumerApp: env.appB2, name: 'fed2',
        query: { colour: { '@eq': 'red' } },
      });
    });

    it('lets the consumer read only what the policy shares', async () => {
      const res = await b.request('GET', 'fed-b2/api/v1/car', { token: env.appB2.token });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(res.body.map((car) => car.name), ['red one']);
    });

    it('relays only what the policy shares (SEC-7; BUG-46: remotes are read once, at connect; BUG-43)', async () => {
      const token = await createAdminUser(b, env.appB2, 'fed-b2-watcher');
      const watcher = await b.connectSocket('fed-b2', token);
      try {
        await a.call('POST', 'fed-a2/api/v1/car', { token: env.appA2.token, body: { name: 'blue two', colour: 'blue' } });
        await a.call('POST', 'fed-a2/api/v1/car', { token: env.appA2.token, body: { name: 'red two', colour: 'red' } });

        await waitFor('the red car on b', () => watcher.received.some((activity) => activity.response?.name === 'red two'));
        assert.ok(!watcher.received.some((activity) => activity.response?.name === 'blue two'), 'the blue car was relayed');
      } finally {
        watcher.close();
      }
    });
  });

  describe('Deactivation', () => {
    it("stops the consumer reading the partner's data once the partner deactivates its agreement (SEC-8)", async () => {
      await a.call('PUT', `api/v1/app-data-sharing/deactivate/${env.agreements.shared.id}`, { token: env.appA.token });

      const res = await fromB('GET', 'car');
      const names = res.status === 200 ? res.body.map((car) => car.name) : [];
      assert.ok(!names.some((name) => name.startsWith('car ')), `b still reads a's cars: ${JSON.stringify(res.body)}`);
    });
  });

  describe('A partner offline at boot', () => {
    after(async () => {
      if (!a.processes.rest) await a.start();
    });

    it('starts, and serves its own data, while its partner is down (BUG-41)', async () => {
      await a.stop();
      await b.restart();

      const own = await b.request('GET', 'api/v1/app/schema', { token: env.appB.token });
      assert.strictEqual(own.status, 200, JSON.stringify(own.body));
    });
  });
});
