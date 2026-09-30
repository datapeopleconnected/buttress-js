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

import { SourceDataSharingRouting } from '../../services/source-ds-routing.js';
import { App } from '../core/app.js';
import { Schema } from '../../helpers/schema.js';
import { Services } from '../../bootstrap.js';
import { Datastore } from '../../datastore/index.js';
import ButtressAdapter from '../../datastore/adapters/buttress.js';
import { ChunkSentEvent } from '../../helpers/stream.js';
import { AdapterDocument, AdapterQuery, UpdatePathBody } from '../../types/datastore.js';
import Logging from '../../helpers/logging.js';

// How long to wait before trying a partner that couldn't be reached again, doubling each time up to the most
const REMOTE_RETRY_FIRST_MS = 1000;
const REMOTE_RETRY_MOST_MS = 60000;

/**
 * @class RemoteCombinedModel
 */
export default class RemoteCombinedModel extends StandardModel {
  override app: App;

  private _localModel: StandardModel | null;

  private _remoteModels: RemoteModel[];

  _sdsRouting: SourceDataSharingRouting;

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

    this._unreachable = new Set();
    this._retryTimeouts = new Set();
    this._destroyed = false;

    this._sdsRouting = services.get('sdsRouting') as SourceDataSharingRouting;
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

  async _getTargetModel(sourceId?: string | null) {
    if (!sourceId || sourceId === this.app.id.toString()) return this.localModel;

    const dataSharingId = await this._sdsRouting.get(this.app.id.toString(), sourceId);
    if (dataSharingId) return this._remoteModelThrough(dataSharingId);

    throw new Error(`Unable to resolve target model for sourceId: ${sourceId}`);
  }

  _remoteModelThrough(dataSharingId: string) {
    const model = this._remoteModels.find((remoteModel) => remoteModel.dataSharingId.toString() === dataSharingId);
    if (!model && this._unreachable.has(dataSharingId)) {
      throw new Helpers.Errors.RequestError(503, 'data_sharing_partner_unavailable');
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
   * @param {object} body
   * @return {Promise}
   */
  override async add(body: AdapterDocument | AdapterDocument[]) {
    return (await this._getTargetModel((body as { sourceId?: string }).sourceId)).add(body);
  }

  override async update(details: AdapterQuery, id: string, sourceId?: string) {
    if (!sourceId) throw new Error('SourceId is required for update');

    return (await this._getTargetModel(sourceId)).updateById(id, details);
  }

  /**
   * @param {object} body
   * @param {string} id
   * @param {string} sourceId
   * @return {promise}
   */
  override async updateByPath(body: UpdatePathBody | UpdatePathBody[], id: string, sourceId?: string | null) {
    return (await this._getTargetModel(sourceId)).updateByPath(body, id);
  }

  /**
   * @param {string} id
   * @param {string} sourceId
   * @return {Boolean}
   */
  override async exists(id: string, sourceId?: string | null) {
    return (await this._getTargetModel(sourceId)).exists(id);
  }

  /**
   * @param {object} details
   * @param {string} sourceId
   * @return {Boolean}
   */
  override async isDuplicate(details: unknown, sourceId?: string) {
    return (await this._getTargetModel(sourceId)).isDuplicate(details);
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
   * @param {string} sourceId - the source of a partner's record, none for the app's own
   * @return {Promise}
   */
  override async rm(id: string, sourceId?: string | null) {
    return (await this._getTargetModel(sourceId)).rm(id);
  }

  /**
   * Removes each record from its source. Every source is found before any record is removed.
   * @param {array} ids
   * @param {array} sourceIds - the source of each record, none for the app's own
   * @return {Promise}
   */
  override async rmBulk(ids: string[], sourceIds: (string | null | undefined)[] = []) {
    const bySource = new Map<string | null, string[]>();
    ids.forEach((id, idx) => {
      const sourceId = sourceIds[idx] ?? null;
      bySource.set(sourceId, [...(bySource.get(sourceId) ?? []), id]);
    });

    const removals = await Promise.all(
      [...bySource].map(async ([sourceId, idsOfSource]) => ({
        model: await this._getTargetModel(sourceId),
        ids: idsOfSource,
      })),
    );
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
    if (this._unreachable.size > 0) throw new Helpers.Errors.RequestError(503, 'data_sharing_partner_unavailable');

    const remotes = [...this._remoteModels];
    await this.localModel.rmAll(query);
    for (const remote of remotes) {
      await remote.rmAll(query);
    }
  }

  /**
   * @param {string} id
   * @param {string} sourceId
   * @return {Promise}
   */
  override async findById(id: string, sourceId?: string | null) {
    return (await this._getTargetModel(sourceId)).findById(id);
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

    // When a chunk is sent, we'll inform the routing service of the sourceId.
    // We're always expecting the first source to be the local model.
    combinedStream.on('chunkSent', (data: ChunkSentEvent<AdapterDocument>) => {
      return data.sourceIdx > 0
        ? this._sdsRouting.inform(
            this.app.id.toString(),
            data.chunk.sourceId as string,
            remotes[data.sourceIdx - 1].dataSharingId.toString(),
          )
        : null;
    });

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

    // When a chunk is sent, we'll inform the routing service of the sourceId.
    combinedStream.on('chunkSent', (data: ChunkSentEvent<AdapterDocument>) =>
      this._sdsRouting.inform(
        this.app.id.toString(),
        data.chunk.sourceId as string,
        remotes[data.sourceIdx].dataSharingId.toString(),
      ),
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
