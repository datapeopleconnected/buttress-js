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

// Two independent Buttress instances for the federation tests. Each stack runs the build's REST, Socket and SPR
// processes on ports of its own, with its own app_data folder and app code, and so its own MongoDB database
// (<code>-prod) and Redis key and channel prefix (<code>:). The Model, Datastore and Config singletons rule out two
// instances in one process, so the tests only talk to the stacks over HTTP and socket.io, as partners would.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { MongoClient } from 'mongodb';
import { createClient } from '@redis/client';
import { io } from 'socket.io-client';

const DIST = path.resolve('dist');

// What each process logs once it's ready, from src/bin
const PROCESSES = {
  rest: { entry: 'app.js', ready: 'REST Server Main' },
  socket: { entry: 'app-socket.js', ready: 'Socket Main' },
  spr: { entry: 'app-spr.js', ready: 'SPR Main' },
};

export const mongoUrl = process.env.FEDERATION_MONGO_URL || 'mongodb://localhost:27017';
export const redisUrl = process.env.FEDERATION_REDIS_URL || 'redis://localhost:6379';
export const workers = process.env.FEDERATION_WORKERS || '0';

export class Stack {
  /**
   * @param {string} name - a, b, ...: names the app code, and so the stack's database and Redis prefix
   * @param {number} restPort
   * @param {number} sockPort
   */
  constructor(name, restPort, sockPort) {
    this.name = name;
    this.code = `bjs-fed-${name}`;
    this.restPort = restPort;
    this.sockPort = sockPort;
    this.rest = `http://localhost:${restPort}`;
    this.sock = `http://localhost:${sockPort}`;
    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), `${this.code}-`));
    this.logDir = path.join(this.workDir, 'logs');
    fs.mkdirSync(this.logDir, { recursive: true });
    this.processes = {};
    this.superToken = null;
  }

  env() {
    return {
      ...process.env,
      NODE_ENV: 'production',
      // An env file that doesn't exist, so no .<env>.env overrides these settings
      ENV_FILE: 'federation',
      SERVER_ID: this.code,
      BUTTRESS_APP_TITLE: `ButtressJS federation ${this.name}`,
      BUTTRESS_APP_CODE: this.code,
      BUTTRESS_APP_PATH: this.workDir,
      BUTTRESS_APP_WORKERS: workers,
      BUTTRESS_APP_PROTOCOL: 'http',
      BUTTRESS_HOST_URL: `localhost:${this.restPort}`,
      BUTTRESS_SOCK_URL: this.sock,
      BUTTRESS_REST_LISTEN_PORT: String(this.restPort),
      BUTTRESS_SOCK_LISTEN_PORT: String(this.sockPort),
      BUTTRESS_DATASTORE_CONNECTION_STRING: mongoUrl,
      BUTTRESS_REDIS_URL: redisUrl,
      BUTTRESS_LOGGING_LEVEL: process.env.FEDERATION_LOG_LEVEL || 'info',
    };
  }

  get dbName() {
    return `${this.code}-prod`;
  }

  // Drops the stack's database and Redis keys, and nothing else
  async clearData() {
    const mongo = await MongoClient.connect(mongoUrl, { serverSelectionTimeoutMS: 5000 });
    try {
      await mongo.db(this.dbName).dropDatabase();
    } finally {
      await mongo.close();
    }

    await this._deleteRedisKeys(`${this.code}:*`);
  }

  // Drops the routes to partners' records that reads taught the stack, as a Redis that lost its data would
  async forgetDataSharingRoutes() {
    await this._deleteRedisKeys(`${this.code}:sds-route:*`);
  }

  async _deleteRedisKeys(pattern) {
    const redis = createClient({ url: redisUrl });
    await redis.connect();
    try {
      for await (const keys of redis.scanIterator({ MATCH: pattern, COUNT: 500 })) {
        const batch = Array.isArray(keys) ? keys : [keys];
        if (batch.length) await redis.del(batch);
      }
    } finally {
      await redis.close();
    }
  }

  // Runs the REST process in install mode, which creates the super app, and keeps its system token
  install() {
    const log = fs.openSync(path.join(this.logDir, 'install.log'), 'a');
    const result = spawnSync(process.execPath, [path.join(DIST, 'bin', PROCESSES.rest.entry)], {
      env: { ...this.env(), INSTALL_MODE: 'true' },
      stdio: ['ignore', log, log],
      timeout: 60000,
    });
    fs.closeSync(log);
    if (result.status !== 0) throw new Error(`${this.code} install exited with ${result.status ?? result.signal}`);

    const superFile = path.join(this.workDir, 'app_data', 'super.json');
    this.superToken = JSON.parse(fs.readFileSync(superFile, 'utf8')).token;
  }

  /**
   * Starts processes and waits for each to be ready.
   * @param {string[]} names - rest, socket, spr
   * @param {number} [timeoutMs]
   */
  async start(names = Object.keys(PROCESSES), timeoutMs = 60000) {
    await Promise.all(names.map((name) => this._startProcess(name, timeoutMs)));
  }

  async _startProcess(name, timeoutMs) {
    if (this.processes[name]) throw new Error(`${this.code} ${name} is already running`);
    const { entry, ready } = PROCESSES[name];
    const logFile = fs.createWriteStream(path.join(this.logDir, `${name}.log`), { flags: 'a' });
    const child = spawn(process.execPath, [path.join(DIST, 'bin', entry)], {
      env: this.env(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.processes[name] = child;
    child.stdout.pipe(logFile);
    child.stderr.pipe(logFile);

    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error(`${this.code} ${name} wasn't ready within ${timeoutMs}ms; see ${this.logDir}`)),
        timeoutMs,
      );
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-4096);
        if (!output.includes(ready)) return;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      };
      child.stdout.on('data', onData);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        delete this.processes[name];
        reject(new Error(`${this.code} ${name} exited (${code ?? signal}) before it was ready; see ${this.logDir}`));
      });
    });
  }

  /**
   * Stops processes, waiting for each to exit.
   * @param {string[]} names
   */
  async stop(names = Object.keys(this.processes)) {
    await Promise.all(
      names.map(async (name) => {
        const child = this.processes[name];
        if (!child) return;
        delete this.processes[name];
        if (child.exitCode !== null || child.signalCode !== null) return;

        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 15000);
        await exited;
        clearTimeout(killTimer);
      }),
    );
  }

  async restart(names = Object.keys(PROCESSES)) {
    await this.stop(names);
    await this.start(names);
  }

  /**
   * Sends a request to the stack's REST API.
   * @param {string} method
   * @param {string} urlPath - e.g. api/v1/app, or fed-a/api/v1/car
   * @param {{token?: string, body?: unknown}} [options]
   * @return {Promise<{status: number, body: unknown}>}
   */
  async request(method, urlPath, { token = this.superToken, body } = {}) {
    const res = await fetch(`${this.rest}/${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON
    }
    return { status: res.status, body: parsed };
  }

  // A request that must succeed, giving its body
  async call(method, urlPath, options) {
    const res = await this.request(method, urlPath, options);
    if (res.status !== 200) {
      throw new Error(`${this.code} ${method} /${urlPath} returned ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return res.body;
  }

  /**
   * Connects a socket to one of the stack's app namespaces, and collects the db-activity it receives.
   * @param {string} apiPath
   * @param {string} token
   */
  async connectSocket(apiPath, token) {
    const socket = io(`${this.sock}/${apiPath}`, { auth: { token }, forceNew: true, reconnection: false });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const received = [];
    socket.on('db-activity', (packet) => received.push(packet.data));
    return { socket, received, close: () => socket.close() };
  }
}

/**
 * Waits for `check` to give a truthy value, trying every 100ms.
 * @param {string} what
 * @param {() => unknown} check
 * @param {number} [timeoutMs]
 */
export const waitFor = async (what, check, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
};

const basePort = Number(process.env.FEDERATION_BASE_PORT || 8200);

// The two instances the suites run against, started by setup.mjs
export const stacks = {
  a: new Stack('a', basePort, basePort + 10),
  b: new Stack('b', basePort + 100, basePort + 110),
};
