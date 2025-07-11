/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import Logging from '../helpers/logging.js';

import AccessControlPolicyMatch from '../access-control/policy-match.js';

import Model from '../model/index.js';
import { Policy, PolicyConfig } from '../model/core/policy.js';
import { Token } from '../model/core/token.js';
import { User } from '../model/core/user.js';

import * as Helpers from '../helpers/index.js';

export class PolicyCache {
  private _redisClient: RedisClient;
  private _modelManager: typeof Model;

  private _connectedTokensTTL = 60; // 1min
  private _timeoutExpiredConnectedTokens?: NodeJS.Timeout;

  private _timeoutExpiredConnectedTokensInterval = 60000;

  constructor(redisClient: RedisClient, modelManager: typeof Model) {
    this._redisClient = redisClient;
    this._modelManager = modelManager;
  }

  initProcessing() {
    this._processConnectedTokensExpiry();
  }
  clean() {
    if (this._timeoutExpiredConnectedTokens) clearTimeout(this._timeoutExpiredConnectedTokens);
  }

  private _processConnectedTokensExpiry() {
    // Set up a timeout to clear out expired connected tokens
    this.clearExpiredConnectedTokens();

    this._setConnectedTokensExpiryTimeout();
  }
  private _setConnectedTokensExpiryTimeout() {
    if (this._timeoutExpiredConnectedTokens) clearTimeout(this._timeoutExpiredConnectedTokens);
    this._timeoutExpiredConnectedTokens = setTimeout(() => this._processConnectedTokensExpiry(), this._timeoutExpiredConnectedTokensInterval);
  }

  async getPolicies(policyIds: string[]) {
    const policies = await new Promise<Policy[]>((resolve, reject) => {
      this._redisClient.hmget('policies', policyIds, (err, policies) => (err) ? reject(err) : resolve(policies.map((policy) => JSON.parse(policy))));
    });

    const missingPolicies = policyIds.filter((policyId) => !policies.find((policy) => policyId === policy.id));

    if (missingPolicies.length > 0) {
      const newPolicies = await Helpers.streamAll(this._modelManager.getModel('Policy').find({ id: { $in: missingPolicies } }));

      await newPolicies.reduce(async (prev, policy) => {
        await prev;

        await new Promise<void>((resolve, reject) => {
          this._redisClient.hset(`policies`, policy.id.toString(), JSON.stringify(policy), (err) => (err) ? reject(err) : resolve());
        });
      }, Promise.resolve());

      return policies.concat(newPolicies);
    }

    return policies;
  }

  async setTokenIdAsStale(tokenId: string) {
    Logging.logSilly(`Marking token as stale: ${tokenId}`);

    // Mark the cache as stale, to force requests to the cache to get fresh copies whilst we clean up.
    await new Promise<void>((resolve, reject) => {
      this._redisClient.sadd(`token:${tokenId}`, 'STALE', (err) => (err) ? reject(err) : resolve());
    });

    // Remove the token from any policy:*:tokens
    await new Promise<void>((resolve, reject) => {
      this._redisClient.smembers(`token:${tokenId}`, async (err, policyIds) => {
        if (err) return reject(err);

        await policyIds.reduce(async (prev, policyId) => {
          await prev;

          await new Promise<void>((resolve, reject) => {
            this._redisClient.srem(`policy:${policyId}:tokens`, tokenId, (err) => (err) ? reject(err) : resolve());
          });
        }, Promise.resolve());

        resolve();
      });
    });

    // Remove the token from token:${tokenId}
    await new Promise<void>((resolve, reject) => {
      this._redisClient.del(`token:${tokenId}`, (err) => (err) ? reject(err) : resolve());
    });
  }

  async clearPolicyById(policyId: string) {
    await new Promise<void>((resolve, reject) => {
      this._redisClient.hdel(`policies`, policyId, (err) => (err) ? reject(err) : resolve());
    });
  }

  async getPoliciesByToken(token: Token): Promise<Policy[]> {
    let policies: Policy[] = [];
    const policyIds = await new Promise<string[]>((resolve, reject) => {
      this._redisClient.smembers(`token:${token.id}`, (err, policyIds) => (err) ? reject(err) : resolve(policyIds));
    });

    // If the tokens are marked as stale, we're in the process of cleaning them up. we'll miss the cache and get fresh data.
    const isStale = policyIds.length > 0 && policyIds.includes('STALE');
    if (policyIds.length < 1 || isStale) {
      const appPolicies = await Helpers.streamAll(this._modelManager.getModel('Policy').find({ _appId: token._appId }));
      policies = AccessControlPolicyMatch.getTokenPolicies(appPolicies, token);

      if (policies.length > 0 && !isStale) {
        await policies.reduce(async (prev, policy) => {
          await prev;

          await new Promise<void>((resolve, reject) => {
            this._redisClient.sadd(`token:${token.id}`, policy.id.toString(), (err) => (err) ? reject(err) : resolve());
          });

          await this.addPolicy(policy);

          await new Promise<void>((resolve, reject) => {
            this._redisClient.sadd(`policy:${policy.id}:tokens`, token.id.toString(), (err) => (err) ? reject(err) : resolve());
          });
        }, Promise.resolve());
      }
    } else {
      policies = await this.getPolicies(policyIds);

      // HACK: Re-run selection
      policies = AccessControlPolicyMatch.getTokenPolicies(policies, token);
    }

    return policies;
  }

  async getPoliciesByEvent(event: any) {
    const isCoreSchema = false
    const schemaWildCard = (isCoreSchema) ? '%CORE_SCHEMA%' : '%APP_SCHEMA%';

    // The following code is stupid but will be refactored later.
    const direct = await new Promise<string[]>((resolve, reject) => {
      this._redisClient.smembers(`app:${event.appId}:schema:${event.schemaName}`, (err, policyIds) => (err) ? reject(err) : resolve(policyIds));
    });

    const allWildcard = await new Promise<string[]>((resolve, reject) => {
      this._redisClient.smembers(`app:${event.appId}:schema:%ALL%`, (err, policyIds) => (err) ? reject(err) : resolve(policyIds));
    });

    const typedWildcard = await new Promise<string[]>((resolve, reject) => {
      this._redisClient.smembers(`app:${event.appId}:schema:${schemaWildCard}`, (err, policyIds) => (err) ? reject(err) : resolve(policyIds));
    });

    const policyIds = [...new Set(direct.concat(allWildcard).concat(typedWildcard))];
    // console.log(event.appId, policyIds);

    if (policyIds.length < 1) return [];

    return this.getPolicies(policyIds);
  }

  async addConnectedToken(tokenId: string) {
    const expiryTime = Math.floor(Date.now() / 1000) + this._connectedTokensTTL; // Current time + 1 hour
    await new Promise<void>((resolve, reject) => {
      this._redisClient.zadd('connected-tokens', expiryTime, tokenId, (err) => (err) ? reject(err) : resolve());
    });

    // Make sure the user object is cached.
    // await this.cacheUser(user);

    // await new Promise<void>((resolve, reject) => {
    //   this._redisClient.hset(`connected-tokens:userIds`, tokenId, user.id, (err) => (err) ? reject(err) : resolve());
    // });
  }
  async removeConnectedToken(tokenId: string) {
    await new Promise<void>((resolve, reject) => {
      this._redisClient.zrem('connected-tokens', tokenId, (err) => (err) ? reject(err) : resolve());
    });

    // await new Promise<void>((resolve, reject) => {
    //   this._redisClient.hdel(`connected-tokens:userIds`, tokenId, (err) => (err) ? reject(err) : resolve());
    // });
  }
  async clearExpiredConnectedTokens() {
    const now = Math.floor(Date.now() / 1000);
    await new Promise<void>((resolve, reject) => {
      this._redisClient.zremrangebyscore('connected-tokens', 0, now, (err) => (err) ? reject(err) : resolve());
    });

    // TODO: Need to clean up cached users
  }

  async addPolicy(policy) {
    const policyExists = await new Promise<boolean>((resolve, reject) => {
      this._redisClient.hexists(`policies`, policy.id.toString(), (err, num) => (err) ? reject(err) : resolve(num === 1));
    });

    // Early out.
    if (policyExists) return false;

    await new Promise<void>((resolve, reject) => {
      this._redisClient.hset(`policies`, policy.id.toString(), JSON.stringify(policy), (err) => (err) ? reject(err) : resolve());
    });

    if (policy.appId) {
      await new Promise<void>((resolve, reject) => {
        this._redisClient.sadd(`app:${policy.appId}:policies`, policy.id.toString(), (err) => (err) ? reject(err) : resolve());
      });
    }

    const lookupKeys = policy.config.reduce((acc, config: PolicyConfig) => {
      for (const schema of config.schema) {
        for (const verb of config.verbs) {
          if (verb === '%ALL%' || verb === 'GET' || verb === 'SEARCH') {
            acc.push(`app:${policy._appId.toString()}:schema:${schema}`);
          }
        }
      }
      return acc;
    }, []);

    for (const key of lookupKeys) {
      await new Promise<void>((resolve, reject) => {
        this._redisClient.sadd(key, policy.id.toString(), (err) => (err) ? reject(err) : resolve());
      });
    }
  }

  async getConnectedTokenIdsByPolicyId(policyId: string) {
    const now = Math.floor(Date.now() / 1000);

    const tokenIds = await new Promise<string[]>((resolve, reject) => {
      this._redisClient.smembers(`policy:${policyId}:tokens`, (err, tokens) => (err) ? reject(err) : resolve(tokens));
    });

    const connectedTokens = await new Promise<string[]>((resolve, reject) => {
      this._redisClient.zrange('connected-tokens', 0, -1, (err, connectedTokens) => (err) ? reject(err) : resolve(connectedTokens));
    });
    Logging.log(`Policy Tokens: ${JSON.stringify(tokenIds)} in ${JSON.stringify(connectedTokens.join(', '))}`);

    const connectedPolicyTokens: string[] = [];
    for await (const tokenId of tokenIds) {
      const score = await new Promise<number>((resolve, reject) => {
        this._redisClient.zscore('connected-tokens', tokenId, (err, score) => (err) ? reject(err) : resolve(Number(score)));
      });

      if (score !== null && !isNaN(score) && score > now) {
        connectedPolicyTokens.push(tokenId);
      }
    }

    return connectedPolicyTokens;
  }

  async cacheUser(user: User) {
    const userExists = await new Promise<boolean>((resolve, reject) => {
      this._redisClient.hexists(`users`, user.id, (err, num) => (err) ? reject(err) : resolve(num === 1));
    });
    if (userExists) return;

    await new Promise<void>((resolve, reject) => {
      this._redisClient.hset(`users`, user.id, JSON.stringify(user), (err) => (err) ? reject(err) : resolve());
    });
  }
  async getCachedUser(userId: string) {
    return await new Promise<User>((resolve, reject) => {
      this._redisClient.hget(`users`, userId, (err, user) => (err) ? reject(err) : resolve(JSON.parse(user)));
    });
  }
  async removeCachedUser(userId: string) {
    await new Promise<void>((resolve, reject) => {
      this._redisClient.hdel(`users`, userId, (err) => (err) ? reject(err) : resolve());
    });
  }

  // I am the REST process, a user has sent a request to me, I need the policies that are associated with this token

  // I am the SPR process, a activity event has come through, I need to work out which tokens should receive this event.
  //   - I need to work out which policies apply to this event
  //   - I need to work out which tokens are associated with these policies

  // SELECTION
  // - Selection can only change if the policy changes or policy properties change.

  // Processing
  // - When a policy is updated, we need to update the cache

}
