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
import createConfig from '@dpc/node-env-obj';

import { ObjectId } from 'bson';
import { createClient, RedisClient } from 'redis';

import Bootstrap from './bootstrap.js';

const Config = createConfig() as unknown as Config;

import Model from './model/index.js';
import * as Helpers from './helpers/index.js';
import Logging from './helpers/logging.js';

import { ApplicablePolicyConfig } from './access-control/index.js';
import { CombineEnvGroups, containsTokenLevelRef, filterPolicyConfigs } from './access-control/helpers.js';
import AccessControlEnv, { ACEnv, ACPolicyEnvCombined } from './access-control/env.js';
import AccessControlFilters from './access-control/filter.js';

import Datastore from './datastore/index.js';
import { RESTActivity } from './types/bjs-nrp-objects.js';
import { Policy, PolicyEnv } from './model/core/policy.js';
import TokenSchemaModel, { Token } from './model/core/token.js';

import { PolicyCache } from './services/policy-cache.js';
import UserSchemaModel, { User } from './model/core/user.js';
import projection from './access-control/projection.js';

// Abstract policy cache

interface ActivityMetadata {
	id: string;
	timer: Helpers.Timer;
}

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
 * - SDR Broadcasts (Redis Pub) activity along with the list of tokens which need to be notified. Socket processes will just discard activity if none of the tokens match.
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

	private _redisClient?: RedisClient;

	private _primaryDatastore: any;

	private _policyCache?: PolicyCache;

	private _broadcastTokenBatchSize = 1000;

	private _shutdown = false;

	constructor() {
		super();

		this._primaryDatastore = Datastore.createInstance(Config.datastore, true);

		this.isPrimary = Config.sio.app === 'primary';
	}

	async init() {
		await super.init();

		Logging.logSilly('BootstrapSPR:init');

		await this._primaryDatastore.connect();

		this._redisClient = createClient({
			host: Config.redis.host,
			port: parseInt(Config.redis.port, 10) || 6379,
			prefix: Config.redis.scope,
		});

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

	async clean() {
		this._shutdown = true;

		await super.clean();

		Logging.logSilly('BootstrapSPR:clean');

		if (this._redisClient) {
			this._redisClient.quit();
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

	async __initMain() {
		if (this.isPrimary) {
			Logging.logVerbose(`Primary Main SPR`);
			await this.__registerNRPPrimaryListeners();

			if (!this._policyCache) throw new Error('No Policy Cache');
			await this._policyCache.initProcessing();
		}

		await this.__spawnWorkers();
	}

	async __initWorker() {}

	async __registerNRPPrimaryListeners() {
		Logging.logDebug(`Primary Main`);

		if (!this.__nrp) throw new Error('No NRP instance');

		// TODO: Event should come from the SPR
		this.__nrp.on('rest:activity', (data) => this._handleIncomingMessage(JSON.parse(data)));
		this.__nrp.on('worker:socket:connection', (tokenId) => this._socketConnection(tokenId));
		this.__nrp.on('worker:socket:disconnect', (tokenId) => this._socketDisconnection(tokenId));
	}

	// Use redis to store and cache a list of connected tokens and their associated policies
	async storePolicy(policy: Policy) {
		if (!this._redisClient) throw new Error('No Redis client');

		try {
			await this._redisClient.hset('policies', `policy:${policy.id}`, JSON.stringify(policy));
		} catch (error) {
			Logging.logError(error);
			throw error; // Re-throw the error to be handled by the caller
		}

		return policy.id;
	}

	async linkTokenToPolicy(token: string, policyId: string) {
		if (!this._redisClient) throw new Error('No Redis client');

		try {
			await this._redisClient.sadd(`token:${token}`, policyId);
			await this._redisClient.sadd(`policy:${policyId}:tokens`, token);
		} catch (error) {
			Logging.logError(error);
			throw error;
		}
	}

	// Token is connected
	// - Check to see if the token is already in the list of connected tokens, if it is early out
	// - Otherwise we need to fetch the relevant policies from MongoDB and store them in redis for quick access
	// - Any time a policy is changed in MongoDB, we need to update the redis cache
	private async _socketConnection(tokenId: string) {
		if (!this._redisClient) throw new Error('No Redis client');
		if (!this._policyCache) throw new Error('No Policy Cache');

		const connected = await new Promise((resolve, reject) => this._redisClient ? this._redisClient.zscore('connected-tokens', tokenId, (err, res) => {
			if (err) return reject(err);
			resolve(res !== null);
		}) : reject(new Error('No Redis client')));

		// If we're already connected no need to do anything further
		if (connected) {
			Logging.logDebug(`Token already connected: ${tokenId}`);
			return;
		}

		// Look up the token by ID
		const token = await (Model.getModel('Token') as TokenSchemaModel).findOne({ _id: new ObjectId(tokenId) }) as Token;
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

	private async _handleIncomingMessage(activity: RESTActivity) {
		if (!this._policyCache) throw new Error('No Policy Cache');

		// Create a container that will be used to track the message event within the SPR and a timer.
		const activityMetadata: ActivityMetadata = {
			id: Datastore.getInstance('core').ID.new(),
			timer: new Helpers.Timer(),
		};

		const isCoreSchema = false;

		let entity = null;
		const entityId = (activity.params.id) ? activity.params.id : activity.response.id;

		if (entityId) {
			const appModel = Model.getAppModel(activity.appId, activity.schemaName);
			if (!appModel) {
				Logging.logWarn(`Unable to broadcast entity, can not find ${activity.schemaName} for ${activity.appId} in the database`);
				return;
			}

			entity = await appModel.findById(entityId);
			// TODO: Entity needs to be flatterned for processing.
		}

		if (activity.isSuper) {
			// TODO: Super tokens could be cached in redis, app tokens could be also be cached.
			const tokenModel = (Model.getModel('Token') as TokenSchemaModel);
			const systemTokens = await tokenModel.find({ type: 'system' });

			for await (const systemToken of systemTokens) {
				await this.__broadcastDataByToken(systemToken.id, activity);
				Logging.logTimer(`_handleIncomingMessage::systemToken ${systemToken.id}`, activityMetadata.timer,
					Logging.Constants.LogLevel.SILLY, `${activityMetadata.id}`);
			}

			return;
		}

		if (activity.broadcast === false) {
			Logging.logSilly('Skipping message broadcast, broadcast is disabled');
			return;
		}

		// Get all policies from the cache that are relevant to the event.
		const policies = await this._policyCache.getPoliciesByEvent(activity);
		if (policies.length < 0) {
			Logging.logSilly('Skipping message broadcast, no relevant policies found');
			return;
		}

		// Loop over each policy and asses if the event can be broadcast to that grouping. If a policy contains token specific data
		// then we need to check each token against the policy Query / Condition.
		Logging.logSilly(`Found ${policies.length} policies for event`);
		for (const policy of policies) {
			// Narrow down the configs to ones that match on the schema & verbs of the activity.
			const configs = filterPolicyConfigs(policy, activity.schemaName, activity.verb, isCoreSchema, true);

			for (const config of configs) {
				const applicablePolicy: ApplicablePolicyConfig = {
					id: policy.id,
					name: policy.name,
					appId: 'test',
					env: policy.env,
					config,
				};

				Logging.logSilly(`_handleIncomingMessage::start policy:${policy.name}, verbs:${config.verbs}, schema: ${config.schema}`, `${activityMetadata.id}-${policy.id}`);

				// We're going to check the parts of the policy to see if there is anything that's token specific.
				// If so then we'll do the policy checks based on the token.
				const tokenLevelAssesment = containsTokenLevelRef(applicablePolicy);
				if (tokenLevelAssesment.env || tokenLevelAssesment.configEnv || tokenLevelAssesment.condition || tokenLevelAssesment.query) {
					const tokenIds = await this._policyCache.getConnectedTokenIdsByPolicyId(applicablePolicy.id);

					// const tokenModel = (Model.getModel('Token') as TokenSchemaModel);
					// const userModel = (Model.getModel('User') as UserSchemaModel);

					for await (const tokenId of tokenIds) {
						const env = CombineEnvGroups(applicablePolicy, await this.__constructTokenEnv(tokenId, activity.appId));
						const broadcastActivity = await this.__checkActivityAgainstApplicablePolicy(applicablePolicy, activity, entity, env, activityMetadata);

						// If we have a broadcast activity then we need to send it to the token.
						if (broadcastActivity) {
							await this.__broadcastDataByToken(tokenId, broadcastActivity);
							Logging.logTimer(`_handleIncomingMessage::end-token`, activityMetadata.timer,
								Logging.Constants.LogLevel.SILLY, `${activityMetadata.id}-${applicablePolicy.id}`);
						}
					}

					continue;
				}

				// Check the policy against the activity and broadcast to all policy tokens.
				const env = CombineEnvGroups(applicablePolicy, AccessControlEnv.generateRequestGlobalEnvs(null, activity.appId, null));
				const broadcastActivity = await this.__checkActivityAgainstApplicablePolicy(applicablePolicy, activity, entity, env, activityMetadata);

				if (broadcastActivity) {
					await this.__broadcastDataByPolicyId(applicablePolicy.id, broadcastActivity);
					Logging.logTimer(`_handleIncomingMessage::end`, activityMetadata.timer,
						Logging.Constants.LogLevel.SILLY, `${activityMetadata.id}-${applicablePolicy.id}`);
				}
			}
		}
	}

	private async __constructTokenEnv(tokenId: string, appId: string): Promise<ACEnv> {
		const tokenModel = (Model.getModel('Token') as TokenSchemaModel);
		const userModel = (Model.getModel('User') as UserSchemaModel);

		const token = await tokenModel.findOne({ _id: tokenModel.createId(tokenId) }) as Token;
		if (!token) {
			Logging.logWarn(`Token not found: ${tokenId}`);
			return AccessControlEnv.generateRequestGlobalEnvs(null, appId, null);
		}

		let user: User | null = null;
		if (token._userId) {
			user = await userModel.findOne({ _id: userModel.createId(token._userId) }) as User;
		}

		return AccessControlEnv.generateRequestGlobalEnvs(null, appId, user);
	}

	private async __checkActivityAgainstApplicablePolicy(applicablePolicy: ApplicablePolicyConfig,
		activity: RESTActivity, entity: any, env: ACPolicyEnvCombined, activityMetadata: ActivityMetadata): Promise<false | RESTActivity> {

		if (!entity && activity.verb === 'delete') {
			this.__broadcastDataByPolicyId(applicablePolicy.id, activity);
			Logging.logTimer(`_handleIncomingMessage::end-no-entity-deletion`, activityMetadata.timer,
				Logging.Constants.LogLevel.SILLY, `${activityMetadata.id}-${applicablePolicy.id}`);
			return false;
		}

		if (!entity) {
			Logging.logWarn('Unable to broadcast entity, can not find entity');
			return false;
		}

		const query = await AccessControlFilters.buildPolicyQuery(applicablePolicy.config.query, env, false);

		// ? How does this work if it's a core schema?
		const broadcast = (query) ? AccessControlFilters.evaluateQueryAgainstEntity(query, entity) : false;
		if (!broadcast && activity.verb === 'post') {
			Logging.logTimer(`_handleIncomingMessage::end-falsy-evaluateRoomQueryOperation-post entityId: ${entity?.id}`, activityMetadata.timer,
				Logging.Constants.LogLevel.SILLY, `${activityMetadata.id}-${applicablePolicy.id}`);
			return false;
		}

		if (!broadcast) {
			// ! This is a bit werid, need to be more explicit on what the case is here.
			// activity.verb = 'delete';
			// this.__broadcastDataByPolicyId(applicablePolicy.id, activity);
			Logging.logTimer(`_handleIncomingMessage::end-falsy-evaluateRoomQueryOperation-delete`, activityMetadata.timer,
				Logging.Constants.LogLevel.SILLY, `${activityMetadata.id}-${applicablePolicy.id}`);
			return false;
		}

		const broadcastActivity = JSON.parse(JSON.stringify(activity)) as RESTActivity;

		// TODO: Is this a flatterned object at this point? because this is only taking into account keys are the the root.
		const roomProjectionKeys = (applicablePolicy.config.projection) ? applicablePolicy.config.projection : [];
		if (roomProjectionKeys.length > 0) {
			const projectedData = roomProjectionKeys.reduce((obj, key) => {
				if (activity.response[key]) {
					obj[key] = activity.response[key];
				}

				return obj;
			}, {});

			if (Object.keys(projectedData).length > 0) {
				broadcastActivity.response = projectedData;
			}
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
			this.__nrp?.emit('spr:activity', JSON.stringify({
				tokens: tokenIds.slice(i, i + this._broadcastTokenBatchSize),
				activity
			}));
		}
	}

	// We may want to collect and batch these out to reduce the number of messages being sent.
	private async __broadcastDataByToken(tokenId: string, activity: RESTActivity) {
		this.__nrp?.emit('spr:activity', JSON.stringify({
			tokens: [tokenId],
			activity
		}));
	}
}