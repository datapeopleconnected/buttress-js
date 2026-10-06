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

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';

import {
  bjsReq,
  createApp,
  createPolicy,
  createPolicyUser,
  updateSchema,
  extractPolicyPropertyListFromPolicies,
  ENDPOINT,
} from '../../helpers.js';
import { runStep } from '../helpers.js';

import PolicyTestData from '../../data/policy/index.js';
import Budgets from '../../perf/io-budgets.json' with { type: 'json' };

import IOStats from '../../../dist/helpers/io-stats.js';
import BootstrapRest from '../../../dist/bootstrap-rest.js';
import BootstrapSPR from '../../../dist/bootstrap-spr.js';
import BootstrapSocket from '../../../dist/bootstrap-socket.js';

// Holds the MongoDB/Redis/NRP operations each request causes to an exact budget, see .ai/performance.md.
// Counts don't depend on the machine, so unlike timings they can fail a build without false alarms.

const BUDGETS_FILE = 'test/perf/io-budgets.json';

// Identical requests measured per budget. They must all cause the same I/O, or the budget would be meaningless.
const RUNS = 3;
// A unit of work is finished once its counts stop changing for this long. Requests leave work running after they
// respond (the activity log insert, broadcasts), so the response alone doesn't mean it's done.
const QUIET_MS = 200;
const SETTLE_TIMEOUT_MS = 5000;

const CATEGORIES = ['mongo', 'redis', 'nrp'];

let REST_PROCESS = null;
let SPR_PROCESS = null;
let SOCK_PROCESS = null;

const testEnv = {
  app: null,
  users: {},
  sockets: {},
  cars: [],
};

const carSchema = {
  name: 'car',
  type: 'collection',
  properties: {
    name: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true,
    },
    userId: {
      __type: 'id',
      __default: null,
      __required: false,
      __allowUpdate: true,
    },
  },
};

const sortKeys = (obj) => Object.fromEntries(Object.entries(obj ?? {}).sort(([a], [b]) => a.localeCompare(b)));

const usageOf = (counts) => Object.fromEntries(CATEGORIES.map((category) => [category, sortKeys(counts?.[category])]));

const totalOps = (counts) =>
  CATEGORIES.reduce((sum, category) => sum + Object.values(counts?.[category] ?? {}).reduce((a, b) => a + b, 0), 0);

// Wait for a unit of work to start (the SPR's starts when REST activity reaches it), then until it goes quiet.
const settledUsage = async (key) => {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = -1;
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    const counts = IOStats.get(key);
    const total = counts ? totalOps(counts) : -1;
    if (total !== last) {
      last = total;
      quietSince = Date.now();
    } else if (counts && Date.now() - quietSince >= QUIET_MS) {
      break;
    }
    await sleep(20);
  }

  const counts = IOStats.get(key);
  assert.ok(counts, `No I/O was recorded for "${key}" within ${SETTLE_TIMEOUT_MS}ms`);
  return { usage: usageOf(counts), log: [...counts.log] };
};

// Make a request to the app's API and return the I/O it caused.
const measureRequest = async ({ method = 'GET', path, body }, token) => {
  const res = await fetch(`${ENDPOINT.REST}/${testEnv.app.apiPath}/api/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.strictEqual(res.status, 200, `${method} ${path} returned ${res.status}: ${text}`);

  return settledUsage(res.headers.get('x-bjs-request-id'));
};

const createCar = async (name) => {
  const [car] = await bjsReq(
    {
      url: `${ENDPOINT.REST}/${testEnv.app.apiPath}/api/v1/car`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    testEnv.app.token,
  );
  return car;
};

const connectSocket = async (token) => {
  const socket = io(`${ENDPOINT.SOCK}/${testEnv.app.apiPath}`, { auth: { token }, forceNew: true });
  await new Promise((resolve) => socket.once('connect', resolve));
  return socket;
};

const formatLog = (log) => `Operations, in order:\n${log.map((entry) => `  ${entry}`).join('\n')}`;

const describeMismatch = (name, budget, { usage, log }) => {
  const lines = CATEGORIES.flatMap((category) => {
    const names = [...new Set([...Object.keys(budget[category]), ...Object.keys(usage[category])])].sort();
    return names.flatMap((op) => {
      const expected = budget[category][op] ?? 0;
      const actual = usage[category][op] ?? 0;
      if (expected === actual) return [];
      const delta = actual - expected;
      return [`  ${category} ${op}: budget ${expected}, now ${actual} (${delta > 0 ? '+' : ''}${delta})`];
    });
  });

  return [
    `I/O for "${name}" no longer matches its budget in ${BUDGETS_FILE}:`,
    ...lines,
    'More than budgeted is a regression: find the change that added it. Less is an improvement: lower the budget',
    'to lock it in. Budget changes need a maintainer to approve them, see .ai/performance.md.',
    `Now: "${name}": ${JSON.stringify(usage)}`,
    formatLog(log),
  ].join('\n');
};

const assertWithinBudget = (group, name, runs) => {
  const [first] = runs;
  if (!runs.every((run) => isDeepStrictEqual(run.usage, first.usage))) {
    assert.fail(
      [
        `"${name}" caused different I/O on identical runs, so it can't be held to a budget:`,
        ...runs.map((run, idx) => `  run ${idx + 1}: ${JSON.stringify(run.usage)}`),
        ...runs.map((run, idx) => `Run ${idx + 1} ${formatLog(run.log)}`),
      ].join('\n'),
    );
  }

  const budget = Budgets[group][name];
  if (!budget) {
    assert.fail(
      `No I/O budget for "${name}" under "${group}" in ${BUDGETS_FILE}. It caused:\n` +
        `  "${name}": ${JSON.stringify(first.usage)}\n${formatLog(first.log)}`,
    );
  }

  const expected = usageOf(budget);
  if (!isDeepStrictEqual(first.usage, expected)) assert.fail(describeMismatch(name, expected, first));
};

describe('I/O budgets', async () => {
  // admin-access is evaluated once for every token it applies to. env-user-query refers to the user, so the SPR has
  // to evaluate it for each connected token separately.
  const policies = [PolicyTestData['admin-access'], PolicyTestData['env-user-query']];

  before(async function () {
    this.timeout(60000);

    // Counting has to start before the processes connect, or their Mongo clients won't report commands.
    IOStats.enable();

    await runStep(
      'init REST process',
      async () => {
        REST_PROCESS = new BootstrapRest();
        await REST_PROCESS.init();
      },
      'IO budgets setup',
    );
    await runStep(
      'init SPR process',
      async () => {
        SPR_PROCESS = new BootstrapSPR();
        await SPR_PROCESS.init();
      },
      'IO budgets setup',
    );
    await runStep(
      'init SOCK process',
      async () => {
        SOCK_PROCESS = new BootstrapSocket();
        await SOCK_PROCESS.init();
      },
      'IO budgets setup',
    );

    testEnv.app = await runStep(
      'create app',
      () => createApp(ENDPOINT.REST, 'IO Budgets', 'io-budgets', extractPolicyPropertyListFromPolicies(policies)),
      'IO budgets setup',
    );
    await runStep('update app schema', () => updateSchema(ENDPOINT.REST, [carSchema], testEnv.app.token), 'IO budgets setup');
    await runStep(
      'create policies',
      async () => {
        for (const policy of policies) await createPolicy(ENDPOINT.REST, policy, testEnv.app.token);
      },
      'IO budgets setup',
    );
    await runStep(
      'create users',
      async () => {
        testEnv.users.admin1 = await createPolicyUser(ENDPOINT.REST, testEnv.app, 'io-admin-1', { adminAccess: true });
        testEnv.users.admin2 = await createPolicyUser(ENDPOINT.REST, testEnv.app, 'io-admin-2', { adminAccess: true });
        testEnv.users.owner1 = await createPolicyUser(ENDPOINT.REST, testEnv.app, 'io-owner-1', { envTest: 4 });
        testEnv.users.owner2 = await createPolicyUser(ENDPOINT.REST, testEnv.app, 'io-owner-2', { envTest: 4 });
      },
      'IO budgets setup',
    );
    await runStep(
      'seed cars',
      async () => {
        for (let i = 0; i < 5; i++) testEnv.cars.push(await createCar(`car ${i}`));
      },
      'IO budgets setup',
    );
  });

  after(async function () {
    Object.values(testEnv.sockets).forEach((socket) => socket.disconnect());
    if (REST_PROCESS) await REST_PROCESS.clean();
    if (SPR_PROCESS) await SPR_PROCESS.clean();
    if (SOCK_PROCESS) await SOCK_PROCESS.clean();
    IOStats.disable();
  });

  describe('REST requests, as a user with the admin-access policy', () => {
    let renames = 0;
    const requests = {
      'GET /car/:id': () => ({ path: `car/${testEnv.cars[0].id}` }),
      'GET /car': () => ({ path: 'car' }),
      'QUERY /car': () => ({ method: 'QUERY', path: 'car', body: { query: { name: 'car 1' } } }),
      'QUERY /car/count': () => ({ method: 'QUERY', path: 'car/count', body: { name: 'car 1' } }),
      'SEARCH /car': () => ({ method: 'SEARCH', path: 'car', body: { query: { name: 'car 1' } } }),
      'SEARCH /car/count': () => ({ method: 'SEARCH', path: 'car/count', body: { name: 'car 1' } }),
      'POST /car': () => ({ method: 'POST', path: 'car', body: { name: 'new car' } }),
      'POST /car/bulk/add (5 cars)': () => ({
        method: 'POST',
        path: 'car/bulk/add',
        body: [0, 1, 2, 3, 4].map((idx) => ({ name: `bulk car ${idx}` })),
      }),
      'PUT /car/:id': () => ({
        method: 'PUT',
        path: `car/${testEnv.cars[1].id}`,
        body: { path: 'name', value: `renamed ${++renames}` },
      }),
      'DELETE /car/:id': async () => ({ method: 'DELETE', path: `car/${(await createCar('to delete')).id}` }),
    };

    for (const [name, buildRequest] of Object.entries(requests)) {
      it(`${name} stays within its I/O budget`, async function () {
        this.timeout(20000);
        const token = testEnv.users.admin1.tokens[0].value;

        // The first request fills the token, policy and schema caches; every request after it takes the same path.
        await measureRequest(await buildRequest(), token);

        const runs = [];
        for (let i = 0; i < RUNS; i++) runs.push(await measureRequest(await buildRequest(), token));
        assertWithinBudget('rest', name, runs);
      });
    }
  });

  describe('SPR broadcasts', () => {
    const name = 'POST /car, 2 sockets on admin-access + 2 on env-user-query';

    before(async function () {
      this.timeout(20000);
      for (const user of ['admin1', 'admin2', 'owner1', 'owner2']) {
        testEnv.sockets[user] = await connectSocket(testEnv.users[user].tokens[0].value);
      }
      // Give the SPR time to cache the newly connected tokens against their policies.
      await sleep(500);
    });

    it(`${name} stays within its I/O budget`, async function () {
      this.timeout(30000);

      const measureBroadcast = async () => {
        IOStats.forget('spr');
        await bjsReq(
          {
            url: `${ENDPOINT.REST}/${testEnv.app.apiPath}/api/v1/car`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'broadcast car', userId: testEnv.users.owner1.id }),
          },
          testEnv.users.admin1.tokens[0].value,
        );
        return settledUsage('spr');
      };

      await measureBroadcast();

      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(await measureBroadcast());
      assertWithinBudget('spr', name, runs);
    });
  });
});
