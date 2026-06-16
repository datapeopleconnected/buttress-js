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
import { ObjectId } from 'bson';
import ButtressExport, { Errors as BAPIErrors } from '@buttress/api';
// TODO: Look into why the export from @buttress/api is not working as expected.
const { default: ButtressAPI } = ButtressExport;

import Errors from '../../helpers/errors.js';
import * as Helpers from '../../helpers/index.js';
import { parseJsonArrayStream } from '../../helpers/stream.js';
import Logging from '../../helpers/logging.js';

import AbstractAdapter from '../abstract-adapter.js';

class AdapterId {
  static new(id: string) {
    return new ObjectId(id);
  }

  static isValid(id: string) {
    return ObjectId.isValid(id);
  }

  static instanceOf(id: string | ObjectId) {
    return id instanceof ObjectId;
  }
}

export default class Buttress extends AbstractAdapter {
  init: boolean;
  initPendingResolve: ((value?: unknown) => void)[];
  collectionName?: string;

  protected override __connection: any;

  declare collection: any;

  constructor(uri, options, connection = null) {
    super(uri, options, connection);

    this.__connection = ButtressAPI.new();

    this.init = false;
    this.initPendingResolve = [];
  }

  async connect() {
    if (this.init) return this.__connection;

    const protocol = this.uri.protocol === 'butts:' ? 'https' : 'http';

    const token = this.uri.searchParams.get('token');
    if (!token) throw new Error('Missing token in Buttress connection string');

    const buttressUrl = `${protocol}://${this.uri.host}`;
    const apiPath = this.uri.pathname.replace(/^\/+/, '');
    await this._apiCall('connect', () =>
      this.__connection.init({
        buttressUrl,
        appToken: token,
        apiPath,
        version: 1,
      }),
    );
    Logging.logDebug(`connected to: ${this.uri.host}/${apiPath}`);

    // this.collection = this.buttress.getCollection(collection);
    // this.setCollection(this.uri.pathname.replace(/\//g, ''));
    this.init = true;
    this.initPendingResolve.forEach((r) => r());
  }

  override cloneAdapterConnection() {
    return new Buttress(this.uri, this.options, this.__connection);
  }

  async close() {
    // TODO: Handle closing down socket connections??
    this.__connection = null;
    this.init = false;
    this.initPendingResolve = [];
  }

  override async setCollection(collectionName: string) {
    try {
      this.collectionName = collectionName;
      this.collection = await this._apiCall('setCollection', () =>
        Promise.resolve(this.__connection.getCollection(collectionName)),
      );
    } catch (err: unknown) {
      if (err instanceof BAPIErrors.SchemaNotFound) throw new Errors.SchemaNotFound(err.message);
      else throw err;
    }
  }

  async getSchema(rawSchema = false, only = []) {
    return this._resolvedApiCall('getSchema', () =>
      this.__connection.App.getSchema(rawSchema, {
        params: {
          only: only.join(','),
        },
      }),
    );
  }

  async activateDataSharing(registrationToken, newToken) {
    await this.resolveAfterInit();
    return await this.__connection.AppDataSharing.activate(registrationToken, newToken);
  }

  override get ID() {
    return AdapterId;
  }

  resolveAfterInit() {
    if (this.init) return Promise.resolve();
    return new Promise((resolve) => {
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

  convertBSONObjects(target) {
    if (target instanceof ObjectId) {
      return target.toString();
    } else if (Array.isArray(target)) {
      return target.map((value) => this.convertBSONObjects(value));
    } else if (typeof target === 'object' && target !== null) {
      for (const key in target) {
        if (!{}.hasOwnProperty.call(target, key)) continue;
        target[key] = this.convertBSONObjects(target[key]);
      }
    }
    return target;
  }

  handleResult(result: Stream.Readable | any) {
    if (result instanceof Stream.Readable && result.readable) {
      // Stream will be an array of objects, parse them out.
      return result.pipe(parseJsonArrayStream());
    }

    return result;
  }

  override async batchUpdateProcess(id, body) {
    const result = await this._resolvedApiCall('batchUpdateProcess', () => this.collection.update(id, body));
    return this.handleResult(result);
  }

  /**
   * @param {object} body
   * @return {Promise}
   */
  override async add(body) {
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
   * @return {Boolean}
   */
  override async exists(id) {
    id = this.convertBSONObjects(id);
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
  override async rmBulk(ids) {
    ids = this.convertBSONObjects(ids);
    const result = await this._resolvedApiCall('rmBulk', () => this.collection.bulkRemove(ids));
    return this.handleResult(result);
  }

  /**
   * @param {object} query
   * @return {Promise}
   */
  override async rmAll(query) {
    const result = await this._resolvedApiCall('rmAll', () => this.collection.removeAll(query));
    return this.handleResult(result);
  }

  /**
   * @param {string} id
   * @return {Promise}
   */
  override async findById(id) {
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
  override async find(query, _excludes = {}, limit = 0, skip = 0, sort, project = null) {
    // Logging.logSilly(`find: ${this.collectionName} ${query}`);
    query = this.convertBSONObjects(query);

    const result = await this._resolvedApiCall('find', () =>
      this.collection.search(query, limit, skip, sort, {
        project,
        stream: true,
      }),
    );

    return this.handleResult(result);
  }

  /**
   * @return {Promise}
   */
  override async findAll() {
    const result = await this._resolvedApiCall('findAll', () => this.collection.getAll());
    return this.handleResult(result);
  }

  /**
   * @param {Array} ids - mongoDB query
   * @return {Promise}
   */
  override async findAllById(ids) {
    ids = this.convertBSONObjects(ids);
    const result = await this._resolvedApiCall('findAllById', () => this.collection.bulkGet(ids));
    return this.handleResult(result);
  }

  /**
   * @param {Object} query - mongoDB query
   * @return {Promise}
   */
  override async count(query) {
    query = this.convertBSONObjects(query);
    const result = await this._resolvedApiCall('count', () => this.collection.count(query));
    return this.handleResult(result);
  }

  /**
   * @return {Promise}
   */
  override async drop() {
    const result = await this._resolvedApiCall('drop', () => this.collection.removeAll());
    return this.handleResult(result);
  }
}
