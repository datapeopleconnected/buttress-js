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

import { RedisClientType } from '@redis/client';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import { redisPrefix } from '../helpers/index.js';
import Logging from '../helpers/logging.js';

/**
 * Which data sharing agreement reaches each source of a federated app's records. A record read through an agreement
 * names its source, so each read records the route, and a write to a record by its source takes it. Routes are kept in
 * Redis, so every process and worker of the instance, and the next start, can route a source that any of them read.
 */
export class SourceDataSharingRouting {
  // The routes this process knows, by key
  private _routes = new Map<string, string>();

  // Routes this process has learnt and not yet stored in Redis
  private _unstored = new Map<string, string>();

  private _redisClient: RedisClientType;

  private _storeTimeout?: NodeJS.Timeout;
  private _storeTimeoutInterval = 100;

  // TODO: This needs reworking, we don't need to take in the sourceId from each chunk of data.
  //       we can just get the information when a data sharing agreement is setup and store it
  //       in the main datastore. This can then be cached and kept in check.

  constructor(redisClient: RedisClientType) {
    this._redisClient = redisClient;
  }

  getKey(appId: string, sourceId: string) {
    return redisPrefix(Config.redis.scope, `sds-route:${appId}-${sourceId}`);
  }

  async get(appId: string, sourceId: string) {
    if (!appId || !sourceId) return undefined;

    const key = this.getKey(appId, sourceId);
    const known = this._routes.get(key);
    if (known) return known;

    const stored = await this._redisClient.get(key);
    if (!stored) return undefined;

    this._routes.set(key, stored);
    return stored;
  }

  inform(appId: string, sourceId: string, dataSharingId: string) {
    if (!appId || !sourceId || !dataSharingId) return;

    const key = this.getKey(appId, sourceId);
    if (this._routes.get(key) === dataSharingId) return;

    this._routes.set(key, dataSharingId);
    this._unstored.set(key, dataSharingId);
    this._setStoreTimeout();
  }

  clean() {
    if (this._storeTimeout) clearTimeout(this._storeTimeout);
    this._storeTimeout = undefined;
    this._routes.clear();
    this._unstored.clear();
  }

  private async _storeRoutes() {
    this._storeTimeout = undefined;

    const routes = [...this._unstored.entries()];
    this._unstored.clear();
    await Promise.all(routes.map(([key, dataSharingId]) => this._redisClient.set(key, dataSharingId)));
  }

  private _setStoreTimeout() {
    if (this._storeTimeout) return;
    this._storeTimeout = setTimeout(
      () => this._storeRoutes().catch((err: Error) => Logging.logError(`Unable to store data sharing routes: ${err}`)),
      this._storeTimeoutInterval,
    );
  }
}
