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
import Stream from 'node:stream';

import * as Helpers from '../../helpers/index.js';

import StandardModel from './standard.js';
import RemoteModel from './remote.js';

import { App } from '../core/app.js';
import AppDataSharingSchemaModel from '../core/app-data-sharing.js';
import { Schema } from '../../helpers/schema.js';
import { Services } from '../../bootstrap.js';
import { Datastore } from '../../datastore/index.js';
import ButtressAdapter from '../../datastore/adapters/buttress.js';
import { ChunkReceivedEvent } from '../../helpers/stream.js';
import { AdapterDocument, AdapterQuery, UpdatePathBody } from '../../types/datastore.js';
import Logging from '../../helpers/logging.js';

// How long to wait before trying a partner that couldn't be reached again, doubling each time up to the most
const REMOTE_RETRY_FIRST_MS = 1000;
const REMOTE_RETRY_MOST_MS = 60000;
// The least time between asking a partner which app it is, when a create can't be placed without knowing
const PARTNER_ASK_MS = 10000;

// A partner a read or write needs can't be reached
export const partnerUnavailable = () =>
  Helpers.Errors.unavailable('data_sharing_partner_unavailable', 'A data sharing partner is unavailable');

// Where each record a federated collection read came from: null for the app's own, or the id of the agreement it was
// read through. It's kept by the record object, so it's never part of what's returned.
const servedThrough = new WeakMap<object, string | null>();
const noteSource = (record: unknown, via: string | null) => {
  if (record && typeof record === 'object') servedThrough.set(record, via);
};

// Ids are compared as strings, whatever their case
const sameId = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

// What an add gave, as the entities it created
const createdEntities = async (result: unknown): Promise<unknown[]> => {
  if (result instanceof Stream.Readable) return Helpers.streamAll<unknown>(result);
  return Array.isArray(result) ? result : [result];
};

/**
 * A collection with `remotes`: the app's own records and each partner's, read together. Nothing goes by the sourceId a
 * partner's record names, as the partner gives that. A write to a record goes through the agreement the record was read
 * through, which the writing route finds with its own read (sourceOf). A create, with nothing to read first, goes to the
 * agreement whose partner app is the source it names, as pairing records it on the agreement or the partner says when
 * asked (_createTarget).
 * @class RemoteCombinedModel
 */
export default class RemoteCombinedModel extends StandardModel {
  override app: App;

  private _localModel: StandardModel | null;

  private _remoteModels: RemoteModel[];

  // The partner app each agreement the collection reads reaches, by agreement: as the agreement records it, or as the
  // partner says when asked. Null until known.
  private _partnerAppIds: Map<string, string | null>;
  // When each partner was last asked which app it is
  private _partnerAskedAt: Map<string, number>;

  // The agreements whose partner couldn't be reached, which are tried again until they are
  private _unreachable: Set<string>;
  private _retryTimeouts: Set<NodeJS.Timeout>;
  private _destroyed: boolean;

  constructor(schemaData: Schema, app: App | null, services: Services) {
    if (!app) throw new Error('App is required for RemoteCombinedModel');

    super(schemaData, app, services);

    this.app = app;

    // This is reference to a copy of the model in our local datastore.
    this._localModel = null;

    this._remoteModels = [];

    this._partnerAppIds = new Map();
    this._partnerAskedAt = new Map();
    this._unreachable = new Set();
    this._retryTimeouts = new Set();
    this._destroyed = false;
  }

  override async initAdapter(localDataStore?: Datastore | null, remoteDatastores?: Datastore[]) {
    if (!remoteDatastores) throw new Error('Remote datastores are required');

    if (localDataStore) {
      this._localModel = new StandardModel(this.schemaData, this.app, this.__services);

      // this._localModel.adapter = localDataStore.adapter.cloneAdapterConnection();
      await this._localModel.initAdapter(localDataStore);
      // await this._localModel.adapter.connect();
      // await this._localModel.adapter.setCollection(`${this.schemaData.name}`);
      // await this._localModel.adapter.updateSchema(this.schemaData);
    }

    for await (const remoteDatastore of remoteDatastores) {
      // The model manager sets the agreement and the partner app it records on each remote datastore
      this._partnerAppIds.set(String(remoteDatastore.dataSharingId), remoteDatastore.partnerAppId ?? null);
      await this._connectRemote(remoteDatastore, REMOTE_RETRY_FIRST_MS);
    }
  }

  /**
   * Adds a partner's collection to the sources. A partner that can't be reached is left out, so the app's own records
   * are still served, and tried again later on a new connection.
   * @param {Datastore} remoteDatastore
   * @param {number} retryIn - how long to wait before trying again, if it can't be reached
   */
  private async _connectRemote(remoteDatastore: Datastore, retryIn: number) {
    // The model manager sets the data sharing id of each remote datastore
    const dataSharingId = String(remoteDatastore.dataSharingId);

    // Each attempt gets a new connection, as a Buttress client that failed to connect never tries again
    const adapter = remoteDatastore.adapter.cloneAdapterConnection();
    let remoteSchema: Schema | undefined;
    try {
      // We want api call to return a stream directly without any tampering.
      adapter.returnPausedStream = true;

      await adapter.connect();
      await adapter.setCollection(`${this.schemaData.name}`);

      // TODO: this shouldn't be necessary when using a standard model.
      if (adapter instanceof ButtressAdapter) {
        const remoteSchemas = await adapter.getSchema(false, [this.schemaData.name]);
        remoteSchema = remoteSchemas?.pop();
      }
    } catch (err: unknown) {
      // A partner without the collection won't gain it by being asked again
      if (err instanceof Helpers.Errors.SchemaNotFound) throw err;

      this._unreachable.add(dataSharingId);
      Logging.logWarn(
        `Partner of data sharing ${dataSharingId} for ${this.schemaData.name} unreachable, trying again in ` +
          `${retryIn / 1000}s: ${Helpers.getThrownErrorMessage(err)}`,
      );
      this._retryRemote(remoteDatastore, retryIn);
      return;
    }

    if (this._destroyed) return;

    if (remoteSchema) {
      delete this.schemaData.remotes;
      this.schemaData = Helpers.mergeDeep(this.schemaData, remoteSchema);
    }

    const model = new RemoteModel(this.schemaData, this.app, dataSharingId, this.__services);
    model.adapter = adapter;
    this._remoteModels.push(model);
    if (this._unreachable.delete(dataSharingId)) {
      Logging.log(`Partner of data sharing ${dataSharingId} for ${this.schemaData.name} reached`);
    }

    if (!this._partnerAppIds.get(dataSharingId) && adapter instanceof ButtressAdapter) {
      await this._askPartnerAppId(dataSharingId, adapter);
    }
  }

  /**
   * Asks the partner of an agreement paired before pairing told each side the other's app which app it is, and records
   * it on the agreement. A partner that doesn't say (one from before it could) is asked again when a create needs it.
   * @param {string} dataSharingId
   * @param {ButtressAdapter} adapter - connected to the partner
   */
  private async _askPartnerAppId(dataSharingId: string, adapter: ButtressAdapter) {
    this._partnerAskedAt.set(dataSharingId, Date.now());
    try {
      const partnerAppId = await adapter.partnerAppId();
      if (!partnerAppId || this._destroyed) return;

      this._partnerAppIds.set(dataSharingId, partnerAppId);
      await this.__modelManager.getCoreModel(AppDataSharingSchemaModel).recordPartnerAppId(dataSharingId, partnerAppId);
      Logging.log(`Data sharing ${dataSharingId} reaches app ${partnerAppId}, as its partner says`);
    } catch (err: unknown) {
      Logging.logWarn(
        `Unable to learn which app data sharing ${dataSharingId} reaches, so a create naming it is refused until it's ` +
          `known: ${Helpers.getThrownErrorMessage(err)}`,
      );
    }
  }

  private _retryRemote(remoteDatastore: Datastore, delay: number) {
    const timeout = setTimeout(() => {
      this._retryTimeouts.delete(timeout);
      if (this._destroyed) return;

      this._connectRemote(remoteDatastore, Math.min(delay * 2, REMOTE_RETRY_MOST_MS)).catch((err: unknown) =>
        Logging.logError(
          `Unable to add partner of data sharing ${remoteDatastore.dataSharingId} for ${this.schemaData.name}: ` +
            Helpers.getThrownErrorMessage(err),
        ),
      );
    }, delay);
    // A partner that's still down doesn't keep the process running
    timeout.unref();
    this._retryTimeouts.add(timeout);
  }

  /**
   * Stops trying partners that couldn't be reached, and lets go of the partners' models.
   */
  override async destroy() {
    this._destroyed = true;
    this._retryTimeouts.forEach((timeout) => clearTimeout(timeout));
    this._retryTimeouts.clear();

    await Promise.all(this._remoteModels.map((model) => model.destroy()));
    await super.destroy();
  }

  override createId(id?: string) {
    // NOTE: This could be linked to the add problem, the Id will want to be created based
    // on the remote.
    return this.localModel.adapter.ID.new(id);
  }

  // Ids are checked and converted as the local datastore's are. The model has no adapter of its own.
  override isValidId(id: unknown) {
    return this.localModel.isValidId(id);
  }

  override convertStringToId<T>(id?: T) {
    return this.localModel.convertStringToId(id);
  }

  get localModel() {
    if (!this._localModel) throw new Error('Local model not set up yet');
    return this._localModel;
  }

  /**
   * Finds the partner app of an agreement that doesn't know it: the agreement may have it now (its owner set it, or
   * another process learnt it), or else its partner, if reachable, is asked, at most every PARTNER_ASK_MS.
   * @param {string} dataSharingId
   */
  private async _relearnPartnerAppId(dataSharingId: string) {
    try {
      const agreement = await this.__modelManager.getCoreModel(AppDataSharingSchemaModel).findById(dataSharingId);
      const recorded = agreement?.remoteApp?.appId;
      if (recorded) {
        this._partnerAppIds.set(dataSharingId, String(recorded));
        return;
      }
    } catch (err: unknown) {
      Logging.logWarn(`Unable to read data sharing ${dataSharingId}: ${Helpers.getThrownErrorMessage(err)}`);
    }

    const adapter = this._remoteModels.find((model) => model.dataSharingId.toString() === dataSharingId)?.adapter;
    const askedAt = this._partnerAskedAt.get(dataSharingId) ?? 0;
    if (adapter instanceof ButtressAdapter && Date.now() - askedAt >= PARTNER_ASK_MS) {
      await this._askPartnerAppId(dataSharingId, adapter);
    }
  }

  /**
   * Where a create that names `sourceId` as its source goes: the app's own collection when it names none or the app,
   * else the agreement whose partner app it is, as the agreements know their partners (never by what records say). A
   * source it can't place while an agreement doesn't know its partner's app has that found out first.
   * @param {unknown} sourceId
   * @return {Promise<{model: StandardModel, via: string|null}>} - the model to create in, and its agreement (null for
   * the app's own)
   */
  async _createTarget(sourceId?: unknown): Promise<{ model: StandardModel; via: string | null }> {
    if (sourceId === undefined || sourceId === null || sourceId === '' || sameId(sourceId, this.app.id)) {
      return { model: this.localModel, via: null };
    }

    const reachingOf = () => [...this._partnerAppIds].filter(([, appId]) => appId && sameId(appId, sourceId));
    const unknown = () => [...this._partnerAppIds].filter(([, appId]) => !appId).map(([via]) => via);
    if (reachingOf().length < 1 && unknown().length > 0) {
      await Promise.all(unknown().map((via) => this._relearnPartnerAppId(via)));
    }

    const reaching = reachingOf();
    if (reaching.length > 1) {
      throw Helpers.Errors.conflict('ambiguous_source', `More than one agreement reaches the app ${sourceId}`, {
        sourceId: String(sourceId),
      });
    }
    if (reaching.length === 1) {
      const [via] = reaching[0];
      return { model: this._remoteModelThrough(via), via };
    }

    // It may be the partner of an agreement whose partner app isn't known yet
    if (unknown().length > 0) {
      throw Helpers.Errors.conflict(
        'data_sharing_partner_unknown',
        "An agreement the collection reads doesn't know which app it reaches yet",
        { sourceId: String(sourceId) },
      );
    }
    throw Helpers.Errors.badRequest(
      'unknown_source',
      `The ${this.schemaData.name} collection reads no app ${sourceId}`,
      {
        sourceId: String(sourceId),
      },
    );
  }

  // The model for the agreement a record was read through (sourceOf), or the app's own for none
  _modelThrough(via?: string | null) {
    return via ? this._remoteModelThrough(via) : this.localModel;
  }

  /**
   * Where a record this collection read came from, as the read found it rather than as the record says.
   * @param {unknown} record - one this collection's find gave
   * @return {string|null|undefined} - the agreement it was read through, null for the app's own, or undefined for a
   * record the collection didn't read
   */
  sourceOf(record: unknown) {
    return record && typeof record === 'object' ? servedThrough.get(record) : undefined;
  }

  /**
   * @return {boolean} - whether a partner the collection reads couldn't be reached, so its records were left out
   */
  hasUnreachablePartner() {
    return this._unreachable.size > 0;
  }

  _remoteModelThrough(dataSharingId: string) {
    const model = this._remoteModels.find((remoteModel) => remoteModel.dataSharingId.toString() === dataSharingId);
    if (!model && this._unreachable.has(dataSharingId)) {
      throw partnerUnavailable();
    }
    if (!model) throw new Error('Unable to find remote model');

    return model;
  }

  /**
   * @param {string} dataSharingId
   * @return {boolean} - whether the collection reads a partner through the agreement
   */
  sharesThrough(dataSharingId: string) {
    return this._remoteModels.some((remoteModel) => remoteModel.dataSharingId.toString() === dataSharingId);
  }

  /**
   * Creates each entity where the sourceId it names is (_createTarget), every one of them found before any is created.
   * Entities for more than one source are created a source at a time and given back in the order they came; one source
   * failing leaves those created before it.
   * @param {object} body - an entity, or a list of them
   * @return {Promise}
   */
  override async add(body: AdapterDocument | AdapterDocument[]) {
    if (!Array.isArray(body)) return (await this._createTarget(body.sourceId)).model.add(body);

    // Each source named is placed once
    const sourceKey = (entity: AdapterDocument) => String(entity.sourceId ?? '').toLowerCase();
    const bySource = new Map<string, { model: StandardModel; via: string | null }>();
    for (const entity of body) {
      if (!bySource.has(sourceKey(entity))) bySource.set(sourceKey(entity), await this._createTarget(entity.sourceId));
    }
    const targets = body.map(
      (entity) => bySource.get(sourceKey(entity)) as { model: StandardModel; via: string | null },
    );
    const vias = [...new Set(targets.map((target) => target.via))];
    if (vias.length < 2) return (targets[0]?.model ?? this.localModel).add(body);

    const created: unknown[] = [];
    for (const via of vias) {
      const indexes = body.map((_entity, idx) => idx).filter((idx) => targets[idx].via === via);
      const result = await targets[indexes[0]].model.add(indexes.map((idx) => body[idx]));
      const entities = await createdEntities(result);
      indexes.forEach((idx, n) => (created[idx] = entities[n]));
    }
    return Stream.Readable.from(
      created.filter((entity) => entity !== undefined),
      { objectMode: true },
    );
  }

  /**
   * @param {object} details
   * @param {string} id
   * @param {string} via - the agreement the record was read through (sourceOf), none for the app's own
   * @return {Promise}
   */
  override async update(details: AdapterQuery, id: string, via?: string | null) {
    return this._modelThrough(via).updateById(id, details);
  }

  /**
   * @param {object} body
   * @param {string} id
   * @param {string} via - the agreement the record was read through (sourceOf), none for the app's own
   * @return {promise}
   */
  override async updateByPath(body: UpdatePathBody | UpdatePathBody[], id: string, via?: string | null) {
    return this._modelThrough(via).updateByPath(body, id);
  }

  /**
   * @param {string} id
   * @param {string} via - the agreement the record was read through (sourceOf), none for the app's own
   * @return {Boolean}
   */
  override async exists(id: string, via?: string | null) {
    return this._modelThrough(via).exists(id);
  }

  /**
   * @param {object} details
   * @param {string} sourceId
   * @return {Boolean}
   */
  override async isDuplicate(details: unknown) {
    return (await this._createTarget((details as { sourceId?: unknown } | null)?.sourceId)).model.isDuplicate(details);
    // // Make a call to each api, if any return true then return true.
    // const calls = this._remoteModels.map((remoteModel) => remoteModel.isDuplicate(details));
    // const results = await Promise.all(calls);
    // return results.some((result) => result);
  }

  /**
   * New entities are added to the local model, so that is where their ids would clash.
   * @param {string[]} ids
   * @return {Promise<string[]>}
   */
  override async findStoredIds(ids: string[]) {
    return this.localModel.findStoredIds(ids);
  }

  /**
   * @param {string} id
   * @param {string} via - the agreement the record was read through (sourceOf), none for the app's own
   * @return {Promise}
   */
  override async rm(id: string, via?: string | null) {
    return this._modelThrough(via).rm(id);
  }

  /**
   * Removes each record from where it was read. Every source is found before any record is removed.
   * @param {array} ids
   * @param {array} vias - the agreement each record was read through (sourceOf), none for the app's own
   * @return {Promise}
   */
  override async rmBulk(ids: string[], vias: (string | null | undefined)[] = []) {
    const bySource = new Map<string | null, string[]>();
    ids.forEach((id, idx) => {
      const via = vias[idx] ?? null;
      bySource.set(via, [...(bySource.get(via) ?? []), id]);
    });

    const removals = [...bySource].map(([via, idsOfSource]) => ({ model: this._modelThrough(via), ids: idsOfSource }));
    for (const removal of removals) {
      await removal.model.rmBulk(removal.ids);
    }
  }

  /**
   * Removes the app's own records and, through each agreement, the partner's that its policy lets the app remove. With a
   * partner that can't be reached, nothing is removed.
   * @param {array} query
   * @return {Promise}
   */
  override async rmAll(query?: AdapterQuery) {
    if (this._unreachable.size > 0) throw partnerUnavailable();

    const remotes = [...this._remoteModels];
    await this.localModel.rmAll(query);
    for (const remote of remotes) {
      await remote.rmAll(query);
    }
  }

  /**
   * A record by the source it names, as a create's activity does, through the agreement whose partner app that is. One
   * a write went through, or a partner relayed, is found through its agreement with findSharedById.
   * @param {string} id
   * @param {string} sourceId
   * @return {Promise}
   */
  override async findById(id: string, sourceId?: string | null) {
    return (await this._createTarget(sourceId)).model.findById(id);
  }

  /**
   * A record of the partner an agreement reads, as a change the partner relayed names it
   * @param {string} id
   * @param {string} dataSharingId
   * @return {Promise}
   */
  async findSharedById(id: string, dataSharingId: string) {
    return this._remoteModelThrough(dataSharingId).findById(id);
  }

  /**
   * @param {Object} query - mongoDB query
   * @param {Object} excludes - mongoDB query excludes
   * @param {Int} limit - should return a stream
   * @param {Int} skip - should return a stream
   * @param {Object} sort - mongoDB sort object
   * @param {Boolean} project - mongoDB project ids
   * @return {Promise} - resolves to an array of docs
   */
  override async find(
    query: AdapterQuery,
    excludes: AdapterQuery | null = {},
    limit = 0,
    skip = 0,
    sort: Record<string, unknown> | null = {},
    project: Record<string, unknown> | null | false = null,
  ) {
    const sortMap = new Map<string, number>(
      Object.entries(sort as Record<string, unknown>).map(([key, value]) => [key, Number(value)]),
    );
    if (sortMap.size < 1) sortMap.set('id', 1);

    // Make a call out to each of the remotes, and merge the streams into on single stream.
    const sources: Stream.Readable[] = [];

    // A page of the merged list is within the first skip + limit of each source's, and is skipped to once merged
    const sourceLimit = limit ? skip + limit : 0;

    sources.push(await this.localModel.find(query, excludes, sourceLimit, 0, sort, project));

    // The partners reached when the read began, so one reached during it doesn't move the sources along
    const remotes = [...this._remoteModels];
    for await (const remote of remotes) {
      sources.push(await remote.find(query, excludes, sourceLimit, 0, sort, project));
    }

    const combinedStream = new Helpers.Stream.SortedStreams<AdapterDocument>(
      sources,
      (a, b) => Helpers.compareByProps(sortMap, a, b),
      limit,
      skip,
    );

    // The first source is the local model, then each partner. Where each record came from is noted as it arrives,
    // before anything can read it, so a write to it goes back where it was read (sourceOf).
    combinedStream.on('chunkReceived', ({ chunk, sourceIdx }: ChunkReceivedEvent<AdapterDocument>) =>
      noteSource(chunk, sourceIdx > 0 ? remotes[sourceIdx - 1].dataSharingId.toString() : null),
    );

    return combinedStream;
  }

  /**
   * @return {Promise}
   */
  override async findAll() {
    // Make a call out to each of the remotes, and merge the streams into on single stream.
    const sources: Stream.Readable[] = [];

    const remotes = [...this._remoteModels];
    for await (const remote of remotes) {
      sources.push(await remote.findAll());
    }

    const combinedStream = new Helpers.Stream.SortedStreams<AdapterDocument>(sources);

    combinedStream.on('chunkReceived', ({ chunk, sourceIdx }: ChunkReceivedEvent<AdapterDocument>) =>
      noteSource(chunk, remotes[sourceIdx].dataSharingId.toString()),
    );

    return combinedStream;
  }

  /**
   * @param {Array} ids - mongoDB query
   * @return {Promise}
   * @deprecated - use find
   */
  findAllById(_ids: string[]) {
    throw new Error('Not yet implemented');
    // return this.remote.findAllById(ids);
  }

  /**
   * @param {Object} query - mongoDB query
   * @return {Promise}
   */
  override async count(query?: AdapterQuery) {
    // Make a call out to the local datastore and each of the remotes, and sum the results.
    const sourceReqs: (number | Promise<number>)[] = [];

    sourceReqs.push(await this.localModel.count(query));

    for await (const remote of this._remoteModels) {
      sourceReqs.push(await remote.count(query));
    }

    return (await Promise.all(sourceReqs)).reduce((acc, val) => acc + val, 0);
  }

  /**
   * @return {Promise}
   */
  override async drop() {
    return await this.localModel.drop();
  }
}
