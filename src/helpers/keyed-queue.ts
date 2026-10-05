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

/**
 * Runs the jobs pushed under one key one after another, in the order they were pushed, and the jobs of other keys
 * alongside them. A job that fails is given to the failure handler, and the key's next job still runs.
 */
export class KeyedQueue {
  private _tails = new Map<string, Promise<void>>();

  constructor(private _onFailure: (err: unknown, key: string) => void = () => {}) {}

  // How many keys have jobs running or waiting
  get size() {
    return this._tails.size;
  }

  /**
   * Runs `job` once the jobs pushed under `key` before it are done.
   * @param {string} key
   * @param {Function} job
   * @return {Promise} - resolves when the job is done, failed or not
   */
  push(key: string, job: () => Promise<unknown>): Promise<void> {
    const previous = this._tails.get(key) ?? Promise.resolve();
    const tail = previous.then(job).then(
      () => undefined,
      (err: unknown) => this._onFailure(err, key),
    );

    this._tails.set(key, tail);
    void tail.then(() => {
      if (this._tails.get(key) === tail) this._tails.delete(key);
    });

    return tail;
  }
}
