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
import createConfig from '@dpc/node-env-obj';

import { createClient, RedisClientType } from '@redis/client';

import Bootstrap from './bootstrap.js';

const Config = createConfig() as unknown as Config;

import Model from './model/index.js';
import * as Helpers from './helpers/index.js';
import IOStats from './helpers/io-stats.js';
import { KeyedQueue } from './helpers/keyed-queue.js';
import Logging from './helpers/logging.js';

import { PolicyError } from './access-control/index.js';
import { filterPolicyConfigs, isPolicyExpired } from './access-control/helpers.js';
import AccessControlEnv, { ACEnv } from './access-control/env.js';
import AccessControlFilters from './access-control/filter.js';
import AccessControlProjection from './access-control/projection.js';
import { dependsOnToken, evaluate, Grant } from './access-control/evaluator.js';

import Datastore from './datastore/index.js';
import { Datastore as DatastoreInstance } from './datastore/index.js';
import { DataShareSocketSharePayload, RESTActivity } from './types/bjs-nrp-objects.js';
import { Policy } from './model/core/policy.js';
import TokenSchemaModel, { Token } from './model/core/token.js';

import { PolicyCache } from './services/policy-cache.js';
import { SourceDataSharingRouting } from './services/source-ds-routing.js';
import type { AppSchemaUpdatedMessage, SocketConnectionMessage, SocketHeartbeatMessage } from './services/nrp.js';
import UserSchemaModel, { User } from './model/core/user.js';
import StandardModel from './model/type/standard.js';
import RemoteCombinedModel from './model/type/remote-combined.js';
import type { AdapterDocument } from './types/datastore.js';

// Abstract policy cache

interface ActivityMetadata {
  id: string;
  timer: Helpers.Timer;
}

// The pathSpec suffixes of the schema bulk routes (routes/schema-routes/update-many.ts and delete-many.ts).
const BULK_UPDATE_PATH = '/bulk/update';
const BULK_DELETE_PATH = '/bulk/delete';

/*
 * Message comes in, what's the work?
 * - Who should get this message?
 *  - Does this policy apply
 *
 * # SPR - New process SPR (Socket Policy Router)
 * - Activity Broadcast, pub'd to redis
 * - A SDR process claims the activity. (Conflict resolution?)
 * - SDR process consults list of connected policies (Policies that are accocated with currently connected tokens).
 * - SDR checks activity against each policy, condition is checked, query is run against activity to check it's releivent, projection is applied.
 * - SDR Broadcasts (Redis Pub) activity along with the list of tokens which need to be notified.
 *   Socket processes will just discard activity if none of the tokens match.
 *
 * Complexities:
 * - Maintining a list of connected tokens to applicable policies ready for parsing.
 * - Connecting won't mean you automaticly get activities through as your connection plus policies would need to be updated, Missed activity (Replay?)
 */

// What a token may read of an activity: the properties its policies let it read, or every one (null)
type Reading = { keys: string[] | null };

// Adds what a policy lets a token read to what its other policies do
function addReading(reads: Map<string, Reading>, tokenId: string, reading: Reading | null) {
  if (!reading) return;
  const existing = reads.get(tokenId);
  if (!existing) {
    reads.set(tokenId, { keys: reading.keys ? [...reading.keys] : null });
  } else if (existing.keys && reading.keys) {
    existing.keys = [...new Set([...existing.keys, ...reading.keys])];
  } else {
    existing.keys = null;
  }
}

/**
 * Need to cache the app policies, when a policy is updated, we need to update the cache.
 */
export default class BootstrapSocketPolicyRouter extends Bootstrap {
  isPrimary: boolean;

  private _redisClient?: RedisClientType;

  private _primaryDatastore: DatastoreInstance;

  private _policyCache?: PolicyCache;

  private _broadcastTokenBatchSize = 1000;

  // Each entity's activities, relayed one after another
  private _entityActivities = new KeyedQueue((err, key) =>
    Logging.logError(`Unable to relay an activity for ${key}: ${Helpers.getThrownErrorMessage(err)}`),
  );

  private _shutdown = false;

  constructor() {
    super();

    this._primaryDatastore = Datastore.createInstance(Config.datastore, true);

    this.isPrimary = Config.sio.app === 'primary';
  }

  override async init() {
    await super.init();

    Logging.logSilly('BootstrapSPR:init');

    await this._primaryDatastore.connect();

    this._redisClient = createClient({
      url: Config.redis.url,
    });
    await this._redisClient.connect();

    // Register some services.
    this.__services.set('modelManager', Model);
    this.__services.set('policyCache', new PolicyCache(this._redisClient, Model));
    // For a collection with remotes to find a partner's entity by its source
    this.__services.set('sdsRouting', new SourceDataSharingRouting(this._redisClient));

    this._policyCache = this.__services.get('policyCache') as PolicyCache;

    // Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
    await Model.init(this.__services);

    // Init models
    await Model.initCoreModels();
    await Model.initSchema();

    return await this.__createCluster();
  }

  override async clean() {
    this._shutdown = true;

    await super.clean();

    Logging.logSilly('BootstrapSPR:clean');

    if (this._redisClient) {
      await this._redisClient.quit();
    }

    // Destory all models
    await Model.clean();

    if (this._policyCache) {
      this._policyCache.clean();
    }

    if (this.__services.has('sdsRouting')) {
      (this.__services.get('sdsRouting') as SourceDataSharingRouting).clean();
      this.__services.delete('sdsRouting');
    }

    // Close Datastore connections
    Logging.logSilly('Closing down all datastore connections');
    await Datastore.clean();
  }

  override async __initMain() {
    if (this.isPrimary) {
      Logging.logVerbose(`Primary Main SPR`);
      await this.__registerNRPPrimaryListeners();

      if (!this._policyCache) throw new Error('No Policy Cache');
      await this._policyCache.initProcessing();
    }

    await this.__spawnWorkers();
  }

  override async __initWorker() {}

  async __registerNRPPrimaryListeners() {
    Logging.logDebug(`Primary Main`);

    if (!this.__nrp) throw new Error('No NRP instance');

    // TODO: Event should come from the SPR
    this.__nrp.on('rest:activity', (data) =>
      IOStats.run('spr', () => this._handleIncomingMessage(JSON.parse(data) as RESTActivity)),
    );
    this.__nrp.on('worker:socket:connection', (message) => this._socketConnection(message));
    this.__nrp.on('worker:socket:disconnect', (message) => this._socketDisconnection(message));
    this.__nrp.on('worker:socket:heartbeat', async (json: string) => {
      if (!this._policyCache) throw new Error('No Policy Cache');
      await this._policyCache.renewConnectedTokens((JSON.parse(json) as SocketHeartbeatMessage).tokenIds);
    });
    this.__nrp.on('token:deleted', (json: string) =>
      this._tokensDeleted((JSON.parse(json) as { tokenIds: string[] }).tokenIds),
    );

    this.__nrp.on('app-schema:updated', async (json: string) => {
      const data = JSON.parse(json) as AppSchemaUpdatedMessage;
      await Model.initSchema(data.appId);
    });
  }

  // Use redis to store and cache a list of connected tokens and their associated policies
  async storePolicy(policy: Policy) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    try {
      this._policyCache?.storePolicy(policy);
    } catch (error: unknown) {
      Logging.logError(Helpers.getThrownErrorMessage(error));
      throw error; // Re-throw the error to be handled by the caller
    }

    return policy.id;
  }

  async linkTokenToPolicy(tokenId: string, policyId: string) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    try {
      this._policyCache.connectTokenToPolicy(tokenId, policyId);
    } catch (error: unknown) {
      Logging.logError(Helpers.getThrownErrorMessage(error));
      throw error;
    }
  }

  // Token is connected
  // - Its policies are looked up, from the cache, which works them out again if the token is stale or unknown. This is
  //   done for a token that's already connected too, so a new socket never renews a connection without them.
  // - It's added to, or its time renewed on, the list of connected tokens
  private async _socketConnection(message: string) {
    if (!this._policyCache) throw new Error('No Policy Cache');
    const { tokenId, socketId } = this._socketOf(message);

    // Look up the token by ID
    const token = (await Model.getCoreModel(TokenSchemaModel).findOne({ id: tokenId })) as Token;
    if (!token) {
      Logging.logError(`Token not found: ${tokenId}`);
      return;
    }

    await this._policyCache.getPoliciesByToken(token);

    // Store the token in the list of connected tokens, with the socket
    if (socketId) await this._policyCache.addConnectedSocket(token.id.toString(), socketId);
    else await this._policyCache.addConnectedToken(token.id.toString());
  }

  // A socket disconnected: the token stays connected until its last socket has
  private async _socketDisconnection(message: string) {
    if (!this._policyCache) throw new Error('No Policy Cache');
    const { tokenId, socketId } = this._socketOf(message);

    if (socketId) await this._policyCache.removeConnectedSocket(tokenId, socketId);
    else await this._policyCache.removeConnectedToken(tokenId);
  }

  // A socket connection message, or the bare token id an older Socket process sends
  private _socketOf(message: string): Partial<SocketConnectionMessage> & { tokenId: string } {
    return message.startsWith('{') ? (JSON.parse(message) as SocketConnectionMessage) : { tokenId: message };
  }

  // The Socket processes close a deleted token's sockets. It's also taken off the connected list here, so nothing is
  // routed to it even if a socket's disconnect never arrives.
  private async _tokensDeleted(tokenIds: string[]) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    for (const tokenId of tokenIds) await this._policyCache.removeConnectedToken(tokenId);
  }

  /**
   * Handles each entity's part of an activity. An entity's activities are relayed in the order they arrive, each after
   * the one before it is done, while other entities' go alongside; one that fails is logged, and the next still goes.
   * Each entity of a bulk activity takes its place in its queue as the activity arrives, so a later activity can't
   * overtake it, and they're still handled one after another.
   */
  private async _handleIncomingMessage(activity: RESTActivity) {
    let previous: Promise<void> = Promise.resolve();
    const handled = this.__splitBulkActivity(activity).map((entityActivity) => {
      // A queue's job settles when it's done, failed or not
      const after = previous;
      previous = this._entityActivities.push(this.__entityKey(entityActivity), async () => {
        await after;
        return this.__handleEntityActivity(entityActivity);
      });
      return previous;
    });
    await Promise.all(handled);
  }

  // The entity an activity is for; a delete of every entity is for the collection
  private __entityKey(activity: RESTActivity) {
    const params = activity.params as Record<string, unknown> | undefined;
    const response = activity.response as Record<string, unknown> | null | undefined;
    const entityId = params?.id ?? (response && typeof response === 'object' ? response.id : undefined) ?? '';
    return `${activity.appId}:${activity.schemaName}:${String(entityId)}`;
  }

  /**
   * A bulk update or delete changes several entities, and a token may be allowed to see only some of them. The
   * policies are checked against one entity at a time, so each entity becomes the activity an update-one or delete-one
   * request would have produced. System tokens see everything, so their copy (isSuper) stays whole.
   */
  private __splitBulkActivity(activity: RESTActivity): RESTActivity[] {
    const scopedDeleteAll = this.__splitScopedDeleteAllActivity(activity);
    if (scopedDeleteAll) return scopedDeleteAll;

    if (activity.isSuper || activity.verb !== 'post' || !Array.isArray(activity.response)) return [activity];

    const bulkPath = [BULK_UPDATE_PATH, BULK_DELETE_PATH].find((suffix) => activity.pathSpec?.endsWith(suffix));
    if (!bulkPath) return [activity];

    const pathSpec = `${activity.pathSpec.slice(0, -bulkPath.length)}/:id`;
    const routePath = activity.path.split('/').slice(0, -2).join('/');

    return activity.response.flatMap((entry, idx): RESTActivity[] => {
      const item = entry as { id?: string; results?: unknown } | null;
      if (!item?.id) return [];

      const entityActivity = { ...activity, path: `${routePath}/${item.id}`, pathSpec, params: { id: item.id } };
      if (bulkPath === BULK_DELETE_PATH) {
        const deletedEntities = activity.deletedEntities?.filter((entity) => String(entity.id) === String(item.id));
        return [{ ...entityActivity, verb: 'delete', response: true, deletedEntities }];
      }

      // Refused updates carry `results: null`, nothing changed for them.
      if (!Array.isArray(item.results)) return [];
      // An entity changed through an agreement is found there
      const dataShareId = activity.dataShareIds?.[idx] ?? undefined;
      return [{ ...entityActivity, verb: 'put', response: item.results, ...(dataShareId ? { dataShareId } : {}) }];
    });
  }

  /**
   * A delete of every entity that the caller's policies limited names the entities it deleted, and the rest are still
   * there. Relayed whole, it would tell a client to drop them all, so each becomes the activity a delete-one request
   * would have produced, for system tokens too. Returns null for any other activity.
   */
  private __splitScopedDeleteAllActivity(activity: RESTActivity): RESTActivity[] | null {
    const params = activity.params as Record<string, unknown> | undefined;
    if (activity.verb !== 'delete' || params?.id || !Array.isArray(activity.response)) return null;

    const pathSpec = `${activity.pathSpec.replace(/\/$/, '')}/:id`;
    const routePath = activity.path.replace(/\/$/, '');

    return activity.response.flatMap((entry): RESTActivity[] => {
      const item = entry as { id?: string } | null;
      if (!item?.id) return [];

      const deletedEntities = activity.deletedEntities?.filter((entity) => String(entity.id) === String(item.id));
      return [
        {
          ...activity,
          path: `${routePath}/${item.id}`,
          pathSpec,
          params: { id: item.id },
          response: true,
          deletedEntities,
        },
      ];
    });
  }

  private async __handleEntityActivity(incoming: RESTActivity) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    // A deleted entity can't be looked up, so the entities a delete removed come with the activity, as they were. They
    // are only for checking policies against, so they're taken off before the activity is sent anywhere.
    const { deletedEntities, dataShareId, dataShareIds: _dataShareIds, ...activity } = incoming;

    // Create a container that will be used to track the message event within the SPR and a timer.
    const activityMetadata: ActivityMetadata = {
      id: Datastore.getInstance('core').ID.new().toString(),
      timer: new Helpers.Timer(),
    };

    // Core entities (users, tokens, policies, lambdas...) aren't sent over sockets
    if (activity.isCoreSchema) {
      Logging.logSilly(`Skipping message broadcast, ${activity.schemaName} is a core schema`);
      return;
    }

    // Not even system tokens get an activity marked not to broadcast
    if (activity.broadcast === false) {
      Logging.logSilly('Skipping message broadcast, broadcast is disabled');
      return;
    }

    // System tokens get every activity whole, so their copy reads no entity
    if (activity.isSuper) {
      const tokenModel = Model.getCoreModel(TokenSchemaModel);
      const systemTokens = await tokenModel.find({ type: 'system' });

      const systemTokenIds: string[] = [];
      for await (const systemToken of systemTokens as AsyncIterable<Token>) systemTokenIds.push(String(systemToken.id));
      this.__sendToTokens(systemTokenIds, activity);
      Logging.logTimer(
        `_handleIncomingMessage::systemTokens ${systemTokenIds.length}`,
        activityMetadata.timer,
        Logging.Constants.LogLevel.SILLY,
        `${activityMetadata.id}`,
      );

      return;
    }

    // The policies that can let a token read the schema now, each with the configs that can, and whether one of them
    // refers to the token's user
    const candidates = (await this._policyCache.getPoliciesByRestActivity(activity)).flatMap((policy) => {
      if (isPolicyExpired(policy)) return [];
      const configs = filterPolicyConfigs(policy, activity.schemaName, activity.verb, false, true);
      if (configs.length < 1) return [];
      return [{ policy: { ...policy, config: configs }, perToken: configs.some((c) => dependsOnToken(policy, c)) }];
    });
    if (candidates.length < 1) {
      Logging.logSilly('Skipping message broadcast, no relevant policies found');
      return;
    }

    // Only the policies a connected token holds are evaluated, and nothing is read for the others
    const connected = await this._policyCache.getConnectedTokenIdsByPolicyIds(
      candidates.map(({ policy }) => policy.id),
    );
    const reached = candidates.filter(({ policy }) => (connected.get(policy.id) ?? []).length > 0);
    if (reached.length < 1) {
      Logging.logSilly('Skipping message broadcast, no token connected for its policies');
      return;
    }

    const activityParams = activity.params as Record<string, unknown>;
    const activityResponse =
      typeof activity.response === 'object' && activity.response !== null
        ? (activity.response as Record<string, unknown>)
        : {};
    const entityId = activityParams.id ? activityParams.id : activityResponse.id;

    // The entity's model, whose schema a policy's query is read against, as REST reads it
    const appModel = entityId ? await Model.getAppModel<StandardModel>(activity.appId, activity.schemaName) : null;
    if (entityId && !appModel) {
      Logging.logWarn(
        `Unable to broadcast entity, can not find ${activity.schemaName} for ${activity.appId} in the database`,
      );
      return;
    }

    // The entity is read once, when a policy that holds for a token first needs it
    let entityRead: Promise<AdapterDocument | null> | undefined;
    const entity = () => {
      entityRead ??= this.__readEntity(activity, entityId, appModel, deletedEntities, dataShareId);
      return entityRead;
    };

    // Each policy is evaluated as REST evaluates it, for reading the activity's schema. One whose configs refer to the
    // token's user is evaluated for each token connected to it, with that token's user (the tokens and their users are
    // read in one look each); the rest once, for every token connected to them. A token then gets one activity, with
    // what all its policies let it read, and the tokens that may read the same of it are sent it together.
    Logging.logSilly(`Found ${reached.length} policies with connected tokens for event`);
    const perTokenIds = [
      ...new Set(reached.filter(({ perToken }) => perToken).flatMap(({ policy }) => connected.get(policy.id) ?? [])),
    ];
    const tokenEnvs = await this.__constructTokenEnvs(perTokenIds, activity.appId);
    const appEnv = AccessControlEnv.generateRequestGlobalEnvs(null, activity.appId, null);

    const reads = new Map<string, Reading>();
    for (const { policy, perToken } of reached) {
      const tokenIds = connected.get(policy.id) ?? [];
      Logging.logSilly(
        `_handleIncomingMessage::start policy:${policy.name}, configs:${policy.config.length}, tokens:${tokenIds.length}`,
        `${activityMetadata.id}-${policy.id}`,
      );

      if (perToken) {
        for (const tokenId of tokenIds) {
          const env = tokenEnvs.get(tokenId) ?? appEnv;
          addReading(
            reads,
            tokenId,
            await this.__readingFor(policy, activity, entity, appModel, env, activityMetadata),
          );
        }
        continue;
      }

      const reading = await this.__readingFor(policy, activity, entity, appModel, appEnv, activityMetadata);
      for (const tokenId of tokenIds) addReading(reads, tokenId, reading);
    }

    this.__relay(activity, reads);
  }

  // The entity an activity is about: a deleted one as the delete sent it, a partner's where its agreement reads, and
  // anything else by its source, which is the app itself unless it names a partner
  private async __readEntity(
    activity: RESTActivity,
    entityId: unknown,
    model: StandardModel | null,
    deletedEntities: RESTActivity['deletedEntities'],
    dataShareId: RESTActivity['dataShareId'],
  ): Promise<AdapterDocument | null> {
    if (!entityId) return null;
    if (activity.verb === 'delete') {
      return deletedEntities?.find((deleted) => String(deleted.id) === String(entityId)) ?? null;
    }
    if (!model) return null;

    const params = activity.params as Record<string, unknown>;
    const response =
      typeof activity.response === 'object' && activity.response !== null
        ? (activity.response as Record<string, unknown>)
        : {};
    const sourceId = params.sourceId ?? response.sourceId;
    return dataShareId && model instanceof RemoteCombinedModel
      ? await model.findSharedById(String(entityId), dataShareId)
      : await model.findById(entityId as string, typeof sourceId === 'string' ? sourceId : null);
  }

  /**
   * Sends each token the activity as it may read it. Tokens that may read the same of it are sent it in one message;
   * a token that may read none of an update's changes isn't sent it.
   */
  private __relay(activity: RESTActivity, reads: Map<string, Reading>) {
    const groups = new Map<string, { keys: string[] | null; tokenIds: string[] }>();
    for (const [tokenId, reading] of reads) {
      const signature = reading.keys ? JSON.stringify([...reading.keys].sort()) : '*';
      const group = groups.get(signature) ?? { keys: reading.keys, tokenIds: [] };
      group.tokenIds.push(tokenId);
      groups.set(signature, group);
    }

    for (const { keys, tokenIds } of groups.values()) {
      if (!keys) {
        this.__sendToTokens(tokenIds, activity);
        continue;
      }

      const response = AccessControlProjection.projectActivityResponse(activity.verb, activity.response, keys);
      if (response !== null) this.__sendToTokens(tokenIds, { ...activity, response });
    }
  }

  /**
   * The env each token's policies are read with, its user's: the tokens are read in one look, and their users in
   * another. A token that has gone gets the app's.
   */
  private async __constructTokenEnvs(tokenIds: string[], appId: string): Promise<Map<string, ACEnv>> {
    const envs = new Map<string, ACEnv>();
    if (tokenIds.length < 1) return envs;

    const tokenModel = Model.getCoreModel(TokenSchemaModel);
    const userModel = Model.getCoreModel(UserSchemaModel);

    const tokens = new Map<string, Token>();
    const foundTokens = await tokenModel.find({ _id: { $in: tokenIds.map((id) => tokenModel.createId(id)) } });
    for await (const token of foundTokens as AsyncIterable<Token>) tokens.set(String(token.id), token);

    const userIds = [
      ...new Set([...tokens.values()].flatMap((token) => (token._userId ? [String(token._userId)] : []))),
    ];
    const users = new Map<string, User>();
    if (userIds.length > 0) {
      const foundUsers = await userModel.find({ _id: { $in: userIds.map((id) => userModel.createId(id)) } });
      for await (const user of foundUsers as AsyncIterable<User>) users.set(String(user.id), user);
    }

    for (const tokenId of tokenIds) {
      const token = tokens.get(tokenId);
      if (!token) Logging.logWarn(`Token not found: ${tokenId}`);
      const user = token?._userId ? (users.get(String(token._userId)) ?? null) : null;
      envs.set(tokenId, AccessControlEnv.generateRequestGlobalEnvs(null, appId, user));
    }

    return envs;
  }

  /**
   * What a policy lets a token read of an activity, or null: the policy is evaluated with the token's env (or the
   * app's), and the token may read the entity when a grant's query reads it, with the properties of each grant that
   * does. A delete of every entity, which names none, may be read whole when the policy grants a read at all.
   */
  private async __readingFor(
    policy: Policy,
    activity: RESTActivity,
    entityOf: () => Promise<Record<string, unknown> | null>,
    model: StandardModel | null,
    env: ACEnv,
    activityMetadata: ActivityMetadata,
  ): Promise<Reading | null> {
    const logEnd = (reason: string) =>
      Logging.logTimer(
        `_handleIncomingMessage::end-${reason}`,
        activityMetadata.timer,
        Logging.Constants.LogLevel.SILLY,
        `${activityMetadata.id}-${policy.id}`,
      );

    let grants: Grant[];
    try {
      grants = await evaluate([policy], {
        schemaName: activity.schemaName,
        isCoreSchema: false,
        verb: activity.verb.toUpperCase(),
        reads: true,
        appId: activity.appId,
        env,
      });
    } catch (err: unknown) {
      // The policy grants this token nothing here: a condition doesn't hold, or a query's env value isn't set. A policy
      // that can't be evaluated is logged, and the token's other policies still apply
      if (!(err instanceof PolicyError)) {
        Logging.logError(
          `Unable to evaluate policy ${policy.name} for an activity: ${Helpers.getThrownErrorMessage(err)}`,
        );
      }
      logEnd(`not-granted ${Helpers.getThrownErrorMessage(err)}`);
      return null;
    }

    const entity = await entityOf();
    if (!entity && activity.verb === 'delete') {
      // A delete of every entity, which no policy limited, names none, so there's nothing to check a query against, and
      // the delete goes to every token the policy reaches.
      if (!(activity.params as Record<string, unknown>)?.id) {
        logEnd('no-entity-deletion');
        return { keys: null };
      }

      // An entity delete comes with the entity as it was. Without it (it had already gone) there's no telling whether
      // the token could read it, so the token isn't told.
      Logging.logWarn('Unable to broadcast deletion, the deleted entity was not sent with the activity');
      return null;
    }

    if (!entity || !model) {
      Logging.logWarn('Unable to broadcast entity, can not find entity');
      return null;
    }

    // The grants whose query reads the entity, as a REST query would (D-31); a query left empty reads every entity
    const reading = grants.filter(
      (grant) =>
        Object.keys(grant.query).length < 1 ||
        AccessControlFilters.evaluateQueryAgainstEntity(grant.query, entity, model),
    );
    if (reading.length < 1) {
      logEnd(`not-read entityId: ${String(entity.id)}`);
      return null;
    }

    // The token may read what the grants that read the entity let it, as on REST
    return {
      keys: reading.some((grant) => !grant.projection)
        ? null
        : [...new Set(reading.flatMap((grant) => grant.projection ?? []))],
    };
  }

  // Sends an activity to tokens, a thousand to a message
  private __sendToTokens(tokenIds: string[], activity: RESTActivity) {
    for (let i = 0; i < tokenIds.length; i += this._broadcastTokenBatchSize) {
      this.__nrp?.emit(
        'spr:activity',
        JSON.stringify({
          tokens: tokenIds.slice(i, i + this._broadcastTokenBatchSize),
          activity,
        } satisfies DataShareSocketSharePayload),
      );
    }
  }
}
