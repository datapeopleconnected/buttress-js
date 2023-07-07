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

  async get(key: string) {
    if (!key) return undefined;

    if (this._tempCheckMap.has(key)) return this._tempCheckMap.get(key);

    await this._redisClient.get(key);
  }

  inform(key: string, value: string) {
    if (!this._tempCheckMap.has(key)) {
      this._tempCheckMap.set(key, value);
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
        console.log(`Key ${key} with value ${current} already exists in Redis. Skipping...`);
        continue;
      }

      await new Promise((resolve, reject) => this._redisClient.set(`sds-route:${key}`, value, (err, res) => (err ? reject(err) : resolve(res))));
      console.log(`Key ${key} with value ${value} set in Redis.`);
    }

    this._setInformCheckTimeout();
  }

  private _setInformCheckTimeout() {
    if (this._informCheckTimeout) clearTimeout(this._informCheckTimeout);
    this._informCheckTimeout = setTimeout(() => this._proecssInformCheck(), this._informCheckTimeoutInterval);
  }
}
