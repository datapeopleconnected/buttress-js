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

import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const runStep = async (name, fn, scope = 'Setup') => {
  const start = process.hrtime.bigint();
  console.log(`  [${scope}] Working on ${name}`);

  const getElapsedMs = () => Number(process.hrtime.bigint() - start) / 1_000_000;

  try {
    const result = await fn();
    console.log(`  [${scope}] ${name} completed (${getElapsedMs().toFixed(2)}ms)`);
    return result;
  } catch (err) {
    console.log(`  [${scope}] ${name} errored (${getElapsedMs().toFixed(2)}ms)`);
    throw err;
  }
};

const SOCKET_ENTRY = fileURLToPath(new URL('../../dist/bin/app-socket.js', import.meta.url));

export const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, 'localhost', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// Starts a Socket process in its own process, so it can fork workers, and resolves once it's accepting connections
// (its main process only listens once every worker has started). It's a secondary unless `app` says otherwise, and
// listens on `port`, or a free port.
export const startSocketProcess = async ({ workers, app = 'secondary', port = null }) => {
  if (!port) port = await getFreePort();
  const child = spawn(process.execPath, [SOCKET_ENTRY], {
    env: {
      // The config loader has put the test settings into process.env.
      ...process.env,
      // Points the config loader at an env file that doesn't exist, so no .<env>.env overrides these settings.
      ENV_FILE: 'realtime-workers',
      BUTTRESS_APP_WORKERS: String(workers),
      BUTTRESS_SOCK_LISTEN_PORT: String(port),
      BUTTRESS_SOCKET_APP: app,
      BUTTRESS_LOGGING_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => output += chunk);
  child.stderr.on('data', (chunk) => output += chunk);

  await new Promise((resolve, reject) => {
    const onExit = (code) => reject(new Error(`Socket process exited with ${code} before listening:\n${output}`));
    child.once('exit', onExit);

    const attempt = () => {
      if (child.exitCode !== null) return;
      const probe = net.connect(port, 'localhost');
      probe.once('connect', () => {
        probe.destroy();
        child.off('exit', onExit);
        resolve();
      });
      probe.once('error', () => setTimeout(attempt, 100));
    };
    attempt();
  });

  return { child, url: `http://localhost:${port}` };
};

export const stopSocketProcess = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 15000);
  await exited;
  clearTimeout(killTimer);
};
