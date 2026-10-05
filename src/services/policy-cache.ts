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

import { redisPrefix } from '../helpers/index.js';
import Logging from '../helpers/logging.js';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import AccessControlPolicyMatch from '../access-control/policy-match.js';
import { READ_POLICY_VERBS } from '../access-control/helpers.js';

import Model from '../model/index.js';
import { Policy, PolicyConfig } from '../model/core/policy.js';
import { PolicyProperties, PolicyProperty, Token } from '../model/core/token.js';

import * as Helpers from '../helpers/index.js';
import PolicySchemaModel from '../model/core/policy.js';
import { RESTActivity } from '../types/bjs-nrp-objects.js';

// How long a token stays connected without its Socket process renewing it, which it does every heartbeat
export const CONNECTED_TOKEN_TTL_SECONDS = 1 * 3600;
export const CONNECTED_TOKEN_HEARTBEAT_MS = (CONNECTED_TOKEN_TTL_SECONDS * 1000) / 4;

// The rules by which a selection selects a token, see AccessControlPolicyMatch.selects. Changed when they change, so the
// policies cached for each token are worked out again (reselectIfSelectionRulesChanged). 2: every key, exactly (D-32,
// D-35), and @and/@or.
export const SELECTION_RULES_VERSION = '2';

export class PolicyCache {
  private _redisClient: RedisClientType;
  private _modelManager: typeof Model;

  private _connectedTokensTTL = CONNECTED_TOKEN_TTL_SECONDS;
  // Each token's connection changes, run one at a time, so a token is never left connected, or disconnected, by two
  // interleaving
  private _tokenConnectionChanges = new Map<string, Promise<unknown>>();
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
    this._timeoutExpiredConnectedTokens = setTimeout(
      () => this._processConnectedTokensExpiry(),
      this._timeoutExpiredConnectedTokensInterval,
    );
  }

  async getPolicies(policyIds: string[]) {
    if (!policyIds || policyIds.length < 1) {
      Logging.logSilly(`No policy IDs provided, returning empty array.`);
      return [];
    }

    const policies = (await this._redisClient.hmGet(this._prefix('policies'), policyIds))
      .map((policy): Policy | false => (policy ? (JSON.parse(policy) as Policy) : false))
      .filter((policy) => policy !== false);

    const missingPolicies = policyIds.filter((policyId) => !policies.find((policy) => policyId === policy.id));

    if (missingPolicies.length > 0) {
      const newPolicies = await Helpers.streamAll<Policy>(
        this._modelManager.getCoreModel(PolicySchemaModel).find({ id: { $in: missingPolicies } }),
      );

      // Cached with its schema lookups, as addPolicy caches it, so activity on its schemas finds it
      await newPolicies.reduce(async (prev, policy) => {
        await prev;

        await this._cachePolicy(policy);
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
    const policyIds = await this._redisClient.sMembers(this._prefix(`token:${token.id}:policies`));

    // If the tokens are marked as stale, we're in the process of cleaning them up. we'll miss the cache and get fresh data.
    const isStale = policyIds.includes('STALE');
    if (policyIds.length < 1 || isStale) {
      return this.rehydrateToken(token);
    }

    // The token's set was worked out from the token as it's stored, and is worked out again whenever the token's policy
    // properties or a policy's selection change, so it isn't selected again here. A request's token is held in memory
    // by each worker and reloaded a moment after a change, so selecting by it would drop a policy a change had just
    // given the token.
    return this.getPolicies(policyIds);
  }

  async rehydrateToken(token: Token): Promise<Policy[]> {
    // Always rebuild policies using the latest token state from storage.
    // The request token can be stale right after policy property updates.
    const tokenModel = this._modelManager.getCoreModelByName('Token');
    const freshToken = (await tokenModel.findById(token.id)) as Token | null;
    const tokenState = freshToken || token;

    const appPolicies = await Helpers.streamAll<Policy>(
      this._modelManager.getCoreModel(PolicySchemaModel).find({ _appId: tokenState._appId }),
    );
    const policies = AccessControlPolicyMatch.getTokenPolicies(appPolicies, tokenState);
    const tokenId = tokenState.id.toString();
    const tokenPoliciesKey = this._prefix(`token:${tokenId}:policies`);

    // Requests read the token's policies meanwhile, so they're changed without ever being partly there: the policies are
    // cached and linked to the token first, then the token's set is swapped for the new one in one step, and only then
    // are links to policies it no longer has removed
    const oldPolicyIds = (await this._redisClient.sMembers(tokenPoliciesKey)).filter((id) => id !== 'STALE');
    const newPolicyIds = policies.map((policy) => policy.id.toString());

    await policies.reduce(async (prev, policy) => {
      await prev;
      await this.addPolicy(policy);
      await this._redisClient.sAdd(this._prefix(`policy:${policy.id}:tokens`), tokenId);
    }, Promise.resolve());

    if (newPolicyIds.length > 0) {
      const nextKey = `${tokenPoliciesKey}:next:${Math.random().toString(36).slice(2)}`;
      await this._redisClient.sAdd(nextKey, newPolicyIds);
      await this._redisClient.rename(nextKey, tokenPoliciesKey);
    } else {
      await this._redisClient.del(tokenPoliciesKey);
    }

    for (const policyId of oldPolicyIds.filter((id) => !newPolicyIds.includes(id))) {
      await this._redisClient.sRem(this._prefix(`policy:${policyId}:tokens`), tokenId);
    }

    // Index the token's policy properties, which adds and removes only what changed
    await this.indexTokenPolicyProperties(tokenId, tokenState.policyProperties);

    return policies;
  }

  async getPoliciesByRestActivity(activity: RESTActivity): Promise<Policy[]> {
    // Only app schemas' activity is routed: the SPR doesn't send core entities over sockets
    const schemaWildCard = '%APP_SCHEMA%';

    // The policies for the schema itself, for every schema, and for every app schema, in one look
    const policyIds = await this._redisClient.sUnion(
      [activity.schemaName, '%ALL%', schemaWildCard].map((schema) =>
        this._prefix(`app:${activity.appId}:schema:${schema}`),
      ),
    );

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
  private _connectedTokenExpiry() {
    return Math.floor(Date.now() / 1000) + this._connectedTokensTTL;
  }
  private _changeTokenConnection<T>(tokenId: string, change: () => Promise<T>): Promise<T> {
    const previous = this._tokenConnectionChanges.get(tokenId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(change);
    this._tokenConnectionChanges.set(tokenId, next);
    const forget = () => {
      if (this._tokenConnectionChanges.get(tokenId) === next) this._tokenConnectionChanges.delete(tokenId);
    };
    next.then(forget, forget);
    return next;
  }

  async addConnectedToken(tokenId: string) {
    await this._redisClient.zAdd(this._prefix(`connected-tokens`), [
      { value: tokenId, score: this._connectedTokenExpiry() },
    ]);
  }
  async removeConnectedToken(tokenId: string) {
    await this._changeTokenConnection(tokenId, () => this._disconnectToken(tokenId));
  }
  private async _disconnectToken(tokenId: string) {
    await this._redisClient.zRem(this._prefix(`connected-tokens`), tokenId);
    await this._redisClient.del(this._prefix(`connected-token:${tokenId}:sockets`));
  }

  /**
   * Adds one of a token's sockets, connecting the token, or renewing it.
   */
  async addConnectedSocket(tokenId: string, socketId: string) {
    await this._changeTokenConnection(tokenId, async () => {
      await this._redisClient.sAdd(this._prefix(`connected-token:${tokenId}:sockets`), socketId);
      await this.addConnectedToken(tokenId);
    });
  }
  /**
   * Takes one of a token's sockets away, and disconnects the token once it has none left.
   */
  async removeConnectedSocket(tokenId: string, socketId: string) {
    await this._changeTokenConnection(tokenId, async () => {
      const sockets = this._prefix(`connected-token:${tokenId}:sockets`);
      await this._redisClient.sRem(sockets, socketId);
      if ((await this._redisClient.sCard(sockets)) < 1) await this._disconnectToken(tokenId);
    });
  }
  /**
   * Renews the connected tokens a Socket process still has sockets for. A token that isn't connected isn't connected by
   * this: that takes a socket connecting, which works out its policies.
   */
  async renewConnectedTokens(tokenIds: string[]) {
    if (tokenIds.length < 1) return;

    const score = this._connectedTokenExpiry();
    await this._redisClient.zAdd(
      this._prefix(`connected-tokens`),
      tokenIds.map((value) => ({ value, score })),
      { condition: 'XX' },
    );
  }
  async clearExpiredConnectedTokens() {
    const now = Math.floor(Date.now() / 1000);

    // Get all expired tokens
    const expiredTokens = await this._redisClient.zRangeByScore(this._prefix(`connected-tokens`), 0, now);

    if (expiredTokens.length > 0) {
      Logging.logSilly(`Clearing expired connected tokens: ${expiredTokens.join(', ')}`);

      for (const tokenId of expiredTokens) {
        await this._changeTokenConnection(tokenId, async () => {
          // Unless a heartbeat or a socket has renewed it since
          const score = await this._redisClient.zScore(this._prefix(`connected-tokens`), tokenId);
          if (score !== null && score > now) return;

          await this._disconnectToken(tokenId);
          await this.clearTokenPolicies(tokenId);
        });
      }
    } else {
      Logging.logSilly(`No expired connected tokens to clear.`);
    }
  }

  async addPolicy(policy: Policy) {
    const policyExists = await this._redisClient.hExists(this._prefix(`policies`), policy.id.toString());
    if (policyExists) return false;

    await this._cachePolicy(policy);
  }

  // The schema lookups that find a policy for activity: one for each schema it lets a token read
  private _lookupKeys(policy: Policy) {
    return policy.config.reduce((acc: string[], config: PolicyConfig) => {
      for (const schema of config.schema) {
        for (const verb of config.verbs) {
          if (verb === '%ALL%' || READ_POLICY_VERBS.includes(verb)) {
            acc.push(`app:${policy._appId.toString()}:schema:${schema}`);
          }
        }
      }
      return acc;
    }, []);
  }

  private async _cachePolicy(policy: Policy) {
    await this._redisClient.hSet(this._prefix(`policies`), policy.id.toString(), JSON.stringify(policy));

    for (const key of this._lookupKeys(policy)) {
      await this._redisClient.sAdd(this._prefix(key), policy.id.toString());
    }
  }

  /**
   * Takes a policy out of the cache: its content, the schema lookups that find it, and its links to tokens.
   * @param {string} policyId
   * @return {Promise<string[]>} the ids of the tokens it was linked to
   */
  async removePolicy(policyId: string) {
    Logging.logSilly(`Removing policy: ${policyId}`);

    const cached = await this._redisClient.hGet(this._prefix(`policies`), policyId);
    if (cached) {
      for (const key of this._lookupKeys(JSON.parse(cached) as Policy)) {
        await this._redisClient.sRem(this._prefix(key), policyId);
      }
    }
    await this._redisClient.hDel(this._prefix(`policies`), policyId);

    const tokenIds = await this._redisClient.sMembers(this._prefix(`policy:${policyId}:tokens`));
    for (const tokenId of tokenIds) {
      await this._redisClient.sRem(this._prefix(`token:${tokenId}:policies`), policyId);
    }
    await this._redisClient.del(this._prefix(`policy:${policyId}:tokens`));

    return tokenIds;
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
    return (await this.getConnectedTokenIdsByPolicyIds([policyId])).get(policyId) ?? [];
  }

  /**
   * The tokens each policy is linked to that are connected now, by policy: a look at each policy's tokens, then one at
   * when every token they name stops being connected (ZMSCORE, Redis 6.2 or later).
   * @param {string[]} policyIds
   * @return {Promise<Map<string, string[]>>}
   */
  async getConnectedTokenIdsByPolicyIds(policyIds: string[]): Promise<Map<string, string[]>> {
    const now = Math.floor(Date.now() / 1000);

    const linked = await Promise.all(
      policyIds.map((policyId) => this._redisClient.sMembers(this._prefix(`policy:${policyId}:tokens`))),
    );
    const tokenIds = [...new Set(linked.flat())];
    const scores =
      tokenIds.length > 0 ? await this._redisClient.zmScore(this._prefix(`connected-tokens`), tokenIds) : [];
    const connected = new Set(
      tokenIds.filter((_tokenId, idx) => {
        const score = scores[idx];
        return score !== null && score !== undefined && !isNaN(score) && score > now;
      }),
    );

    return new Map(
      policyIds.map((policyId, idx) => [policyId, linked[idx].filter((tokenId) => connected.has(tokenId))]),
    );
  }

  /**
   * Refreshes a policy that was added or changed. Its old content, schema lookups and token links are removed, it is
   * cached again as it now is, and selection is run again for each token it was linked to. Tokens its selection may
   * now match are marked stale, so their policies are worked out again when they're next used.
   * @param {string} policyId
   * @return {Promise}
   */
  async invalidatePolicyAndTokensBySelection(policyId: string) {
    const linkedTokenIds = await this.removePolicy(policyId);

    const [policy] = await Helpers.streamAll<Policy>(
      this._modelManager.getCoreModel(PolicySchemaModel).find({ id: { $in: [policyId] } }),
    );
    if (policy) {
      await this._cachePolicy(policy);
      await this._markTokensSelectableByPolicy(policy, linkedTokenIds);
    } else {
      Logging.logSilly(`Policy not found: ${policyId}`);
    }

    for (const tokenId of linkedTokenIds) {
      await this.reselectToken(tokenId);
    }
  }

  /**
   * Works out a token's policies again from the token as it's stored, or forgets them if it's gone. Its links to
   * policies are what the SPR sends activity by, so this is how a change to a token reaches realtime.
   * @param {string} tokenId
   * @return {Promise}
   */
  async reselectToken(tokenId: string) {
    const tokenModel = this._modelManager.getCoreModelByName('Token');
    const [token] = await Helpers.streamAll<Token>(tokenModel.find({ id: { $in: [tokenId] } }));
    if (!token) {
      await this.clearTokenPolicies(tokenId);
      return;
    }

    await this.rehydrateToken(token);
  }

  /**
   * Marks the policies cached for every token stale if they were selected by other rules than
   * SELECTION_RULES_VERSION's, once across every process sharing this Redis, so a request works them out again. A
   * token's cached policies are used as they are (getPoliciesByToken), so a policy the old rules gave it would otherwise
   * stay. Gives the tokens marked, for reselectTokens to correct the links realtime sends activity by.
   * @return {Promise<string[]>}
   */
  async markStaleIfSelectionRulesChanged(): Promise<string[]> {
    const previous = await this._redisClient.set(this._prefix('policy:selectionRules'), SELECTION_RULES_VERSION, {
      GET: true,
    });
    if (previous === SELECTION_RULES_VERSION) return [];

    const prefix = this._prefix('token:');
    const tokenIds: string[] = [];
    for await (const keys of this._redisClient.scanIterator({ MATCH: `${prefix}*:policies`, COUNT: 1000 })) {
      tokenIds.push(...keys.map((key) => key.slice(prefix.length, -':policies'.length)));
    }
    Logging.log(
      `Selection rules changed (${previous ?? 'none'} to ${SELECTION_RULES_VERSION}), reselecting ${tokenIds.length} tokens`,
    );

    await Promise.all(tokenIds.map((tokenId) => this.setTokenIdAsStale(tokenId)));
    return tokenIds;
  }

  /**
   * Works out each token's policies again, one at a time.
   * @param {string[]} tokenIds
   * @return {Promise}
   */
  async reselectTokens(tokenIds: string[]) {
    for (const tokenId of tokenIds) {
      await this.reselectToken(tokenId);
    }
  }

  private async _markTokensSelectableByPolicy(policy: Policy, skipTokenIds: string[]) {
    const selection = policy.selection;
    if (!selection) return;

    // A selection selects a token only if every key holds and the token has each one (D-35, see
    // AccessControlPolicyMatch.selects), so the candidates are the tokens indexed under every top-level key: the
    // INTERSECTION. A selection of only @and/@or has no such key; a token it selects has at least one of the properties
    // it names, so its candidates are the UNION of those. Either way a superset, as each candidate is selected again.
    //
    // A key with a plain @eq narrows to the tokens indexed under its value. The value index is upper-cased, so it holds
    // the tokens of every case of the value; selection compares exactly (D-32), so that's still a superset. Anything
    // else (@not, ranges, dates, @rex, a list) uses the broad "has this property at all" index.
    const topLevelKeys = Object.keys(selection).filter((key) => key !== '@and' && key !== '@or');
    const namedKeys = topLevelKeys.length > 0 ? topLevelKeys : AccessControlPolicyMatch.selectionKeys(selection);
    if (namedKeys.length < 1) return;

    const propertyIndexKeys = namedKeys.map((prop) => {
      const criteria = topLevelKeys.length > 0 ? selection[prop] : null;
      const rhs = criteria && !Array.isArray(criteria) ? (criteria['@eq'] ?? criteria['$eq']) : undefined;

      if (typeof rhs === 'string' || typeof rhs === 'number') {
        return this._prefix(`policy:propertyIndex:${prop}:${this._normalisePropertyValue(rhs)}`);
      }

      return this._prefix(`policy:propertyIndex:${prop}`);
    });

    const candidates =
      topLevelKeys.length > 0
        ? await this._redisClient.sInter(propertyIndexKeys)
        : await this._redisClient.sUnion(propertyIndexKeys);
    const tokenIds = candidates.filter((id) => !skipTokenIds.includes(id));
    if (tokenIds.length < 1) {
      Logging.logSilly(`No tokens found for policy properties: ${JSON.stringify(namedKeys)}`);
      return;
    }

    Logging.logSilly(`Found tokens for policy properties: ${tokenIds.length}}`);

    // Mark all the candidate tokens as stale so that they can be re-evaluated on the next request.
    await Promise.all(tokenIds.map((tokenId) => this.setTokenIdAsStale(tokenId)));
  }

  // Values are indexed upper-cased, so an index entry holds every case of a value; see _markTokensSelectableByPolicy
  private _normalisePropertyValue(value: PolicyProperty): string {
    return value.toString().toUpperCase();
  }

  // Encodes a key/value pair as a single opaque set member so we can diff and later recover the
  // key it was indexed under, without assuming keys/values never contain a delimiter character.
  private _propertyValueEntry(key: string, value: PolicyProperty): string {
    return JSON.stringify([key, this._normalisePropertyValue(value)]);
  }

  async indexTokenPolicyProperties(tokenId: string, policyProperties: PolicyProperties = null) {
    if (!tokenId) {
      throw new Error('Token ID is required to index properties.');
    }

    const propertyKeys = policyProperties ? Object.keys(policyProperties) : [];

    // Fetch the current properties
    const existingProperties = await this._redisClient.sMembers(this._prefix(`token:${tokenId}:policyProperties`));

    // Work out if any cached properties are no longer part of the token's policyProperties,
    // and if so remove them from both the forward index and the reverse property index.
    const missingProperties = existingProperties.filter((key) => !propertyKeys.includes(key));
    if (missingProperties.length > 0) {
      await this._redisClient.sRem(this._prefix(`token:${tokenId}:policyProperties`), missingProperties);
      Logging.logSilly(
        `Removed missing policy properties for token: ${tokenId}, properties: ${JSON.stringify(missingProperties)}`,
      );

      await Promise.all(
        missingProperties.map((key) => this._redisClient.sRem(this._prefix(`policy:propertyIndex:${key}`), tokenId)),
      );
    }

    const newProperties = propertyKeys.filter((key) => !existingProperties.includes(key));

    if (newProperties.length < 1) {
      Logging.logSilly(`No new policy properties to index for token: ${tokenId}`);
    } else {
      await this._redisClient.sAdd(this._prefix(`token:${tokenId}:policyProperties`), newProperties);

      Logging.logSilly(
        `Indexing policy properties for token: ${tokenId}, properties: ${JSON.stringify(newProperties)}`,
      );

      await Promise.all(
        newProperties.map((key) => this._redisClient.sAdd(this._prefix(`policy:propertyIndex:${key}`), tokenId)),
      );
    }

    // Value-qualified index: lets an @eq selection narrow to just the matching value instead of
    // every token that has the property at all. This has to run even when the key set above hasn't
    // changed, since a property's *value* can change without its key being added or removed.
    await this._indexTokenPolicyPropertyValues(tokenId, policyProperties);
  }

  private async _indexTokenPolicyPropertyValues(tokenId: string, policyProperties: PolicyProperties) {
    const desiredEntries = new Set<string>();
    for (const key of policyProperties ? Object.keys(policyProperties) : []) {
      const rawValue = policyProperties![key];
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      values.forEach((value) => desiredEntries.add(this._propertyValueEntry(key, value)));
    }

    const existingEntries = await this._redisClient.sMembers(this._prefix(`token:${tokenId}:policyPropertyValues`));

    const missingEntries = existingEntries.filter((entry) => !desiredEntries.has(entry));
    if (missingEntries.length > 0) {
      await this._redisClient.sRem(this._prefix(`token:${tokenId}:policyPropertyValues`), missingEntries);
      await Promise.all(
        missingEntries.map((entry) => {
          const [key, value] = JSON.parse(entry) as [string, string];
          return this._redisClient.sRem(this._prefix(`policy:propertyIndex:${key}:${value}`), tokenId);
        }),
      );
    }

    const newEntries = [...desiredEntries].filter((entry) => !existingEntries.includes(entry));
    if (newEntries.length < 1) return;

    await this._redisClient.sAdd(this._prefix(`token:${tokenId}:policyPropertyValues`), newEntries);
    await Promise.all(
      newEntries.map((entry) => {
        const [key, value] = JSON.parse(entry) as [string, string];
        return this._redisClient.sAdd(this._prefix(`policy:propertyIndex:${key}:${value}`), tokenId);
      }),
    );
  }

  async removeIndexedTokenPolicyProperties(tokenId: string) {
    if (!tokenId) {
      throw new Error('Token ID is required to remove indexed properties.');
    }

    Logging.logSilly(`Removing indexed policy properties for token: ${tokenId}`);
    // Get all properties for the token
    const properties = await this._redisClient.sMembers(this._prefix(`token:${tokenId}:policyProperties`));
    const valueEntries = await this._redisClient.sMembers(this._prefix(`token:${tokenId}:policyPropertyValues`));

    if (properties.length < 1 && valueEntries.length < 1) {
      Logging.logSilly(`No indexed policy properties found for token: ${tokenId}`);
      return;
    }

    await this._redisClient.del(this._prefix(`token:${tokenId}:policyProperties`));
    await this._redisClient.del(this._prefix(`token:${tokenId}:policyPropertyValues`));

    // Remove the token from all indexed properties
    await Promise.all([
      ...properties.map((property) => {
        Logging.logSilly(`Removing token ${tokenId} from indexed property: ${property}`);
        return this._redisClient.sRem(this._prefix(`policy:propertyIndex:${property}`), tokenId);
      }),
      ...valueEntries.map((entry) => {
        const [key, value] = JSON.parse(entry) as [string, string];
        return this._redisClient.sRem(this._prefix(`policy:propertyIndex:${key}:${value}`), tokenId);
      }),
    ]);
  }
}
