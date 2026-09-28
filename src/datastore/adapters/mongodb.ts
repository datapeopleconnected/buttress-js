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

import {
  ObjectId,
  MongoClient,
  MongoClientOptions,
  Db,
  Collection,
  AnyBulkWriteOperation,
  Document,
  Filter,
  FindOptions,
  Sort,
  UpdateFilter,
} from 'mongodb';

import * as Helpers from '../../helpers/index.js';
import Logging from '../../helpers/logging.js';

import AbstractAdapter from '../abstract-adapter.js';

import { BjsQuery } from '../../types/bjs-query.js';
import {
  AdapterDocument,
  AdapterIdInput,
  AdapterQuery,
  UpdatePathBody,
  UpdatePathContext,
} from '../../types/datastore.js';
import { FlattenedSchemaProperty } from '../../types/schema.js';
import StandardModel from '../../model/type/standard.js';

class AdapterId {
  static new(id?: AdapterIdInput) {
    return new ObjectId(id);
  }

  static isValid(id: unknown) {
    return ObjectId.isValid(id as Parameters<typeof ObjectId.isValid>[0]);
  }

  static instanceOf(id: unknown) {
    return id instanceof ObjectId;
  }
}

export default class MongodbAdapter extends AbstractAdapter {
  private _client?: MongoClient;

  declare options?: MongoClientOptions;

  declare protected __connection?: Db;

  declare collection?: Collection;

  override async connect() {
    if (this.__connection) return this.__connection;

    // Remove the pathname as we'll selected the db using the client method
    const connectionString = this.uri.href.replace(this.uri.pathname, '');

    this._client = await MongoClient.connect(connectionString, this.options || {});

    this.__connection = this._client.db(this.uri.pathname.replace(/\//g, ''));

    return this.__connection;
  }

  override async close() {
    if (!this._client) return;
    try {
      await this._client.close();
    } catch (err: unknown) {
      const errMessage = Helpers.getThrownErrorMessage(err);
      // Ignore it, bug is within mongodb driver
      if (errMessage.includes("undefined (reading 'close')")) return;
      Logging.logError('Caught error while closing mongo connection');
      Logging.logError(errMessage);
    } finally {
      delete this.__connection;
      delete this._client;
    }
  }

  override cloneAdapterConnection() {
    return new MongodbAdapter(this.uri, this.options, this.__connection);
  }

  override async setCollection(collectionName: string) {
    if (!this.__connection) throw new Error('No connection');
    this.collection = this.__connection.collection(collectionName);
  }

  override get ID() {
    return AdapterId;
  }

  override add(body: AdapterDocument | AdapterDocument[], modifier: (item: AdapterDocument) => AdapterDocument) {
    return this.__batchAddProcess(body, modifier);
  }

  async __batchAddProcess(
    body: AdapterDocument | AdapterDocument[],
    modifier: (item: AdapterDocument) => AdapterDocument,
  ) {
    if (body instanceof Array === false) {
      body = [body];
    }

    const documents = await body.reduce(async (prev: Promise<AdapterDocument[]>, item) => {
      const arr = await prev;
      return arr.concat([this._prepareDocumentForMongo(modifier(item))]);
    }, Promise.resolve([]));

    const ops = documents.map((c: AdapterDocument): AnyBulkWriteOperation => {
      return { insertOne: { document: c } };
    });

    if (ops.length < 1) return Promise.resolve([]);

    const res = await this.collection?.bulkWrite(ops);
    if (!res) throw new Error('Unable to bulk write');

    const readable = new Stream.Readable({ objectMode: true });
    readable._read = () => {};

    // Lets merged the inserted ids back into the documents, previously we were
    // looking them up in the database again which is a waste of time.
    new Promise<void>((resolve) =>
      setTimeout(() => {
        documents.forEach((document: AdapterDocument, idx: number) => {
          document._id = res.insertedIds[idx];
          readable.push(document);
        });
        readable.push(null);
        resolve();
      }, 1),
    );

    return this._modifyDocumentStream(readable);
  }

  override async batchUpdateProcess(
    id: string,
    body: UpdatePathBody,
    context: UpdatePathContext,
    schemaConfig: FlattenedSchemaProperty | false | undefined,
    model?: StandardModel<unknown>,
  ) {
    if (!context) throw new Error(`batchUpdateProcess called without context; ${id}`);

    const updateType = context.type;
    let response: unknown = null;

    const ops: AnyBulkWriteOperation[] = [];

    switch (updateType) {
      default: {
        throw new Error(`Invalid update type: ${updateType}`);
      }
      case 'vector-add':
        {
          let value: unknown = null;
          if (schemaConfig && schemaConfig.__schema) {
            const fb = Helpers.Schema.getFlattenedBody(body.value);
            value = Helpers.Schema.sanitizeObject(schemaConfig.__schema, fb);
          } else {
            value = body.value;
          }

          if (!schemaConfig && model) {
            const entity = await model.findById(id);
            const objValue: { [key: string]: unknown } = {};
            let updateValueExists = true;
            let modifiedPath = '';
            let basePath = body.path;
            let obj = entity as Record<string, unknown>;

            body.path.split('.').forEach((key) => {
              modifiedPath = modifiedPath ? key : `${modifiedPath}.${key}`;
              if (!obj[key]) {
                basePath = basePath.replace(`.${key}`, '');
                updateValueExists = false;
                if (!Number(key) && Number(key) !== 0) {
                  objValue[key] = value;
                }
                return;
              }

              obj = obj[key] as Record<string, unknown>;
            }, entity);

            if (!updateValueExists) {
              body.path = basePath;
              value = objValue;
            }
          }

          ops.push({
            updateOne: {
              filter: { _id: new ObjectId(id) },
              update: {
                $push: {
                  [body.path]: value,
                },
              } as UpdateFilter<Document>,
            },
          });
          response = value;
        }
        break;
      case 'vector-rm':
        {
          const params = body.path.split('.');
          params.splice(-1, 1);
          const rmPath = params.join('.');
          const index = params.pop();
          body.path = params.join('.');

          ops.push({
            updateOne: {
              filter: { _id: new ObjectId(id) },
              update: {
                $unset: {
                  [rmPath]: null,
                },
              },
            },
          });
          ops.push({
            updateOne: {
              filter: { _id: new ObjectId(id) },
              update: {
                $pull: {
                  [body.path]: null,
                },
              } as UpdateFilter<Document>,
            },
          });

          response = { numRemoved: 1, index: index };
        }
        break;
      case 'scalar':
        {
          let value: unknown = null;
          if (schemaConfig && schemaConfig.__schema) {
            const fb = Helpers.Schema.getFlattenedBody(body.value);
            value = Helpers.Schema.sanitizeObject(schemaConfig.__schema, fb);
          } else {
            value = body.value;
          }

          ops.push({
            updateOne: {
              filter: { _id: new ObjectId(id) },
              update: {
                $set: {
                  [body.path]: value,
                },
              },
            },
          });

          response = value;
        }
        break;
      case 'scalar-increment':
        {
          const params = body.path.split('.');
          params.splice(-1, 1);
          const path = params.join('.');

          ops.push({
            updateOne: {
              filter: { _id: new ObjectId(id) },
              update: {
                $inc: {
                  [path]: body.value,
                },
              } as UpdateFilter<Document>,
            },
          });

          response = body.value;
        }
        break;
    }

    const res = await this.collection?.bulkWrite(ops);
    if (!res) throw new Error('Unable to bulk write');

    return {
      type: updateType,
      path: body.path,
      value: response,
    };
  }

  override async update(select: AdapterQuery, update: AdapterQuery) {
    const object = await this.collection?.updateMany(this._prepareQueryForMongo(select), update);
    return this._modifyDocument(object);
  }

  override async updateOne(query: AdapterQuery, update: AdapterQuery) {
    const object = await this.collection?.updateOne(this._prepareQueryForMongo(query), update);
    return this._modifyDocument(object);
  }

  override async updateById(id: AdapterIdInput, query: AdapterQuery) {
    const object = await this.collection?.updateOne({ _id: new ObjectId(id) }, query);

    return this._modifyDocument(object);
  }

  // Async so an invalid id gives a resolved `false`, callers chain `.then()` on the result
  override async exists(id: AdapterIdInput, extra: AdapterQuery = {}) {
    if (!this.collection) throw new Error('No collection');

    Logging.logSilly(`exists: ${this.collection.namespace} ${id}`);

    let _id: ObjectId | null = null;
    try {
      _id = new ObjectId(id);
    } catch (_err) {
      return false;
    }

    if (_id === null) return false;

    return this.collection
      ?.countDocuments({
        _id,
        ...extra,
      })
      .then((count) => count > 0);
  }

  /*
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  override isDuplicate(_details: unknown) {
    // TODO: Implment this method
    return Promise.resolve(false);
  }

  /**
   * @param {string} id - id to be deleted
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  override async rm(id: AdapterIdInput) {
    const cursor = this.collection?.deleteOne({ _id: new ObjectId(id) });
    if (!cursor) throw new Error('Unable to delete');

    return cursor;
  }

  /**
   * @param {Array} ids - Array of entity ids to delete
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  override rmBulk(ids: AdapterIdInput[]) {
    // Logging.log(`rmBulk: ${this.collection.namespace} ${ids}`, Logging.Constants.LogLevel.SILLY);
    return this.rmAll({ _id: { $in: ids } });
  }

  /*
   * @param {Object} query - mongoDB query
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  override async rmAll(query?: AdapterQuery) {
    if (!query) query = {};

    const doc = await this.collection?.deleteMany(this._prepareQueryForMongo(query));
    if (!doc) throw new Error('Unable to deleteMany');

    return doc;
  }

  /**
   * @param {String} id - entity id to get
   * @return {Promise} - resolves to an array of Companies
   */
  override async findById(id: AdapterIdInput) {
    // Logging.logSilly(`Schema:findById: ${this.collection.namespace} ${id}`);

    const document = await this.collection?.findOne({ _id: new ObjectId(id) }, {});
    if (!document) throw new Error('Unable to find document');

    return this._modifyDocument(document);
  }

  /**
   * @param {Object} query - mongoDB query
   * @param {Object} excludes - mongoDB query excludes
   * @param {Int} limit - should return a stream
   * @param {Int} skip - should return a stream
   * @param {Object} sort - mongoDB sort object
   * @param {Boolean} project - mongoDB project ids
   * @return {ReadableStream} - stream
   */
  override find<T extends object>(
    query: BjsQuery<T> | AdapterQuery,
    excludes: AdapterQuery | null = {},
    limit = 0,
    skip = 0,
    sort: Record<string, unknown> | null = null,
    project: Record<string, unknown> | null | false = null,
  ) {
    if (!this.collection) throw new Error('No collection');

    if (Logging.level === Logging.Constants.LogLevel.SILLY) {
      Logging.logSilly(
        `find: ${this.collection.namespace} query: ${JSON.stringify(query)}, excludes: ${JSON.stringify(excludes)}` +
          `limit: ${limit}, skip: ${skip}, sort: ${JSON.stringify(sort)}`,
      );
    }

    // The driver ignores a null sort
    let results = this.collection
      .find(this._prepareQueryForMongo(query), excludes as FindOptions)
      .skip(skip)
      .limit(limit)
      .sort(sort as Sort);

    if (project) {
      results = results.project(project);
    }

    return this._modifyDocumentStream(results.stream());
  }

  /**
   * @param {Object} query - mongoDB query
   * @param {Object} excludes - mongoDB query excludes
   * @return {Promise} - resolves to an array of docs
   */
  override async findOne<T extends object>(query: BjsQuery<T> | AdapterQuery, excludes: AdapterQuery = {}) {
    const doc = await this.collection?.findOne(
      this._prepareQueryForMongo(query),
      this._prepareQueryForMongo(excludes) as FindOptions,
    );

    return doc ? this._modifyDocument(doc) : null;
  }

  /**
   * @return {Promise} - resolves to an array of Companies
   */
  override findAll() {
    // Logging.logSilly(`findAll: ${this.collection.namespace}`);

    return this.find({});
  }

  /**
   * @param {Array} ids - Array of entities ids to get
   * @return {Promise} - resolves to an array of Companies
   */
  override findAllById(ids: string[]) {
    // Logging.logSilly(`update: ${this.collection.namespace} ${ids}`);

    return this.find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, {});
  }

  /**
   * @param {Object} query - mongoDB query
   * @return {Promise} - resolves to an array of Companies
   */
  override count(query?: AdapterQuery) {
    if (!this.collection) throw new Error('No collection');

    return this.collection.countDocuments(this._prepareQueryForMongo(query));
  }

  /**
   * @return {Promise}
   */
  override async drop() {
    try {
      const res = await this.collection?.drop();
      if (!res) throw new Error('Unable to drop');

      return true;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 26) return true; // NamespaceNotFound

      throw err;
    }
  }

  // Modify a straem of docuemnts, converting _id to id
  _modifyDocument<T>(doc: T): T {
    const document = doc as Record<string, unknown> | null | undefined;
    if (document && document._id) {
      document.id = document._id;
      delete document._id;
    }

    return doc;
  }
  _modifyDocumentStream(stream: Stream.Readable) {
    const transformStream = new Stream.Transform({
      objectMode: true,
      transform: (doc: Document, enc, cb) => cb(null, this._modifyDocument(doc)),
    });

    stream.on('error', (err) => {
      Logging.logSilly(`Error in MongoDB stream: ${err.message}`);
      transformStream.emit('error', err);
    });

    return stream.pipe(transformStream);
  }

  // Methods for modifying a document or query to handle converting from id to _id
  _prepareDocumentForMongo(document: AdapterDocument) {
    if (document && document.id) {
      document._id = document.id;
      delete document.id;
    }
    return document;
  }
  _prepareQueryForMongo(query: AdapterQuery): Filter<Document>;
  _prepareQueryForMongo(query: AdapterQuery | undefined): Filter<Document> | undefined;
  _prepareQueryForMongo(query: AdapterQuery | undefined): Filter<Document> | undefined {
    if (!query) return query;

    if (query.id) {
      query._id = this._convertIdValue(query.id);
      delete query.id;
    } else if (query['$or'] || query['$and']) {
      if (query['$or']) {
        query['$or'] = (query['$or'] as AdapterQuery[]).map((q) => this._prepareQueryForMongo(q));
      } else if (query['$and']) {
        query['$and'] = (query['$and'] as AdapterQuery[]).map((q) => this._prepareQueryForMongo(q));
      }
    }

    return query;
  }

  /**
   * Handling converting part of an expression to a object id.
   * @param {object | string} expression
   * @return {object | string}
   */
  _convertIdValue(expression: unknown) {
    if (typeof expression === 'object' && !(expression instanceof ObjectId)) {
      const keys = Object.keys(expression as object);
      if (keys.length === 1) {
        const [key] = keys;
        const value = this._getExpressionValue((expression as Record<string, unknown>)[key]);
        return { [key]: value };
      } else {
        // Not sure what we've got here.
        Logging.logDebug(JSON.stringify(expression));
        throw new Error('Unknown expression in query.');
      }
    }

    // It's not an object, so must be a value.
    return new ObjectId(expression as AdapterIdInput);
  }

  /**
   * Handling getting a value of an expression and converting it to object id.
   * @param {array | string} value
   * @return {array | string}
   */
  _getExpressionValue(value: unknown) {
    if (Array.isArray(value)) {
      return value.length > 0
        ? value.map((v: AdapterIdInput) => {
            try {
              return new ObjectId(v);
            } catch (_err) {
              return v;
            }
          })
        : value;
    } else {
      try {
        return new ObjectId(value as AdapterIdInput);
      } catch (_err) {
        return value;
      }
    }
  }
}
