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

// npm run bench: measures a build's REST performance and writes the results to a JSON file, for
// npm run bench:compare. It boots the build as its own process against a scratch database, sends each scenario's
// request at a fixed concurrency, and records throughput, latency and the server's CPU time per request.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

import { MongoClient } from 'mongodb';
import { createClient } from '@redis/client';

import AdminAccessPolicy from '../data/policy/admin-access.json' with { type: 'json' };

const USAGE = `Usage: npm run bench -- [options]

Measures the REST performance of a build and writes the results to a JSON file.
Compare two results files with: npm run bench:compare -- <base.json> <head.json>

Options:
  --dist <dir>         build to measure (default: dist)
  --out <file>         results file (default: bench-results/<commit>-<time>.json)
  --label <text>       label stored in the results, e.g. the change being measured
  --duration <s>       seconds each scenario runs per round (default: 3)
  --rounds <n>         rounds; scenarios take turns within each round (default: 5)
  --concurrency <n>    requests in flight at once (default: 10)
  --scenarios <list>   comma-separated subset of: SCENARIO_NAMES
  --port <n>           port for the build's REST server (default: 8100)

MongoDB and Redis come from BENCH_MONGO_URL (default mongodb://localhost:27017) and BENCH_REDIS_URL
(default redis://localhost:6379). The benchmark uses its own database (bjs-bench-prod) and Redis key prefix
(bjs-bench:), clears them before and after the run, and leaves everything else alone.`;

// Isolates the benchmark from other data on the same MongoDB/Redis: the app code names the database
// (<code>-<env>, see DatastoreFactory) and prefixes every Redis key and NRP channel (Config.redis.scope).
const APP_CODE = 'bjs-bench';
const NODE_ENV = 'production';
const API_PATH = 'bench';
const SEED_CARS = 1000;
const WARM_UP_MS = 1000;

// Each scenario builds the request for its nth call, given the ids of the seeded cars. Paths are relative to the
// app's API, /bench/api/v1.
const SCENARIOS = {
  'get-one': {
    description: 'GET one car by id',
    request: ({ cars }) => ({ method: 'GET', path: `car/${cars[0].id}` }),
  },
  list: {
    description: `GET all ${SEED_CARS} cars, streamed`,
    request: () => ({ method: 'GET', path: 'car' }),
  },
  search: {
    description: 'SEARCH cars by name',
    request: () => ({ method: 'SEARCH', path: 'car', body: { query: { name: 'car 7' } } }),
  },
  post: {
    description: 'POST one note',
    request: (_fixture, n) => ({ method: 'POST', path: 'note', body: { name: `note ${n}` } }),
  },
  put: {
    description: 'PUT a path update to a car',
    request: ({ cars }, n) => ({
      method: 'PUT',
      path: `car/${cars[100 + (n % 100)].id}`,
      body: { path: 'name', value: `renamed ${n}` },
    }),
  },
};

const fail = (message) => {
  console.error(`bench: ${message}`);
  process.exit(1);
};

const parseOptions = () => {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        dist: { type: 'string', default: 'dist' },
        out: { type: 'string' },
        label: { type: 'string', default: '' },
        duration: { type: 'string', default: '3' },
        rounds: { type: 'string', default: '5' },
        concurrency: { type: 'string', default: '10' },
        scenarios: { type: 'string' },
        port: { type: 'string', default: '8100' },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch (err) {
    fail(`${err.message}\n\n${usage()}`);
  }
  if (parsed.help) {
    console.log(usage());
    process.exit(0);
  }

  const positive = (name) => {
    const value = Number(parsed[name]);
    if (!(value > 0)) fail(`--${name} must be a positive number`);
    return value;
  };
  const scenarios = parsed.scenarios ? parsed.scenarios.split(',').map((name) => name.trim()) : Object.keys(SCENARIOS);
  const unknown = scenarios.filter((name) => !SCENARIOS[name]);
  if (unknown.length) fail(`unknown scenario ${unknown.join(', ')}; choose from ${Object.keys(SCENARIOS).join(', ')}`);

  return {
    dist: path.resolve(parsed.dist),
    out: parsed.out,
    label: parsed.label,
    durationS: positive('duration'),
    rounds: Math.round(positive('rounds')),
    concurrency: Math.round(positive('concurrency')),
    port: Math.round(positive('port')),
    scenarios,
  };
};

const usage = () => USAGE.replace('SCENARIO_NAMES', Object.keys(SCENARIOS).join(', '));

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

// Newest modification time of any file under dir, to spot a build older than its source.
const newestMtime = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    const entryPath = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtime(entryPath) : fs.statSync(entryPath).mtimeMs;
    return Math.max(newest, mtime);
  }, 0);

const describeBuild = (dist) => {
  const entry = path.join(dist, 'bin', 'app.js');
  if (!fs.existsSync(entry)) fail(`no build at ${dist}; run npm run build first`);

  const root = path.dirname(dist);
  const builtAt = fs.statSync(entry).mtimeMs;
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir) && newestMtime(srcDir) > builtAt) {
    console.warn(`bench: warning: ${srcDir} has changed since ${dist} was built; run npm run build to measure it`);
  }

  const status = git(root, 'status', '--porcelain', '--untracked-files=no');
  return {
    entry,
    dist,
    builtAt: new Date(builtAt).toISOString(),
    git: {
      commit: git(root, 'rev-parse', 'HEAD'),
      branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD'),
      dirty: status === null ? null : status !== '',
    },
  };
};

// ---- Scratch datastore ----

const mongoUrl = process.env.BENCH_MONGO_URL || 'mongodb://localhost:27017';
const redisUrl = process.env.BENCH_REDIS_URL || 'redis://localhost:6379';
// Mirrors DatastoreFactory: a connection string without a database gets <app code>-<env>.
const dbName = new URL(mongoUrl).pathname.replace(/^\//, '') || `${APP_CODE}-prod`;

const clearDatastores = async () => {
  const mongo = await MongoClient.connect(mongoUrl, { serverSelectionTimeoutMS: 5000 });
  try {
    await mongo.db(dbName).dropDatabase();
  } finally {
    await mongo.close();
  }

  const redis = createClient({ url: redisUrl });
  await redis.connect();
  try {
    for await (const keys of redis.scanIterator({ MATCH: `${APP_CODE}:*`, COUNT: 500 })) {
      const batch = Array.isArray(keys) ? keys : [keys];
      if (batch.length) await redis.del(batch);
    }
  } finally {
    await redis.close();
  }
};

const datastoreVersions = async () => {
  const mongo = await MongoClient.connect(mongoUrl, { serverSelectionTimeoutMS: 5000 });
  const redis = createClient({ url: redisUrl });
  try {
    await redis.connect();
    const info = await redis.info('server');
    return {
      mongo: (await mongo.db('admin').command({ buildInfo: 1 })).version,
      redis: info.match(/redis_version:(\S+)/)?.[1] ?? null,
    };
  } finally {
    await mongo.close();
    await redis.close();
  }
};

// ---- The build's REST server ----

const serverEnv = (workDir, port) => ({
  ...process.env,
  NODE_ENV,
  // Points the config loader at an env file that doesn't exist, so no .<env>.env overrides these settings.
  ENV_FILE: 'bench',
  SERVER_ID: 'bench',
  BUTTRESS_APP_TITLE: 'ButtressJS bench',
  BUTTRESS_APP_CODE: APP_CODE,
  BUTTRESS_APP_PATH: workDir,
  BUTTRESS_APP_WORKERS: '0',
  BUTTRESS_APP_PROTOCOL: 'http',
  BUTTRESS_HOST_URL: `localhost:${port}`,
  BUTTRESS_REST_LISTEN_PORT: String(port),
  BUTTRESS_DATASTORE_CONNECTION_STRING: mongoUrl,
  BUTTRESS_REDIS_URL: redisUrl,
  BUTTRESS_LOGGING_LEVEL: 'error',
});

const install = (build, env, logFd) => {
  const result = spawnSync(process.execPath, [build.entry], {
    env: { ...env, INSTALL_MODE: 'true' },
    stdio: ['ignore', logFd, logFd],
    timeout: 60000,
  });
  if (result.status !== 0) throw new Error(`install exited with ${result.status ?? result.signal}`);

  const superFile = path.join(env.BUTTRESS_APP_PATH, 'app_data', 'super.json');
  return JSON.parse(fs.readFileSync(superFile, 'utf8')).token;
};

const stopServer = async (server) => {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  const killTimer = setTimeout(() => server.kill('SIGKILL'), 15000);
  await exited;
  clearTimeout(killTimer);
};

// ---- HTTP ----

const agent = new http.Agent({ keepAlive: true });

// Sends one request and resolves once the whole response has arrived; the body is kept only when asked for.
const send = (port, token, { method, path: urlPath, body }, keepBody = false) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: 'localhost',
        port,
        path: `/${urlPath}`,
        method,
        agent,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => keepBody && chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: keepBody ? Buffer.concat(chunks).toString('utf8') : null }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });

const call = async (port, token, request) => {
  const res = await send(port, token, request, true);
  if (res.status !== 200) throw new Error(`${request.method} /${request.path} returned ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
};

const waitFor = async (what, check, timeoutMs, server) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`the server exited (${server.exitCode ?? server.signalCode}) while waiting for ${what}`);
    }
    try {
      if (await check()) return;
    } catch {
      // Not up yet.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

// Creates the app, schema, policy, user and seed data the scenarios run against.
const setUp = async (port, superToken, server) => {
  const app = await call(port, superToken, {
    method: 'POST',
    path: 'api/v1/app',
    body: { name: 'Bench', apiPath: API_PATH, policyPropertiesList: { adminAccess: [true] } },
  });
  const collection = (name) => ({
    name,
    type: 'collection',
    properties: { name: { __type: 'string', __default: null, __required: true, __allowUpdate: true } },
  });
  await call(port, app.token, {
    method: 'PUT',
    path: 'api/v1/app/schema',
    body: [collection('car'), collection('note')],
  });
  await waitFor(
    'the schema routes',
    async () => (await send(port, app.token, { method: 'GET', path: `${API_PATH}/api/v1/note` })).status === 200,
    10000,
    server,
  );

  await call(port, app.token, { method: 'POST', path: 'api/v1/policy', body: AdminAccessPolicy });
  const user = await call(port, app.token, {
    method: 'POST',
    path: 'api/v1/user',
    body: {
      auth: [{ app: 'bench', appId: 'bench-user', email: 'bench@buttressjs.com' }],
      token: { domains: [`localhost:${port}`], policyProperties: { adminAccess: true } },
    },
  });

  const cars = await call(port, app.token, {
    method: 'POST',
    path: `${API_PATH}/api/v1/car/bulk/add`,
    body: Array.from({ length: SEED_CARS }, (_, idx) => ({ name: `car ${idx}` })),
  });

  // Requests run as a user token under a policy, so access control is part of every measurement.
  return { token: user.tokens[0].value, cars };
};

// ---- Measuring ----

const clockTicks = (() => {
  try {
    return Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })) || 100;
  } catch {
    return 100;
  }
})();

// CPU time the server process has used, in ms (Linux only; null elsewhere).
const serverCpuMs = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the ")" of the command name start at field 3; utime and stime are fields 14 and 15.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return ((Number(fields[11]) + Number(fields[12])) / clockTicks) * 1000;
  } catch {
    return null;
  }
};

const serverRssMb = (pid) => {
  try {
    const kb = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/)?.[1];
    return kb ? Number(kb) / 1024 : null;
  } catch {
    return null;
  }
};

const percentile = (sorted, pct) => sorted[Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)] ?? null;

const round = (value, places) => (value === null ? null : Number(value.toFixed(places)));

const appRequest = (scenario, fixture, n) => {
  const request = scenario.request(fixture, n);
  return { ...request, path: `${API_PATH}/api/v1/${request.path}` };
};

// Runs one scenario for durationMs with `concurrency` requests in flight, each sent as soon as the last returns.
const runScenario = async (scenario, fixture, { port, pid, durationMs, concurrency }) => {
  const latencies = [];
  let errors = 0;
  let sent = 0;

  const cpuBefore = serverCpuMs(pid);
  const started = performance.now();
  const deadline = started + durationMs;
  const worker = async () => {
    while (performance.now() < deadline) {
      const request = appRequest(scenario, fixture, sent++);
      const t0 = performance.now();
      try {
        const res = await send(port, fixture.token, request);
        if (res.status === 200) latencies.push(performance.now() - t0);
        else errors++;
      } catch {
        errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedS = (performance.now() - started) / 1000;
  const cpuAfter = serverCpuMs(pid);

  latencies.sort((a, b) => a - b);
  const requests = latencies.length;
  return {
    requests,
    errors,
    rps: round(requests / elapsedS, 1),
    p50: round(percentile(latencies, 50), 3),
    p90: round(percentile(latencies, 90), 3),
    p99: round(percentile(latencies, 99), 3),
    max: round(latencies.at(-1) ?? null, 3),
    cpuMsPerRequest:
      cpuBefore === null || cpuAfter === null || !requests ? null : round((cpuAfter - cpuBefore) / requests, 4),
    rssMb: round(serverRssMb(pid), 1),
  };
};

const median = (values) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const METRICS = ['rps', 'p50', 'p90', 'p99', 'max', 'cpuMsPerRequest', 'rssMb'];

const summarise = (rounds) =>
  Object.fromEntries(
    METRICS.map((metric) => [metric, median(rounds.map((result) => result[metric]))]).concat([
      ['errors', rounds.reduce((sum, result) => sum + result.errors, 0)],
    ]),
  );

const fmt = (value, places) => (value === null ? '-' : value.toFixed(places));

const printSummary = (scenarios) => {
  const rows = [['scenario', 'req/s', 'p50 ms', 'p99 ms', 'cpu ms/req', 'errors']];
  for (const [name, { median: m }] of Object.entries(scenarios)) {
    rows.push([name, fmt(m.rps, 1), fmt(m.p50, 2), fmt(m.p99, 2), fmt(m.cpuMsPerRequest, 3), String(m.errors)]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  rows.forEach((row) =>
    console.log(row.map((cell, col) => (col ? cell.padStart(widths[col]) : cell.padEnd(widths[col]))).join('  ')),
  );
};

const main = async () => {
  const opts = parseOptions();
  const build = describeBuild(opts.dist);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-bench-'));
  const logPath = path.join(workDir, 'server.log');
  const logFd = fs.openSync(logPath, 'a');
  const env = serverEnv(workDir, opts.port);

  console.log(
    `bench: measuring ${build.dist} (${build.git.commit?.slice(0, 8) ?? 'no git'}${build.git.dirty ? ', uncommitted changes' : ''})`,
  );
  console.log(`bench: MongoDB ${mongoUrl} (database ${dbName}), Redis ${redisUrl} (prefix ${APP_CODE}:)`);

  let server = null;
  let succeeded = false;
  try {
    await clearDatastores();
    const versions = await datastoreVersions();
    const superToken = install(build, env, logFd);

    server = spawn(process.execPath, [build.entry], { env, stdio: ['ignore', logFd, logFd] });
    await waitFor(
      'the server to start',
      async () => (await send(opts.port, superToken, { method: 'GET', path: 'api/v1/app' })).status === 200,
      30000,
      server,
    );
    const fixture = await setUp(opts.port, superToken, server);
    const run = { port: opts.port, pid: server.pid, concurrency: opts.concurrency };

    // Send each scenario's request once first, so a broken scenario stops the run instead of measuring errors.
    for (const name of opts.scenarios) {
      await call(opts.port, fixture.token, appRequest(SCENARIOS[name], fixture, 0)).catch((err) => {
        throw new Error(`scenario ${name} failed: ${err.message}`);
      });
    }

    // Warm up each scenario first, so JIT compilation and cold caches don't land in the first round.
    for (const name of opts.scenarios) await runScenario(SCENARIOS[name], fixture, { ...run, durationMs: WARM_UP_MS });

    const rounds = Object.fromEntries(opts.scenarios.map((name) => [name, []]));
    for (let r = 1; r <= opts.rounds; r++) {
      for (const name of opts.scenarios) {
        const result = await runScenario(SCENARIOS[name], fixture, { ...run, durationMs: opts.durationS * 1000 });
        rounds[name].push(result);
        console.log(
          `  round ${r}/${opts.rounds} ${name.padEnd(8)} ${fmt(result.rps, 1).padStart(8)} req/s  ` +
            `p50 ${fmt(result.p50, 2)} ms  p99 ${fmt(result.p99, 2)} ms` +
            (result.errors ? `  ${result.errors} errors` : ''),
        );
      }
    }

    const scenarios = Object.fromEntries(
      opts.scenarios.map((name) => [
        name,
        { description: SCENARIOS[name].description, median: summarise(rounds[name]), rounds: rounds[name] },
      ]),
    );
    const results = {
      tool: 'buttress-bench',
      version: 1,
      label: opts.label,
      createdAt: new Date().toISOString(),
      build,
      settings: { durationS: opts.durationS, rounds: opts.rounds, concurrency: opts.concurrency, seedCars: SEED_CARS },
      environment: {
        node: process.version,
        platform: `${os.platform()} ${os.release()}`,
        cpu: os.cpus()[0]?.model ?? null,
        cpus: os.cpus().length,
        memoryGb: round(os.totalmem() / 1024 ** 3, 1),
        ...versions,
      },
      scenarios,
    };

    const stamp = results.createdAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const outPath = path.resolve(
      opts.out ?? path.join('bench-results', `${build.git.commit?.slice(0, 8) ?? 'build'}-${stamp}.json`),
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);

    console.log('');
    printSummary(scenarios);
    console.log(`\nbench: results in ${path.relative(process.cwd(), outPath)}`);
    succeeded = true;
  } finally {
    if (server) await stopServer(server);
    fs.closeSync(logFd);
    await clearDatastores().catch((err) =>
      console.warn(`bench: warning: couldn't clear the scratch data: ${err.message}`),
    );
    if (succeeded) fs.rmSync(workDir, { recursive: true, force: true });
    else console.error(`bench: the server's log is in ${logPath}`);
  }
};

main().catch((err) => fail(err.message));
