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
import policy, { Policy, PolicyConfig } from '../model/core/policy.js';
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
    await this._redisClient.sAdd(this._prefix(`token:${tokenId}:policies`), 'STALE');
  }

  async clearPolicyById(policyId: string) {
    await this._redisClient.hDel(this._prefix(`policies`), policyId);
  }

  async getPoliciesByToken(token: Token): Promise<Policy[]> {
    let policies: Policy[] = [];
    const policyIds = await this._redisClient.sMembers(this._prefix(`token:${token.id}:policies`));

    // If the tokens are marked as stale, we're in the process of cleaning them up. we'll miss the cache and get fresh data.
    const isStale = policyIds.includes('STALE');
    if (policyIds.length < 1 || isStale) {
      const appPolicies = await Helpers.streamAll(this._modelManager.getModel('Policy').find({ _appId: token._appId }));
      policies = AccessControlPolicyMatch.getTokenPolicies(appPolicies, token);

      // Clear out old policies for the token
      await this.clearTokenPolicies(token.id.toString());

      // Index the token's policy properties
      await this.indexTokenPolicyProperties(token.id.toString(), token.policyProperties);

      if (policies.length > 0) {
        await policies.reduce(async (prev, policy) => {
          await prev;

          await this._redisClient.sAdd(this._prefix(`token:${token.id}:policies`), policy.id.toString());

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
  }
  async removeConnectedToken(tokenId: string) {
    await this._redisClient.zRem(this._prefix(`connected-tokens`), tokenId);
  }
  async clearExpiredConnectedTokens() {
    const now = Math.floor(Date.now() / 1000);

    // Get all expired tokens
    const expiredTokens = await this._redisClient.zRangeByScore(this._prefix(`connected-tokens`), 0, now);

    if (expiredTokens.length > 0) {
      Logging.logSilly(`Clearing expired connected tokens: ${expiredTokens.join(', ')}`);
      await this._redisClient.zRemRangeByScore(this._prefix(`connected-tokens`), 0, now);

      // Clean up the expired tokens from the cache
      await expiredTokens.reduce(async (prev, tokenId) => {
        await prev;

        await this.clearTokenPolicies(tokenId);
      }, Promise.resolve());
    } else {
      Logging.logSilly(`No expired connected tokens to clear.`);
    }
  }

  async addPolicy(policy: Policy) {
    const policyExists = await this._redisClient.hExists(this._prefix(`policies`), policy.id.toString());
    if (policyExists) return false;

    await this._redisClient.hSet(this._prefix(`policies`), policy.id.toString(), JSON.stringify(policy));

    const lookupKeys = policy.config.reduce((acc: string[], config: PolicyConfig) => {
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

  async removePolicy(policyId: string) {
    Logging.logSilly(`Removing policy: ${policyId}`);

    // Delete the policy from policies
    await this._redisClient.hDel(this._prefix(`policies`), policyId);
  }

  async clearTokenPolicies(tokenId: string) {
    Logging.logSilly(`Clearing policies for token: ${tokenId}`);

    // Remove the token from all policy tokens
    const policyIds = await this._redisClient.sMembers(this._prefix(`token:${tokenId}:policies`));
    if (policyIds.length > 0) {
      await policyIds.reduce(async (prev, policyId) => {
        await prev;
        if (policyId === 'STALE') return;

        await this._redisClient.sRem(this._prefix(`policy:${policyId}:tokens`), tokenId);
      }, Promise.resolve());
    }

    // Clear out old policies for the token
    await this._redisClient.del(this._prefix(`token:${tokenId}:policies`));

    // Clear out the indexed properties for the token
    await this.removeIndexedTokenPolicyProperties(tokenId);
  }

  async connectTokenToPolicy(tokenId: string, policyId: string) {
    if (!tokenId || !policyId) {
      throw new Error('Token ID and Policy ID are required to connect.');
    }

    Logging.logSilly(`Connecting token ${tokenId} to policy ${policyId}`);
    await this._redisClient.sAdd(this._prefix(`token:${tokenId}:policies`), policyId);
    await this._redisClient.sAdd(this._prefix(`policy:${policyId}:tokens`), tokenId);
  }

  async disconnectTokenFromPolicy(tokenId: string, policyId: string) {
    if (!tokenId || !policyId) {
      throw new Error('Token ID and Policy ID are required to disconnect.');
    }

    Logging.logSilly(`Disconnecting token ${tokenId} from policy ${policyId}`);
    await this._redisClient.sRem(this._prefix(`token:${tokenId}:policies`), policyId);
    await this._redisClient.sRem(this._prefix(`policy:${policyId}:tokens`), tokenId);
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

  // A new policy has been added but we need to check to see if it selects against any connected tokens.
  // if it does then we can cache it otherwise we can ignore it.
  async invalidatePolicyAndTokensBySelection(policyId: string) {
    // Get the policy
    const policy = await this._modelManager.getModel('Policy').findById(policyId) as Policy;
    if (!policy) {
      Logging.logSilly(`Policy not found: ${policyId}`);
      return;
    }

    if (policy.selection === null) return;

    // ! We're asuming that the selection is just a simple object here and doesn't contain $and or $or.
    const policySelectionProperties = Object.keys(policy.selection);
    if (policySelectionProperties.length < 1) return;

    // Get all tokenIds which have the policy properties indexed using sInter
    const tokenIds = await this._redisClient.sInter(policySelectionProperties.map((prop) => this._prefix(`policy:propertyIndex:${prop}`)));
    if (tokenIds.length < 1) {
      Logging.logSilly(`No tokens found for policy properties: ${JSON.stringify(policySelectionProperties)}`);
      return;
    }

    Logging.logSilly(`Found tokens for policy properties: ${tokenIds.length}}`);

    // Now we need to mark these tokens as stale so that they can be re-evaluated on the next request.
    await tokenIds.reduce(async (prev, tokenId) => {
      await prev;

      // Mark the token as stale so that it can be re-evaluated on the next request.
      await this.setTokenIdAsStale(tokenId);
    }, Promise.resolve());

    // We remove the policy from the cache so it will be re-evaluated on the next request.
    this.removePolicy(policyId);
  }

  async indexTokenPolicyProperties(tokenId: string, policyProperties: Record<string, any> | null = null) {
    if (!tokenId) {
      throw new Error('Token ID is required to index properties.');
    }

    const propertyKeys = policyProperties ? Object.keys(policyProperties) : [];

    // Fetch the current properties
    const existingProperties = await this._redisClient.sMembers(this._prefix(`token:${tokenId}:policyProperties`));

    // Work out if any cached properties are missing and if they are remove them from the cache.
    const missingProperties = propertyKeys.filter((key) => !existingProperties.includes(key));
    if (missingProperties.length > 0) {
      await this._redisClient.sRem(this._prefix(`token:${tokenId}:policyProperties`), missingProperties);
      Logging.logSilly(`Removed missing policy properties for token: ${tokenId}, properties: ${JSON.stringify(missingProperties)}`);
    }

    const newProperties = propertyKeys.filter((key) => !existingProperties.includes(key));

    // If we have no properties to index, we can early out.
    if (newProperties.length < 1) {
      Logging.logSilly(`No new policy properties to index for token: ${tokenId}`);
      return;
    }

    await this._redisClient.sAdd(this._prefix(`token:${tokenId}:policyProperties`), newProperties);

    Logging.logSilly(`Indexing policy properties for token: ${tokenId}, properties: ${JSON.stringify(newProperties)}`);

    for (const key of newProperties) {
      await this._redisClient.sAdd(this._prefix(`policy:propertyIndex:${key}`), tokenId);
    }
  }

  async removeIndexedTokenPolicyProperties(tokenId: string) {
    if (!tokenId) {
      throw new Error('Token ID is required to remove indexed properties.');
    }

    Logging.logSilly(`Removing indexed policy properties for token: ${tokenId}`);
    // Get all properties for the token
    const properties = await this._redisClient.sMembers(this._prefix(`token:${tokenId}:policyProperties`));
    if (properties.length < 1) {
      Logging.logSilly(`No indexed policy properties found for token: ${tokenId}`);
      return;
    }

    await this._redisClient.del(this._prefix(`token:${tokenId}:policyProperties`));

    // Remove the token from all indexed properties
    await properties.reduce(async (prev, property) => {
      await prev;

      Logging.logSilly(`Removing token ${tokenId} from indexed property: ${property}`);
      await this._redisClient.sRem(this._prefix(`policy:propertyIndex:${property}`), tokenId);
    }, Promise.resolve());
  }
}
