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
import Logging from './helpers/logging.js';

import { ApplicablePolicyConfig } from './access-control/index.js';
import {
  CombineEnvGroups,
  containsTokenLevelRef,
  filterPolicyConfigs,
  isPolicyExpired,
} from './access-control/helpers.js';
import AccessControlEnv, { ACEnv, ACPolicyEnvCombined } from './access-control/env.js';
import AccessControlFilters, { UnresolvedEnvError } from './access-control/filter.js';
import AccessControlConditions from './access-control/conditions.js';
import AccessControlProjection from './access-control/projection.js';

import Datastore from './datastore/index.js';
import { Datastore as DatastoreInstance } from './datastore/index.js';
import { DataShareSocketSharePayload, RESTActivity } from './types/bjs-nrp-objects.js';
import { Policy } from './model/core/policy.js';
import TokenSchemaModel, { Token } from './model/core/token.js';

import { PolicyCache } from './services/policy-cache.js';
import type { AppSchemaUpdatedMessage } from './services/nrp.js';
import UserSchemaModel, { User } from './model/core/user.js';
import StandardModel from './model/type/standard.js';
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

/**
 * Need to cache the app policies, when a policy is updated, we need to update the cache.
 */
export default class BootstrapSocketPolicyRouter extends Bootstrap {
  isPrimary: boolean;

  private _redisClient?: RedisClientType;

  private _primaryDatastore: DatastoreInstance;

  private _policyCache?: PolicyCache;

  private _broadcastTokenBatchSize = 1000;

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
    this.__nrp.on('worker:socket:connection', (tokenId) => this._socketConnection(tokenId));
    this.__nrp.on('worker:socket:disconnect', (tokenId) => this._socketDisconnection(tokenId));
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
  private async _socketConnection(tokenId: string) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    // Look up the token by ID
    const token = (await Model.getCoreModel(TokenSchemaModel).findOne({ id: tokenId })) as Token;
    if (!token) {
      Logging.logError(`Token not found: ${tokenId}`);
      return;
    }

    await this._policyCache.getPoliciesByToken(token);

    // Store the token in the list of connected tokens
    await this._policyCache.addConnectedToken(token.id.toString());
  }

  // If a token is disconnected
  // - Remove the token from the list of connected tokens
  // - Remove the token from the list of tokens associated with a policy
  private async _socketDisconnection(tokenId: string) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    await this._policyCache.removeConnectedToken(tokenId);
  }

  // The Socket processes close a deleted token's sockets. It's also taken off the connected list here, so nothing is
  // routed to it even if a socket's disconnect never arrives.
  private async _tokensDeleted(tokenIds: string[]) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    for (const tokenId of tokenIds) await this._policyCache.removeConnectedToken(tokenId);
  }

  private async _handleIncomingMessage(activity: RESTActivity) {
    for (const entityActivity of this.__splitBulkActivity(activity)) {
      await this.__handleEntityActivity(entityActivity);
    }
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

    return activity.response.flatMap((entry): RESTActivity[] => {
      const item = entry as { id?: string; results?: unknown } | null;
      if (!item?.id) return [];

      const entityActivity = { ...activity, path: `${routePath}/${item.id}`, pathSpec, params: { id: item.id } };
      if (bulkPath === BULK_DELETE_PATH) {
        const deletedEntities = activity.deletedEntities?.filter((entity) => String(entity.id) === String(item.id));
        return [{ ...entityActivity, verb: 'delete', response: true, deletedEntities }];
      }

      // Refused updates carry `results: null`, nothing changed for them.
      if (!Array.isArray(item.results)) return [];
      return [{ ...entityActivity, verb: 'put', response: item.results }];
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
    const { deletedEntities, ...activity } = incoming;

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

    let entity: AdapterDocument | null = null;
    const activityParams = activity.params as Record<string, unknown>;
    const activityResponse =
      typeof activity.response === 'object' && activity.response !== null
        ? (activity.response as Record<string, unknown>)
        : {};
    const entityId = activityParams.id ? activityParams.id : activityResponse.id;

    if (entityId && activity.verb === 'delete') {
      entity = deletedEntities?.find((deleted) => String(deleted.id) === String(entityId)) ?? null;
    } else if (entityId) {
      const appModel = await Model.getAppModel<StandardModel>(activity.appId, activity.schemaName);
      if (!appModel) {
        Logging.logWarn(
          `Unable to broadcast entity, can not find ${activity.schemaName} for ${activity.appId} in the database`,
        );
        return;
      }

      entity = await appModel.findById(entityId as string);
      // TODO: Entity needs to be flatterned for processing.
    }

    // Not even system tokens get an activity marked not to broadcast
    if (activity.broadcast === false) {
      Logging.logSilly('Skipping message broadcast, broadcast is disabled');
      return;
    }

    if (activity.isSuper) {
      // TODO: Super tokens could be cached in redis, app tokens could be also be cached.
      const tokenModel = Model.getCoreModel(TokenSchemaModel);
      const systemTokens = await tokenModel.find({ type: 'system' });

      for await (const systemToken of systemTokens as AsyncIterable<Token>) {
        await this.__broadcastDataByToken(systemToken.id, activity);
        Logging.logTimer(
          `_handleIncomingMessage::systemToken ${systemToken.id}`,
          activityMetadata.timer,
          Logging.Constants.LogLevel.SILLY,
          `${activityMetadata.id}`,
        );
      }

      return;
    }

    const policies = await this._policyCache.getPoliciesByRestActivity(activity);
    if (policies.length < 1) {
      Logging.logSilly('Skipping message broadcast, no relevant policies found');
      return;
    }

    // Loop over each policy and asses if the event can be broadcast to that grouping. If a policy contains token specific data
    // then we need to check each token against the policy Query / Condition.
    Logging.logSilly(`Found ${policies.length} policies for event`);
    for (const policy of policies) {
      // A policy whose limit has run out grants nothing, as on REST
      if (isPolicyExpired(policy)) continue;

      // Narrow down the configs to ones that match on the schema & verbs of the activity.
      const configs = filterPolicyConfigs(policy, activity.schemaName, activity.verb, false, true);

      for (const config of configs) {
        const applicablePolicy: ApplicablePolicyConfig = {
          id: policy.id,
          name: policy.name,
          appId: policy._appId,
          env: policy.env,
          config,
        };

        Logging.logSilly(
          `_handleIncomingMessage::start policy:${policy.name}, verbs:${config.verbs}, schema: ${config.schema}`,
          `${activityMetadata.id}-${policy.id}`,
        );

        // We're going to check the parts of the policy to see if there is anything that's token specific.
        // If so then we'll do the policy checks based on the token.
        const tokenLevelAssesment = containsTokenLevelRef(applicablePolicy);
        if (
          tokenLevelAssesment.env ||
          tokenLevelAssesment.configEnv ||
          tokenLevelAssesment.condition ||
          tokenLevelAssesment.query
        ) {
          const tokenIds = await this._policyCache.getConnectedTokenIdsByPolicyId(applicablePolicy.id);

          // const tokenModel = Model.getCoreModel(TokenSchemaModel);
          // const userModel = Model.getCoreModel(UserSchemaModel);

          for await (const tokenId of tokenIds) {
            const env = CombineEnvGroups(applicablePolicy, await this.__constructTokenEnv(tokenId, activity.appId));
            const broadcastActivity = await this.__checkActivityAgainstApplicablePolicy(
              applicablePolicy,
              activity,
              entity,
              env,
              activityMetadata,
            );

            // If we have a broadcast activity then we need to send it to the token.
            if (broadcastActivity) {
              await this.__broadcastDataByToken(tokenId, broadcastActivity);
              Logging.logTimer(
                `_handleIncomingMessage::end-token`,
                activityMetadata.timer,
                Logging.Constants.LogLevel.SILLY,
                `${activityMetadata.id}-${applicablePolicy.id}`,
              );
            }
          }

          continue;
        }

        // Check the policy against the activity and broadcast to all policy tokens.
        const env = CombineEnvGroups(
          applicablePolicy,
          AccessControlEnv.generateRequestGlobalEnvs(null, activity.appId, null),
        );
        const broadcastActivity = await this.__checkActivityAgainstApplicablePolicy(
          applicablePolicy,
          activity,
          entity,
          env,
          activityMetadata,
        );

        if (broadcastActivity) {
          await this.__broadcastDataByPolicyId(applicablePolicy.id, broadcastActivity);
          Logging.logTimer(
            `_handleIncomingMessage::end`,
            activityMetadata.timer,
            Logging.Constants.LogLevel.SILLY,
            `${activityMetadata.id}-${applicablePolicy.id}`,
          );
        }
      }
    }
  }

  private async __constructTokenEnv(tokenId: string, appId: string): Promise<ACEnv> {
    const tokenModel = Model.getCoreModel(TokenSchemaModel);
    const userModel = Model.getCoreModel(UserSchemaModel);

    const token = (await tokenModel.findOne({ _id: tokenModel.createId(tokenId) })) as Token;
    if (!token) {
      Logging.logWarn(`Token not found: ${tokenId}`);
      return AccessControlEnv.generateRequestGlobalEnvs(null, appId, null);
    }

    let user: User | null = null;
    if (token._userId) {
      user = (await userModel.findOne({ _id: userModel.createId(token._userId) })) as User;
    }

    return AccessControlEnv.generateRequestGlobalEnvs(null, appId, user);
  }

  private async __checkActivityAgainstApplicablePolicy(
    applicablePolicy: ApplicablePolicyConfig,
    activity: RESTActivity,
    entity: Record<string, unknown> | null,
    env: ACPolicyEnvCombined,
    activityMetadata: ActivityMetadata,
  ): Promise<false | RESTActivity> {
    // As on REST, the config's condition must hold before its query is checked
    if (!(await AccessControlConditions.passesPolicyCondition(applicablePolicy, env))) {
      Logging.logTimer(
        `_handleIncomingMessage::end-condition-not-fulfilled`,
        activityMetadata.timer,
        Logging.Constants.LogLevel.SILLY,
        `${activityMetadata.id}-${applicablePolicy.id}`,
      );
      return false;
    }

    if (!entity && activity.verb === 'delete') {
      // A delete of every entity, which no policy limited, names none, so there's nothing to check the query against, and
      // the delete goes to every token the policy reaches. The caller sends it, once to each token.
      if (!(activity.params as Record<string, unknown>)?.id) {
        Logging.logTimer(
          `_handleIncomingMessage::end-no-entity-deletion`,
          activityMetadata.timer,
          Logging.Constants.LogLevel.SILLY,
          `${activityMetadata.id}-${applicablePolicy.id}`,
        );
        return activity;
      }

      // An entity delete comes with the entity as it was. Without it (it had already gone) there's no telling whether
      // the token could read it, so the token isn't told.
      Logging.logWarn('Unable to broadcast deletion, the deleted entity was not sent with the activity');
      return false;
    }

    if (!entity) {
      Logging.logWarn('Unable to broadcast entity, can not find entity');
      return false;
    }

    // As on REST, the query's access keys are dropped, and a query left empty reads every entity
    let query: Awaited<ReturnType<typeof AccessControlFilters.buildPolicyQuery>>;
    try {
      query = await AccessControlFilters.buildPolicyQuery(applicablePolicy.config.query, env);
    } catch (err: unknown) {
      // A query referring to an env value that isn't set reads nothing
      if (err instanceof UnresolvedEnvError) return false;
      throw err;
    }

    // ? How does this work if it's a core schema?
    const readsEntity = (q: NonNullable<typeof query>) =>
      Object.keys(q).length === 0 || AccessControlFilters.evaluateQueryAgainstEntity(q, entity);
    const broadcast = query ? readsEntity(query) : false;
    if (!broadcast && activity.verb === 'post') {
      Logging.logTimer(
        `_handleIncomingMessage::end-falsy-evaluateRoomQueryOperation-post entityId: ${entity?.id}`,
        activityMetadata.timer,
        Logging.Constants.LogLevel.SILLY,
        `${activityMetadata.id}-${applicablePolicy.id}`,
      );
      return false;
    }

    if (!broadcast) {
      // ! This is a bit werid, need to be more explicit on what the case is here.
      // activity.verb = 'delete';
      // this.__broadcastDataByPolicyId(applicablePolicy.id, activity);
      Logging.logTimer(
        `_handleIncomingMessage::end-falsy-evaluateRoomQueryOperation-delete`,
        activityMetadata.timer,
        Logging.Constants.LogLevel.SILLY,
        `${activityMetadata.id}-${applicablePolicy.id}`,
      );
      return false;
    }

    const broadcastActivity = JSON.parse(JSON.stringify(activity)) as RESTActivity;

    // The token only gets what the policy's projection lets it read, as on REST.
    const projectionKeys = AccessControlProjection.getProjectionKeys(applicablePolicy.config.projection);
    if (projectionKeys.length > 0) {
      const response = AccessControlProjection.projectActivityResponse(
        activity.verb,
        activity.response,
        projectionKeys,
      );
      if (response === null) {
        Logging.logTimer(
          `_handleIncomingMessage::end-nothing-projected`,
          activityMetadata.timer,
          Logging.Constants.LogLevel.SILLY,
          `${activityMetadata.id}-${applicablePolicy.id}`,
        );
        return false;
      }
      broadcastActivity.response = response;
    }

    return broadcastActivity;
  }

  private async __broadcastDataByPolicyId(policyId: string, activity: RESTActivity) {
    if (!this._policyCache) throw new Error('No Policy Cache');

    // Fetch tokens associated with the policy, batch them up in groups of 1000 and broadcast them.
    const tokenIds = await this._policyCache.getConnectedTokenIdsByPolicyId(policyId);

    Logging.logSilly(`Broadcasting activity for policy: ${policyId} to ${tokenIds.length} tokens`);

    // ? The activity event could actually be cached here and then the socket processes could fetch it
    // ? from the cach rather than being sent over pub/sub.

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

  // We may want to collect and batch these out to reduce the number of messages being sent.
  private async __broadcastDataByToken(tokenId: string, activity: RESTActivity) {
    this.__nrp?.emit(
      'spr:activity',
      JSON.stringify({
        tokens: [tokenId],
        activity,
      } satisfies DataShareSocketSharePayload),
    );
  }
}
