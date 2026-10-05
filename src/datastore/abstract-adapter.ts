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

import { Errors } from '../helpers/index.js';
import { redactUrl } from '../helpers/redact.js';

import type {
  AdapterAddModifier,
  AdapterIdHelper,
  AdapterQuery,
  UpdatePathBody,
  UpdatePathContext,
  UpdatePathOperation,
} from '../types/datastore.js';
import type { FlattenedSchemaProperty, Schema } from '../types/schema.js';
import type StandardModel from '../model/type/standard.js';

/**
 * The results of a find: a stream of documents, which some adapters have to wait on.
 */
export type AdapterFindResult = Stream.Readable | Promise<Stream.Readable>;

/**
 * An adapter to a datastore. TUri is the form the datastore factory reads its connection string into, which only the
 * adapter knows: a URL for most. As a bare type, AbstractAdapter is any adapter.
 */
export default class AbstractAdapter<TUri = unknown> {
  uri: TUri;
  // The datastore's options, given as a query string: BUTTRESS_DATASTORE_OPTIONS for the primary datastore. Only the
  // MongoDB adapter reads them.
  options?: URLSearchParams;
  requiresFormalSchema: boolean;
  protected __connection?: unknown;
  collection?: unknown;

  // Set on remote adapters by RemoteCombinedModel, not read by any adapter yet.
  declare returnPausedStream?: boolean;

  constructor(uri: TUri, options?: URLSearchParams, connection?: unknown) {
    this.uri = uri;
    this.options = options;

    this.requiresFormalSchema = false;

    this.__connection = connection;

    this.collection = null;
  }

  /**
   * The connection string without the credentials it can carry, for logs.
   */
  get redactedUri() {
    return redactUrl(this.uri);
  }

  async connect(): Promise<unknown> {
    throw new Errors.NotYetImplemented('connect');
  }

  async close(): Promise<void> {
    throw new Errors.NotYetImplemented('close');
  }

  cloneAdapterConnection(): AbstractAdapter<TUri> {
    throw new Errors.NotYetImplemented('cloneAdapterConnection');
  }

  setCollection(_collectionName: string): Promise<void> {
    throw new Errors.NotYetImplemented('setCollection');
  }

  updateSchema(_schemaData: Schema) {
    if (!this.requiresFormalSchema) return;

    throw new Errors.NotYetImplemented('updateSchema');
  }

  get ID(): AdapterIdHelper {
    throw new Errors.NotYetImplemented('get ID');
  }

  add(_body: unknown, _modifier: AdapterAddModifier): Promise<unknown> {
    throw new Errors.NotYetImplemented('add');
  }

  async batchUpdateProcess(
    _id: string,
    _body: UpdatePathBody,
    _context: UpdatePathContext,
    _schemaConfig: FlattenedSchemaProperty | false | undefined,
    _model?: StandardModel<unknown>,
  ): Promise<unknown> {
    throw new Errors.NotYetImplemented('batchUpdateProcess');
  }

  /**
   * Applies all of one request's updates to an entity together, so they all take effect or none do. An adapter that
   * can't leaves it out, and StandardModel.updateByPath applies them one at a time with batchUpdateProcess.
   */
  updateByPaths?(id: string, updates: UpdatePathOperation[], model?: StandardModel<unknown>): Promise<unknown[]>;

  update(_select: AdapterQuery, _update: AdapterQuery): Promise<unknown> {
    throw new Errors.NotYetImplemented('update');
  }

  updateById(_id: string, _query: AdapterQuery): Promise<unknown> {
    throw new Errors.NotYetImplemented('updateById');
  }

  updateOne(_query: AdapterQuery, _update: AdapterQuery): Promise<unknown> {
    throw new Errors.NotYetImplemented('updateOne');
  }

  exists(_id: string, _extra: AdapterQuery = {}): Promise<boolean> {
    throw new Errors.NotYetImplemented('exists');
  }

  /*
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  isDuplicate(_details: unknown): Promise<boolean> {
    throw new Errors.NotYetImplemented('isDuplicate');
  }

  /**
   * @param {string[]} ids - ids of entities about to be added
   * @return {Promise<string[]>} - the ids among them that are already stored
   */
  findStoredIds(_ids: string[]): Promise<string[]> {
    throw new Errors.NotYetImplemented('findStoredIds');
  }

  /**
   * @param {App} id - id of the object to be deleted
   */
  rm(_id: string): Promise<unknown> {
    throw new Errors.NotYetImplemented('rm');
  }

  /**
   * @param {Array} ids - Array of entity ids to delete
   */
  rmBulk(_ids: string[]): Promise<unknown> {
    throw new Errors.NotYetImplemented('rmBulk');
  }

  /*
   * @param {Object} query - mongoDB query
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  rmAll(_query?: AdapterQuery): Promise<unknown> {
    throw new Errors.NotYetImplemented('rmAll');
  }

  /**
   * @param {String} id - entity id to get
   */
  findById(_id: string): Promise<unknown> {
    throw new Errors.NotYetImplemented('findById');
  }

  /**
   * @param {Object} query - mongoDB query
   * @param {Object} excludes - mongoDB query excludes
   * @param {Int} limit - should return a stream
   * @param {Int} skip - should return a stream
   * @param {Object} sort - mongoDB sort object
   * @param {Boolean} project - mongoDB project ids
   */
  find(
    _query: AdapterQuery,
    _excludes: AdapterQuery | null = {},
    _limit: number = 0,
    _skip: number = 0,
    _sort: Record<string, unknown> | null = null,
    _project: Record<string, unknown> | null | false = null,
  ): AdapterFindResult {
    throw new Errors.NotYetImplemented('find');
  }

  /**
   * @param {Object} query - mongoDB query
   * @param {Object} excludes - mongoDB query excludes
   */
  findOne(_query: AdapterQuery, _excludes: AdapterQuery = {}): Promise<unknown> {
    throw new Errors.NotYetImplemented('findOne');
  }

  /**
   */
  findAll(): AdapterFindResult {
    throw new Errors.NotYetImplemented('findAll');
  }

  /**
   * @param {Array} ids - Array of entities ids to get
   */
  findAllById(_ids: string[]): AdapterFindResult {
    throw new Errors.NotYetImplemented('findAllById');
  }

  /**
   * @param {Object} query - mongoDB query
   */
  count(_query?: AdapterQuery): Promise<number> {
    throw new Errors.NotYetImplemented('count');
  }

  /**
   */
  drop(): Promise<unknown> {
    throw new Errors.NotYetImplemented('drop');
  }
}
