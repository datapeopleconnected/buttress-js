/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

import { RedisClient } from 'redis';

export class SourceDataSharingRouting {
  // This map is used to buffer incoming keys to check.
  private _tempCheckMap = new Map();

  private _redisClient: RedisClient;

  private _informCheckTimeout?: NodeJS.Timeout;
  private _informCheckTimeoutInterval = 100;

  // TODO: This needs reworking, we don't need to take in the sourceId from each chunk of data.
  //       we can just get the information when a data sharing agreement is setup and store it
  //       in the main datastore. This can then be cached and kept in check.

  constructor(redisClient: RedisClient) {
    this._redisClient = redisClient;

    this._proecssInformCheck();
  }

  getKey(appId: string, sourceId: string) {
    return `${appId}-${sourceId}`;
  }

  async get(appId: string, sourceId: string) {
    if (!appId || !sourceId) return undefined;

    const key = this.getKey(appId, sourceId);
    if (this._tempCheckMap.has(key)) return this._tempCheckMap.get(key);

    await this._redisClient.get(key);
  }

  inform(appId: string, sourceId: string, dataSharingId: string) {
    const key = this.getKey(appId, sourceId);
    if (!this._tempCheckMap.has(key)) {
      this._tempCheckMap.set(key, dataSharingId);
      this._setInformCheckTimeout();
    }
  }

  clean() {
    if (this._informCheckTimeout) clearTimeout(this._informCheckTimeout);
    this._tempCheckMap.clear();
  }

  private async _proecssInformCheck() {
    if (this._tempCheckMap.size < 1) return;
    for await (const [key, value] of this._tempCheckMap.entries()) {
      const current = await new Promise((resolve, reject) => this._redisClient.get(`sds-route:${key}`, (err, res) => (err ? reject(err) : resolve(res))));
      if (current === value) {
        continue;
      }

      await new Promise((resolve, reject) => this._redisClient.set(`sds-route:${key}`, value, (err, res) => (err ? reject(err) : resolve(res))));
    }

    this._setInformCheckTimeout();
  }

  private _setInformCheckTimeout() {
    if (this._informCheckTimeout) clearTimeout(this._informCheckTimeout);
    this._informCheckTimeout = setTimeout(() => this._proecssInformCheck(), this._informCheckTimeoutInterval);
  }
}
