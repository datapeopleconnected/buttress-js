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
import ButtressExport, { Errors as BAPIErrors } from '@buttress/api';
// TODO: Look into why the export from @buttress/api is not working as expected.
const { default: ButtressAPI } = ButtressExport;

import Errors from '../../helpers/errors.js';
import * as Helpers from '../../helpers/index.js';
import { parseJsonArrayStream } from '../../helpers/stream.js';
import Logging from '../../helpers/logging.js';

import AbstractAdapter from '../abstract-adapter.js';
import ObjectIdHelper, { isObjectId } from './object-id.js';

import { AdapterQuery } from '../../types/datastore.js';
import { Schema } from '../../types/schema.js';
import { dataSharingDestinationProblem } from '../../helpers/egress.js';

// The collection calls made against a remote Buttress. @buttress/api types these results as `any`, and
// its declarations don't allow some of the arguments used here (an object `sort`, `count` without a sort).
interface ButtressCollection {
  get(id: unknown): Promise<unknown>;
  save(details: unknown, options?: { stream?: boolean }): Promise<unknown>;
  bulkSave(details: unknown[], options?: { stream?: boolean }): Promise<unknown>;
  update(id: string, details: unknown): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  bulkRemove(ids: unknown): Promise<unknown>;
  removeAll(): Promise<unknown>;
  getAll(): Promise<unknown>;
  bulkGet(ids: unknown): Promise<unknown>;
  search(
    query: unknown,
    limit?: number,
    skip?: number,
    sort?: unknown,
    options?: { project?: unknown; stream?: boolean },
  ): Promise<unknown>;
  count(query: unknown): Promise<unknown>;
}

export default class Buttress extends AbstractAdapter<URL> {
  init: boolean;
  initPendingResolve: ((value?: unknown) => void)[];
  collectionName?: string;

  protected override __connection: typeof ButtressAPI | null;

  // Set by setCollection, which is called before any of the collection methods
  declare collection: ButtressCollection;

  constructor(uri: URL, options?: URLSearchParams, connection: typeof ButtressAPI | null = null) {
    super(uri, options, connection);

    this.__connection = ButtressAPI.new();

    this.init = false;
    this.initPendingResolve = [];
  }

  override async connect() {
    if (this.init) return this.__connection;

    const protocol = this.uri.protocol === 'butts:' ? 'https' : 'http';

    const token = this.uri.searchParams.get('token');
    if (!token) throw new Error('Missing token in Buttress connection string');

    const buttressUrl = `${protocol}://${this.uri.host}`;
    const destination = await dataSharingDestinationProblem([buttressUrl]);
    if (destination) throw new Error(`data_sharing_${destination}`);
    const apiPath = this.uri.pathname.replace(/^\/+/, '');
    await this._apiCall('connect', () => {
      if (!this.__connection) throw new Error('Buttress connection not initialized');

      return this.__connection.init({
        buttressUrl,
        appToken: token,
        apiPath,
        version: 1,
        // A partner that can't be reached is left out and tried again later by the data sharing model, rather than
        // holding up boot, or a request, through the API's retries and their backoff
        maxRetries: 0,
      });
    });
    Logging.logDebug(`connected to: ${this.uri.host}/${apiPath}`);

    // this.collection = this.buttress.getCollection(collection);
    // this.setCollection(this.uri.pathname.replace(/\//g, ''));
    this.init = true;
    this.initPendingResolve.forEach((r) => r());
  }

  override cloneAdapterConnection() {
    return new Buttress(this.uri, this.options, this.__connection);
  }

  override async close() {
    // TODO: Handle closing down socket connections??
    this.__connection = null;
    this.init = false;
    this.initPendingResolve = [];
  }

  override async setCollection(collectionName: string) {
    try {
      this.collectionName = collectionName;
      this.collection = await this._apiCall('setCollection', () => {
        if (!this.__connection) throw new Error('Buttress connection not initialized');
        return Promise.resolve(this.__connection.getCollection(collectionName) as unknown as ButtressCollection);
      });
    } catch (err: unknown) {
      if (err instanceof BAPIErrors.SchemaNotFound) throw new Errors.SchemaNotFound(err.message);
      else throw err;
    }
  }

  async getSchema(rawSchema = false, only: string[] = []) {
    return this._resolvedApiCall<Schema[]>('getSchema', () => {
      if (!this.__connection) throw new Error('Buttress connection not initialized');
      if (!this.__connection.App) throw new Error('Buttress App not initialized');

      return this.__connection.App.getSchema(rawSchema, {
        params: {
          only: only.join(','),
        },
      });
    });
  }

  /**
   * Activates the agreement on the partner, telling it which app it's paired with.
   * @param {string} registrationToken - the token the partner gave for the agreement
   * @param {string} newToken - the token the partner is to use with this app from now on
   * @param {string} appId - this app's id
   * @return {Promise} - the partner's answer: its new token and, from a Buttress that gives it, its app's id
   */
  async activateDataSharing(registrationToken: string, newToken: string, appId?: string): Promise<unknown> {
    await this.resolveAfterInit();
    if (!this.__connection) throw new Error('Buttress connection not initialized');
    if (!this.__connection.AppDataSharing) throw new Error('Buttress AppDataSharing not initialized');
    return await this.__connection.AppDataSharing.activate(
      registrationToken,
      newToken,
      appId ? { params: { appId } } : {},
    );
  }

  /**
   * Asks the partner which app its agreement's token is for, for an agreement paired before pairing told each side.
   * @return {Promise<string|null>} - the partner app's id, or null when its answer has none
   */
  async partnerAppId(): Promise<string | null> {
    await this.resolveAfterInit();
    const connection = this.__connection;
    if (!connection?.AppDataSharing) throw new Error('Buttress AppDataSharing not initialized');
    const token = this.uri.searchParams.get('token');
    if (!token) throw new Error('Missing token in Buttress connection string');

    // @buttress/api has no call for it, so it goes through the client's own request, as its calls do
    const answer = (await connection.AppDataSharing._request('get', 'identity', {
      method: '',
      params: {},
      token,
      data: {},
      body: {},
      headers: {},
      stream: false,
      combineResults: true,
    })) as { appId?: unknown } | null;
    const appId = answer?.appId;
    return ObjectIdHelper.isValid(appId) ? String(appId) : null;
  }

  override get ID() {
    return ObjectIdHelper;
  }

  resolveAfterInit() {
    if (this.init) return Promise.resolve();
    return new Promise<unknown>((resolve) => {
      this.initPendingResolve.push(resolve);
    });
  }

  private async _apiCall<T>(operation: string, call: () => Promise<T>) {
    try {
      return await call();
    } catch (err: unknown) {
      Logging.logError(
        `[ButtressAdapter.${operation}] target:${this.uri.host}${this.uri.pathname} collection:${this.collectionName || 'unknown'}`,
      );
      Logging.logError(Helpers.getThrownErrorMessage(err));
      throw err;
    }
  }

  private async _resolvedApiCall<T>(operation: string, call: () => Promise<T>) {
    await this.resolveAfterInit();
    return this._apiCall(operation, call);
  }

  // Replaces any ObjectIds with their string form, so they can be sent to the remote. The value's static
  // type is kept, as it's only used to build requests.
  convertBSONObjects<T>(target: T): T {
    if (isObjectId(target)) {
      return target.toString() as T;
    } else if (Array.isArray(target)) {
      return target.map((value: unknown) => this.convertBSONObjects(value)) as T;
    } else if (typeof target === 'object' && target !== null) {
      const obj = target as Record<string, unknown>;
      for (const key in obj) {
        if (!{}.hasOwnProperty.call(obj, key)) continue;
        obj[key] = this.convertBSONObjects(obj[key]);
      }
    }
    return target;
  }

  handleResult(result: Stream.Readable | unknown) {
    if (result instanceof Stream.Readable && result.readable) {
      // Stream will be an array of objects, parse them out. Unlike pipe(), pipeline() fails the parsed stream with
      // the remote stream's error.
      return Stream.pipeline(result, parseJsonArrayStream(), (err) => {
        if (err) Logging.logSilly(`Error in remote stream: ${err.message}`);
      });
    }

    return result;
  }

  override async batchUpdateProcess(id: string, body: unknown) {
    const result = await this._resolvedApiCall('batchUpdateProcess', () => this.collection.update(id, body));
    return this.handleResult(result);
  }

  /**
   * @param {object} body
   * @return {Promise}
   */
  override async add(body: unknown) {
    body = this.convertBSONObjects(body);
    const result = await this._resolvedApiCall('add', () =>
      Array.isArray(body)
        ? this.collection.bulkSave(body, { stream: true })
        : this.collection.save(body, { stream: true }),
    );

    return this.handleResult(result);
  }

  /**
   * @param {string} id
   * @param {object} extra - a filter the entity must also match, which the partner checks: it's counted there beside
   *   the id under $and, as the MongoDB adapter does, so an `id` of its own can't replace the one asked for
   * @return {Boolean}
   */
  override async exists(id: string, extra: AdapterQuery = {}) {
    id = this.convertBSONObjects(id);
    if (Object.keys(extra).length > 0) return (await this.count({ $and: [{ id }, extra] })) > 0;

    const result = await this._resolvedApiCall('exists', () => this.collection.get(id));
    return result ? true : false;
  }

  /**
   * @param {object} details
   * @return {Promise}
   */
  override isDuplicate() {
    return Promise.resolve(false);
  }

  override findStoredIds(_ids: string[]) {
    return Promise.resolve([]);
  }

  /**
   * @param {string} id
   * @return {Promise}
   */
  override async rm(id: string) {
    // entity = this.convertBSONObjects(entity);
    const result = await this._resolvedApiCall('rm', () => this.collection.remove(id));
    return this.handleResult(result);
  }

  /**
   * @param {array} ids
   * @return {Promise}
   */
  override async rmBulk(ids: string[]) {
    ids = this.convertBSONObjects(ids);
    const result = await this._resolvedApiCall('rmBulk', () => this.collection.bulkRemove(ids));
    return this.handleResult(result);
  }

  /**
   * @param {object} query - a partner's delete-all takes no filter, and removes everything its policies let this token
   *   remove, so only a query that matches nothing in particular is sent that way. One that filters removes the
   *   entities it matches, by id.
   * @return {Promise}
   */
  override async rmAll(query?: AdapterQuery) {
    if (query && Object.keys(query).length > 0) {
      const matched = await Helpers.streamAll<{ id: string }>(await this.find(query));
      return matched.length > 0 ? this.rmBulk(matched.map((entity) => entity.id)) : true;
    }

    const result = await this._resolvedApiCall('rmAll', () => this.collection.removeAll());
    return this.handleResult(result);
  }

  /**
   * @param {string} id
   * @return {Promise}
   */
  override async findById(id: string) {
    id = this.convertBSONObjects(id);
    const result = await this._resolvedApiCall('findById', () => this.collection.get(id));
    return this.handleResult(result);
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
    _excludes: AdapterQuery | null = {},
    limit = 0,
    skip = 0,
    sort?: Record<string, unknown> | null,
    project: Record<string, unknown> | null | false = null,
  ) {
    // Logging.logSilly(`find: ${this.collectionName} ${query}`);
    query = this.convertBSONObjects(query);

    const result = await this._resolvedApiCall('find', () =>
      this.collection.search(query, limit, skip, sort, {
        project,
        stream: true,
      }),
    );

    // Requested as a stream
    return this.handleResult(result) as Stream.Readable;
  }

  /**
   * @return {Promise}
   */
  override async findAll() {
    const result = await this._resolvedApiCall('findAll', () => this.collection.getAll());
    return this.handleResult(result) as Stream.Readable;
  }

  /**
   * @param {Array} ids - mongoDB query
   * @return {Promise}
   */
  override async findAllById(ids: string[]) {
    ids = this.convertBSONObjects(ids);
    const result = await this._resolvedApiCall('findAllById', () => this.collection.bulkGet(ids));
    return this.handleResult(result) as Stream.Readable;
  }

  /**
   * @param {Object} query - mongoDB query
   * @return {Promise}
   */
  override async count(query?: AdapterQuery) {
    query = this.convertBSONObjects(query);
    const result = await this._resolvedApiCall('count', () => this.collection.count(query));
    return this.handleResult(result) as number;
  }

  /**
   * @return {Promise}
   */
  override async drop() {
    const result = await this._resolvedApiCall('drop', () => this.collection.removeAll());
    return this.handleResult(result);
  }
}
