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
import { AdapterDocument, AdapterIdInput, AdapterQuery, UpdatePathBody } from '../../types/datastore.js';

/**
 * @class RemoteCombinedModel
 */
export default class RemoteCombinedModel extends StandardModel {
  override app: App;

  private _localModel: StandardModel | null;

  private _remoteModels: RemoteModel[];

  _sdsRouting: SourceDataSharingRouting;

  constructor(schemaData: Schema, app: App | null, services: Services) {
    if (!app) throw new Error('App is required for RemoteCombinedModel');

    super(schemaData, app, services);

    this.app = app;

    // This is reference to a copy of the model in our local datastore.
    this._localModel = null;

    this._remoteModels = [];

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
      // The model manager sets the data sharing id of each remote datastore
      const model = new RemoteModel(
        this.schemaData,
        this.app,
        remoteDatastore.dataSharingId as string,
        this.__services,
      );

      // TODO: handle a model which is unable to connect.
      const adapter = remoteDatastore.adapter.cloneAdapterConnection();
      model.adapter = adapter;

      // We want api call to return a stream directly without any tampering.
      model.adapter.returnPausedStream = true;

      await model.adapter.connect();
      await model.adapter.setCollection(`${this.schemaData.name}`);

      // TODO: this shouldn't be necessary when using a standard model.
      if (adapter instanceof ButtressAdapter) {
        const remoteSchemas = await adapter.getSchema(false, [this.schemaData.name]);
        if (remoteSchemas && remoteSchemas.length > 0) {
          delete this.schemaData.remotes;
          this.schemaData = Helpers.mergeDeep(this.schemaData, remoteSchemas.pop() as Schema);
        }
      }

      this._remoteModels.push(model);
    }
  }

  override createId(id?: AdapterIdInput) {
    // NOTE: This could be linked to the add problem, the Id will want to be created based
    // on the remote.
    return this.localModel.adapter.ID.new(id);
  }

  get localModel() {
    if (!this._localModel) throw new Error('Local model not set up yet');
    return this._localModel;
  }

  async _getTargetModel(sourceId?: string | null) {
    if (!sourceId || sourceId === this.app.id.toString()) return this.localModel;

    const dataSharingId = await this._sdsRouting.get(this.app.id.toString(), sourceId);
    if (dataSharingId) {
      const model = this._remoteModels.find((remoteModel) => remoteModel.dataSharingId.toString() === dataSharingId);
      if (!model) {
        throw new Error('Unable to find remote model');
      }

      return model;
    }

    throw new Error(`Unable to resolve target model for sourceId: ${sourceId}`);
  }

  /**
   * @param {object} body
   * @return {Promise}
   */
  override async add(body: AdapterDocument | AdapterDocument[]) {
    return (await this._getTargetModel((body as { sourceId?: string }).sourceId)).add(body);
  }

  override async update(details: AdapterQuery, id: AdapterIdInput, sourceId?: string) {
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
  override async exists(id: AdapterIdInput, sourceId?: string | null) {
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
   * @param {object} entity
   * @param {string} sourceId
   * @return {Promise}
   */
  override async rm(entity: { id: AdapterIdInput }, sourceId?: string) {
    if (!sourceId) throw new Error('SourceId is required for rm');

    return (await this._getTargetModel(sourceId)).rm(entity.id);
  }

  /**
   * @param {array} ids
   * @return {Promise}
   */
  override async rmBulk(ids: AdapterIdInput[]) {
    return this.localModel.rmBulk(ids);
  }

  /**
   * @param {array} query
   * @return {Promise}
   */
  override async rmAll(query?: AdapterQuery) {
    return this.localModel.rmAll(query);
  }

  /**
   * @param {string} id
   * @param {string} sourceId
   * @return {Promise}
   */
  override async findById(id: AdapterIdInput, sourceId?: string) {
    if (!sourceId) throw new Error('SourceId is required for findById');

    return (await this._getTargetModel(sourceId)).findById(id);
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

    sources.push(await this.localModel.find(query, excludes, limit, skip, sort, project));

    for await (const remote of this._remoteModels) {
      sources.push(await remote.find(query, excludes, limit, skip, sort, project));
    }

    const combinedStream = new Helpers.Stream.SortedStreams<AdapterDocument>(
      sources,
      (a, b) => Helpers.compareByProps(sortMap, a, b),
      limit,
    );

    // When a chunk is sent, we'll inform the routing service of the sourceId.
    // We're always expecting the first source to be the local model.
    combinedStream.on('chunkSent', (data: ChunkSentEvent<AdapterDocument>) => {
      return data.sourceIdx > 0
        ? this._sdsRouting.inform(
            this.app.id.toString(),
            data.chunk.sourceId as string,
            this._remoteModels[data.sourceIdx - 1].dataSharingId.toString(),
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

    for await (const remote of this._remoteModels) {
      sources.push(await remote.findAll());
    }

    const combinedStream = new Helpers.Stream.SortedStreams<AdapterDocument>(sources);

    // When a chunk is sent, we'll inform the routing service of the sourceId.
    combinedStream.on('chunkSent', (data: ChunkSentEvent<AdapterDocument>) =>
      this._sdsRouting.inform(
        this.app.id.toString(),
        data.chunk.sourceId as string,
        this._remoteModels[data.sourceIdx].dataSharingId.toString(),
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
