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

import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';

/**
 * Counts the I/O each unit of work causes, so tests can hold it to a budget (test/e2e/perf/io-budgets.test.js).
 *
 * A unit of work is a REST request, keyed by its request id (RoutesMiddleware._createContext), or the SPR handling
 * REST activity, keyed 'spr' (BootstrapSocketPolicyRouter). Three kinds of I/O are counted by name:
 * - mongo: MongoDB commands (find, insert, ...), from the driver's command monitoring (MongodbAdapter.connect)
 * - redis: Redis commands (SMEMBERS, HGET, ...), from node-redis's diagnostics channel. PUBLISH is left out, see nrp.
 * - nrp: NRP publishes, by channel (NodeRedisPubsub.publish)
 *
 * Work is attributed through AsyncLocalStorage, so fire-and-forget work a request starts (e.g. the activity log
 * insert) still counts towards it. Counting is off unless enable() is called; while off, run() and record() only
 * cost a boolean check.
 */

export type IOCategory = 'mongo' | 'redis' | 'nrp';

export interface IOCounts {
  mongo: Record<string, number>;
  redis: Record<string, number>;
  nrp: Record<string, number>;
  // Every counted operation with its target (collection, key or channel), in order, for diagnosing a failed budget.
  log: string[];
}

// Bounds so a long-running process with counting left on can't grow without limit.
const MAX_UNITS = 1000;
const MAX_LOG_ENTRIES = 500;

// The start event of node-redis's 'node-redis:command' tracing channel, published for every command it sends.
const REDIS_COMMAND_START_CHANNEL = 'tracing:node-redis:command:start';

const storage = new AsyncLocalStorage<IOCounts>();
const units = new Map<string, IOCounts>();

let enabled = false;

function onRedisCommand(message: unknown) {
  const { command, args } = message as { command?: string; args?: unknown[] };
  if (!command || command === 'PUBLISH') return;
  record('redis', command, args && args.length > 1 ? String(args[1]) : undefined);
}

/**
 * Start counting. Call it before any datastore connects, the Mongo client only reports commands if it was created
 * with monitoring on.
 */
export function enable() {
  if (enabled) return;
  enabled = true;
  diagnosticsChannel.subscribe(REDIS_COMMAND_START_CHANNEL, onRedisCommand);
}

export function disable() {
  if (!enabled) return;
  enabled = false;
  diagnosticsChannel.unsubscribe(REDIS_COMMAND_START_CHANNEL, onRedisCommand);
  units.clear();
}

export function isEnabled() {
  return enabled;
}

/**
 * Run fn as part of the unit of work named key; I/O it causes, synchronously or later, is counted against key.
 * Runs with the same key share one set of counts.
 */
export function run<T>(key: string, fn: () => T): T {
  if (!enabled) return fn();

  let counts = units.get(key);
  if (!counts) {
    counts = { mongo: {}, redis: {}, nrp: {}, log: [] };
    units.set(key, counts);
    if (units.size > MAX_UNITS) units.delete(units.keys().next().value as string);
  }

  return storage.run(counts, fn);
}

/**
 * Count one operation against the current unit of work. Operations outside any unit (e.g. background timers) are
 * ignored.
 */
export function record(category: IOCategory, name: string, target?: string) {
  if (!enabled) return;

  const counts = storage.getStore();
  if (!counts) return;

  counts[category][name] = (counts[category][name] ?? 0) + 1;
  if (counts.log.length < MAX_LOG_ENTRIES) {
    counts.log.push(target ? `${category} ${name} ${target}` : `${category} ${name}`);
  }
}

export function get(key: string): IOCounts | undefined {
  return units.get(key);
}

// Drop a unit's counts, so the next run with that key starts from zero.
export function forget(key: string) {
  units.delete(key);
}

export default {
  enable,
  disable,
  isEnabled,
  run,
  record,
  get,
  forget,
};
