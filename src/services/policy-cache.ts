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

import { RedisClientType } from '@redis/client';

import { redisPrefix } from '../helpers/index.js';
import Logging from '../helpers/logging.js';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import AccessControlPolicyMatch from '../access-control/policy-match.js';

import Model from '../model/index.js';
import { Policy, PolicyConfig } from '../model/core/policy.js';
import { Token } from '../model/core/token.js';
import { User } from '../model/core/user.js';

import * as Helpers from '../helpers/index.js';

export class PolicyCache {
  private _redisClient: RedisClientType;
  private _modelManager: typeof Model;

  private _connectedTokensTTL = 60; // 1min
  private _timeoutExpiredConnectedTokens?: NodeJS.Timeout;

  private _timeoutExpiredConnectedTokensInterval = 60000;

  constructor(redisClient: RedisClientType, modelManager: typeof Model) {
    this._redisClient = redisClient;
    this._modelManager = modelManager;
  }

  initProcessing() {
    this._processConnectedTokensExpiry();
  }
  clean() {
    if (this._timeoutExpiredConnectedTokens) clearTimeout(this._timeoutExpiredConnectedTokens);
  }

  private _prefix(key: string): string {
    return redisPrefix(Config.redis.scope, key);
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
    if (!policyIds || policyIds.length < 1) {
      Logging.logSilly(`No policy IDs provided, returning empty array.`);
      return [];
    }

    const policies = (await this._redisClient.hmGet(this._prefix('policies'), policyIds))
      .map((policy) => (policy) ? JSON.parse(policy) : false)
      .filter((policy) => policy !== false);

    const missingPolicies = policyIds.filter((policyId) => !policies.find((policy) => policyId === policy.id));

    if (missingPolicies.length > 0) {
      const newPolicies = await Helpers.streamAll(this._modelManager.getModel('Policy').find({ id: { $in: missingPolicies } }));

      await newPolicies.reduce(async (prev, policy) => {
        await prev;

        await this._redisClient.hSet(this._prefix(`policies`), policy.id.toString(), JSON.stringify(policy));
      }, Promise.resolve());

      return policies.concat(newPolicies);
    }

    return policies;
  }

  async storePolicy(policy: Policy) {
    Logging.logSilly(`Storing policy: ${policy.id}`);
    await this._redisClient.hSet(this._prefix('policies'), `policy:${policy.id}`, JSON.stringify(policy));
  }

  async setTokenIdAsStale(tokenId: string) {
    Logging.logSilly(`Marking token as stale: ${tokenId}`);

    // Mark the cache as stale, to force requests to the cache to get fresh copies whilst we clean up.
    await this._redisClient.sAdd(this._prefix(`token:${tokenId}`), 'STALE');

    const policyIds = await this._redisClient.sMembers(this._prefix(`token:${tokenId}`));

    await policyIds.reduce(async (prev, policyId) => {
      await prev;

      await this._redisClient.sRem(this._prefix(`policy:${policyId}:tokens`), tokenId);
    }, Promise.resolve());

    // Remove the token from token:${tokenId}
    await this._redisClient.del(this._prefix(`token:${tokenId}`));
  }

  async clearPolicyById(policyId: string) {
    await this._redisClient.hDel(this._prefix(`policies`), policyId);
  }

  async getPoliciesByToken(token: Token): Promise<Policy[]> {
    let policies: Policy[] = [];
    const policyIds = await this._redisClient.sMembers(this._prefix(`token:${token.id}`));

    // If the tokens are marked as stale, we're in the process of cleaning them up. we'll miss the cache and get fresh data.
    const isStale = policyIds.length > 0 && policyIds.includes('STALE');
    if (policyIds.length < 1 || isStale) {
      const appPolicies = await Helpers.streamAll(this._modelManager.getModel('Policy').find({ _appId: token._appId }));
      policies = AccessControlPolicyMatch.getTokenPolicies(appPolicies, token);

      if (policies.length > 0 && !isStale) {
        await policies.reduce(async (prev, policy) => {
          await prev;

          await this._redisClient.sAdd(this._prefix(`token:${token.id}`), policy.id.toString());

          await this.addPolicy(policy);

          await this._redisClient.sAdd(this._prefix(`policy:${policy.id}:tokens`), token.id.toString());
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
    const direct = await this._redisClient.sMembers(this._prefix(`app:${event.appId}:schema:${event.schemaName}`));

    const allWildcard = await this._redisClient.sMembers(this._prefix(`app:${event.appId}:schema:%ALL%`));

    const typedWildcard = await this._redisClient.sMembers(this._prefix(`app:${event.appId}:schema:${schemaWildCard}`));

    const policyIds = [...new Set(direct.concat(allWildcard).concat(typedWildcard))];
    // console.log(event.appId, policyIds);

    if (policyIds.length < 1) return [];

    return this.getPolicies(policyIds);
  }

  async isTokenConnected(tokenId: string): Promise<boolean> {
    if (!tokenId) return false;
    const score = await this._redisClient.zScore(this._prefix(`connected-tokens`), tokenId);
    if (score === null || isNaN(score)) return false;
    const now = Math.floor(Date.now() / 1000);
    return score > now;
  }
  async addConnectedToken(tokenId: string) {
    const expiryTime = Math.floor(Date.now() / 1000) + this._connectedTokensTTL; // Current time + 1 hour
    await this._redisClient.zAdd(this._prefix(`connected-tokens`), [{ value: tokenId, score: expiryTime }]);

    // Make sure the user object is cached.
    // await this.cacheUser(user);

    // await new Promise<void>((resolve, reject) => {
    //   this._redisClient.hset(`connected-tokens:userIds`, tokenId, user.id, (err) => (err) ? reject(err) : resolve());
    // });
  }
  async removeConnectedToken(tokenId: string) {
    await this._redisClient.zRem(this._prefix(`connected-tokens`), tokenId);

    // await new Promise<void>((resolve, reject) => {
    //   this._redisClient.hdel(`connected-tokens:userIds`, tokenId, (err) => (err) ? reject(err) : resolve());
    // });
  }
  async clearExpiredConnectedTokens() {
    const now = Math.floor(Date.now() / 1000);
    await this._redisClient.zRemRangeByScore(this._prefix(`connected-tokens`), 0, now);

    // TODO: Need to clean up cached users
  }

  async addPolicy(policy) {
    const policyExists = await this._redisClient.hExists(this._prefix(`policies`), policy.id.toString());

    // Early out.
    if (policyExists) return false;

    await this._redisClient.hSet(this._prefix(`policies`), policy.id.toString(), JSON.stringify(policy));

    if (policy.appId) {
      await this._redisClient.sAdd(this._prefix(`app:${policy.appId}:policies`), policy.id.toString());
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
      await this._redisClient.sAdd(this._prefix(key), policy.id.toString());
    }
  }

  async connectTokenToPolicy(tokenId: string, policyId: string) {
    if (!tokenId || !policyId) {
      throw new Error('Token ID and Policy ID are required to connect.');
    }

    Logging.logSilly(`Connecting token ${tokenId} to policy ${policyId}`);
    await this._redisClient.sAdd(this._prefix(`token:${tokenId}`), policyId);
    await this._redisClient.sAdd(this._prefix(`policy:${policyId}:tokens`), tokenId);
  }

  async getConnectedTokenIdsByPolicyId(policyId: string) {
    const now = Math.floor(Date.now() / 1000);

    const tokenIds = await this._redisClient.sMembers(this._prefix(`policy:${policyId}:tokens`));
    const connectedTokens = await this._redisClient.zRange(this._prefix(`connected-tokens`), 0, -1);
    Logging.log(`Policy Tokens: ${JSON.stringify(tokenIds)} in ${JSON.stringify(connectedTokens.join(', '))}`);

    const connectedPolicyTokens: string[] = [];
    for await (const tokenId of tokenIds) {
      const score = await this._redisClient.zScore(this._prefix(`connected-tokens`), tokenId);

      if (score !== null && !isNaN(score) && score > now) {
        connectedPolicyTokens.push(tokenId);
      }
    }

    return connectedPolicyTokens;
  }

  async cacheUser(user: User) {
    const userExists = await this._redisClient.hExists(this._prefix(`users`), user.id);
    if (userExists) return;

    await this._redisClient.hSet(this._prefix(`users`), user.id, JSON.stringify(user));
  }
  async getCachedUser(userId: string) {
    return await this._redisClient.hGet(this._prefix(`users`), userId);
  }
  async removeCachedUser(userId: string) {
    await this._redisClient.hDel(this._prefix(`users`), userId);
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
