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

import os from 'node:os';
import cluster from 'node:cluster';

import Logging from '../helpers/logging.js';
import type { NodeRedisPubsub, AppSchemaAppliedMessage } from './nrp.js';

/**
 * How long a change waits for the workers before it gives up and answers anyway.
 */
export const SCHEMA_APPLIED_TIMEOUT_MS = 10_000;

/**
 * Who a REST process is to the processes around it: its host and, for a worker, its main's pid.
 */
export const restProcessIdentity = (): Pick<AppSchemaAppliedMessage, 'host' | 'pid'> => ({
  host: os.hostname(),
  pid: cluster.isWorker ? process.ppid : process.pid,
});

/**
 * The main's side. A schema change is only done once every worker of the process has rebuilt its models and routes
 * for it, so the main keeps what each change is still waiting on, and says when that's nothing.
 */
export class SchemaChangeAcks {
  private _pending = new Map<string, { appId: string; workers: Set<number>; timer: NodeJS.Timeout }>();

  /**
   * @param _onApplied - called once, with the change's id and app, when every worker has applied it, or has gone, or
   *   the timeout has passed
   * @param _timeoutMs - how long to wait for the workers
   */
  constructor(
    private _onApplied: (changeId: string, appId: string) => void,
    private _timeoutMs = SCHEMA_APPLIED_TIMEOUT_MS,
  ) {}

  /**
   * Starts waiting for the given workers to apply a change.
   * @param changeId
   * @param workers - the indexes of the workers that were told of it
   * @param appId - the app it's for
   */
  start(changeId: string, workers: number[], appId: string) {
    if (workers.length === 0) return this._onApplied(changeId, appId);

    const timer = setTimeout(() => {
      const pending = this._pending.get(changeId);
      if (!pending) return;

      Logging.logWarn(`Schema change ${changeId} wasn't applied by workers ${[...pending.workers].join(', ')} in time`);
      this._finish(changeId);
    }, this._timeoutMs);
    timer.unref();

    this._pending.set(changeId, { appId, workers: new Set(workers), timer });
  }

  /**
   * A worker has applied a change.
   */
  ack(changeId: string, worker: number) {
    this._release(changeId, worker);
  }

  /**
   * A worker has gone, so it can't apply what it hasn't yet.
   */
  workerGone(worker: number) {
    for (const changeId of [...this._pending.keys()]) this._release(changeId, worker);
  }

  clear() {
    for (const { timer } of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
  }

  private _release(changeId: string, worker: number) {
    const pending = this._pending.get(changeId);
    if (!pending) return;

    pending.workers.delete(worker);
    if (pending.workers.size === 0) this._finish(changeId);
  }

  private _finish(changeId: string) {
    const pending = this._pending.get(changeId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pending.delete(changeId);
    this._onApplied(changeId, pending.appId);
  }
}

/**
 * A worker's side. Waits for its own REST process to say its workers have applied a change this worker made.
 */
export class SchemaAppliedWaiter {
  private _waiting = new Map<string, () => void>();
  private _subscription?: Promise<unknown>;

  constructor(
    private _nrp: NodeRedisPubsub,
    private _timeoutMs = SCHEMA_APPLIED_TIMEOUT_MS,
  ) {}

  /**
   * Starts listening for a change, which has to be done before it's published so its answer can't be missed.
   * @param changeId
   * @return {Promise<function(): Promise<boolean>>} - waits for the change, resolving true once it's applied, or false
   *   if it hadn't been in time
   */
  async expect(changeId: string): Promise<() => Promise<boolean>> {
    await this._subscribe();

    let timer!: NodeJS.Timeout;
    const done = new Promise<boolean>((resolve) => {
      this._waiting.set(changeId, () => resolve(true));
      timer = setTimeout(() => resolve(false), this._timeoutMs);
      timer.unref();
    });

    return async () => {
      const applied = await done;
      clearTimeout(timer);
      this._waiting.delete(changeId);
      if (!applied)
        Logging.logWarn(`Schema change ${changeId} wasn't applied by the workers in time, answering anyway`);
      return applied;
    };
  }

  private _subscribe() {
    this._subscription ??= this._nrp.on('app-schema:applied', (json) => {
      const message = JSON.parse(json) as AppSchemaAppliedMessage;
      const mine = restProcessIdentity();
      // Every REST process says so for a change, and only the one this worker belongs to answers its wait
      if (message.host !== mine.host || message.pid !== mine.pid) return;

      this._waiting.get(message.changeId)?.();
    });

    return this._subscription;
  }
}
