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
  BSON,
  ObjectId,
  MongoClient,
  MongoClientOptions,
  Db,
  Collection,
  CommandStartedEvent,
  AnyBulkWriteOperation,
  Document,
  Filter,
  FindOptions,
  Sort,
  UpdateFilter,
} from 'mongodb';

import * as Helpers from '../../helpers/index.js';
import IOStats from '../../helpers/io-stats.js';
import Logging from '../../helpers/logging.js';

import AbstractAdapter from '../abstract-adapter.js';
import MongodbIds from './mongodb-ids.js';
import ObjectIdHelper, { isObjectId } from './object-id.js';

import { BjsQuery } from '../../types/bjs-query.js';
import {
  AdapterDocument,
  AdapterQuery,
  UpdatePathBody,
  UpdatePathContext,
  UpdatePathOperation,
} from '../../types/datastore.js';
import { FlattenedSchemaProperty, Schema } from '../../types/schema.js';
import StandardModel from '../../model/type/standard.js';

// One Mongo update operation on one path, e.g. {$push: {tags: 'a'}}.
type UpdateOp = Record<string, Record<string, unknown>>;

// A document, or an array inside one, that an update operation reaches into.
type UpdateContainer = Record<string | number, unknown>;

// Tries at writing ops that had to be worked out on the entity as read, before giving up because it keeps changing.
const MAX_UPDATE_ATTEMPTS = 5;

// Mongo's codes for an update the stored data can't take: a field under a non-document (PathNotViable), a push or
// pull on a non-array (BadValue), an increment of a non-number (TypeMismatch).
const DATA_CONFLICT_CODES = [2, 14, 28];

// An operation of the adapter's own that removes the item at an index, e.g. {$removeAt: {tags: 1}}. Mongo has none: its
// $unset then $pull also took every other null in the array. It's only ever applied to the entity as read.
const REMOVE_AT = '$removeAt';

const refuseUpdate = (reason: string) => new Helpers.Errors.RequestError(400, `Update can't be applied: ${reason}`);

const readOp = (op: UpdateOp) => {
  const [operator] = Object.keys(op);
  const [path] = Object.keys(op[operator]);
  return { operator, path, value: op[operator][path] };
};

const pathsOverlap = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/**
 * Merges one request's operations into a single update document, which Mongo applies atomically. Returns null when two
 * of them touch the same path, or a path and one inside it, which one document can't express.
 */
export const mergeUpdateOps = (ops: UpdateOp[]): UpdateOp | null => {
  const merged: UpdateOp = {};
  const paths: string[] = [];
  for (const op of ops) {
    const { operator, path, value } = readOp(op);
    if (operator === REMOVE_AT) return null;
    if (paths.some((other) => pathsOverlap(other, path))) return null;

    paths.push(path);
    merged[operator] = { ...merged[operator], [path]: value };
  }
  return merged;
};

const describeElement = (key: string, value: unknown) => `{${key}: ${value === null ? 'null' : JSON.stringify(value)}}`;

// The key a path segment names in `container`: an index for an array, which only numeric segments can name.
const keyIn = (container: unknown, segment: string): string | number | null => {
  if (!Array.isArray(container)) return segment;
  return /^\d+$/.test(segment) ? Number(segment) : null;
};

const setKey = (container: UpdateContainer, key: string | number, value: unknown) => {
  if (Array.isArray(container)) {
    while (container.length < (key as number)) container.push(null);
  }
  container[key] = value;
};

/**
 * Finds the container and key a dotted path ends at. With `create`, missing documents on the way are created and a
 * path through a value that isn't a document is refused, as Mongo does for $set, $push and $inc. Without it, a path
 * that doesn't lead anywhere gives null, as for $unset and $pull.
 */
const resolvePath = (
  doc: UpdateContainer,
  path: string,
  create: boolean,
): { container: UpdateContainer; key: string | number } | null => {
  const segments = path.split('.');
  let container = doc;
  let parentKey = '';

  for (const [idx, segment] of segments.entries()) {
    const key = keyIn(container, segment);
    if (key === null) {
      if (!create) return null;
      throw refuseUpdate(`Cannot create field '${segment}' in element ${describeElement(parentKey, container)}`);
    }
    if (idx === segments.length - 1) return { container, key };

    let next = container[key];
    if (next === undefined) {
      if (!create) return null;
      next = {};
      setKey(container, key, next);
    } else if (next === null || typeof next !== 'object') {
      if (!create) return null;
      throw refuseUpdate(`Cannot create field '${segments[idx + 1]}' in element ${describeElement(segment, next)}`);
    }

    container = next as UpdateContainer;
    parentKey = segment;
  }

  return null;
};

/**
 * Applies update operations to a document in memory, in order, following Mongo's rules for the operators the adapter
 * uses, and refusing what Mongo would refuse in Mongo's words.
 */
export const applyUpdateOps = (doc: UpdateContainer, ops: UpdateOp[]) => {
  for (const op of ops) {
    const { operator, path, value } = readOp(op);
    const target = resolvePath(doc, path, !['$unset', '$pull', REMOVE_AT].includes(operator));
    if (!target) continue;

    const { container, key } = target;
    const current = container[key];
    switch (operator) {
      case '$set':
        setKey(container, key, value);
        break;
      case '$unset':
        if (!Array.isArray(container)) delete container[key];
        else if ((key as number) < container.length) container[key] = null;
        break;
      case '$pull':
        if (current === undefined) break;
        if (!Array.isArray(current)) throw refuseUpdate('Cannot apply $pull to a non-array value');
        container[key] = current.filter((item) => item !== null);
        break;
      case REMOVE_AT:
        if (current === undefined) break;
        if (!Array.isArray(current)) throw refuseUpdate('Cannot remove an item from a non-array value');
        if (typeof value === 'number' && value < current.length) current.splice(value, 1);
        break;
      case '$push':
        if (current === undefined) setKey(container, key, [value]);
        else if (Array.isArray(current)) current.push(value);
        else
          throw refuseUpdate(
            `The field '${path}' must be an array but is of type ${current === null ? 'null' : typeof current}`,
          );
        break;
      case '$inc':
        if (current === undefined) setKey(container, key, value);
        else if (typeof current === 'number' && typeof value === 'number') container[key] = current + value;
        else throw refuseUpdate('Cannot apply $inc to a value of non-numeric type');
        break;
      default:
        throw new Error(`Unsupported update operator: ${operator}`);
    }
  }
};

export default class MongodbAdapter extends AbstractAdapter {
  private _client?: MongoClient;

  declare options?: MongoClientOptions;

  declare protected __connection?: Db;

  declare collection?: Collection;

  // Converts ids to ObjectIds on the way in and back to strings on the way out, see MongodbIds
  private _ids = new MongodbIds();

  override async connect() {
    if (this.__connection) return this.__connection;

    // Remove the pathname as we'll selected the db using the client method
    const connectionString = this.uri.href.replace(this.uri.pathname, '');

    // Command monitoring costs something per command, so it's only on while I/O is being counted (the budget tests).
    if (IOStats.isEnabled()) {
      this._client = await MongoClient.connect(connectionString, { ...this.options, monitorCommands: true });
      this._client.on('commandStarted', (event: CommandStartedEvent) => {
        const target: unknown = event.command[event.commandName];
        // Commands like getMore don't name the collection first, but in `collection`
        IOStats.record(
          'mongo',
          event.commandName,
          typeof target === 'string' ? target : (event.command.collection as string | undefined),
        );
      });
    } else {
      this._client = await MongoClient.connect(connectionString, this.options || {});
    }

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
    return ObjectIdHelper;
  }

  override updateSchema(schemaData: Schema) {
    this._ids.setSchema(schemaData.properties);
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
      return arr.concat([this._ids.toStored(modifier(item))]);
    }, Promise.resolve([]));

    const ops = documents.map((c: AdapterDocument): AnyBulkWriteOperation => {
      return { insertOne: { document: c } };
    });

    if (ops.length < 1) return Promise.resolve([]);

    let res;
    try {
      res = await this.collection?.bulkWrite(ops);
    } catch (err) {
      throw await this._undoFailedAdd(err, documents);
    }
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

  /**
   * An ordered insert stops at the first document it can't write, after writing the documents before it. Those are
   * removed, so that a failed add stores nothing, and a reused id becomes a DuplicateIdError naming its index. Gives
   * the error to throw.
   */
  async _undoFailedAdd(err: unknown, documents: AdapterDocument[]) {
    // The driver types writeErrors as one error or an array of them.
    const writeErrors = (err as { writeErrors?: unknown } | null)?.writeErrors;
    const writeError = (Array.isArray(writeErrors) ? writeErrors[0] : writeErrors) as
      | { index?: number; code?: number }
      | undefined;
    // Without a write error it isn't known what was written, so nothing is removed.
    if (typeof writeError?.index !== 'number') return err;

    const written = documents.slice(0, writeError.index).map((document) => document._id as ObjectId);
    if (written.length > 0) {
      try {
        await this.collection?.deleteMany({ _id: { $in: written } });
      } catch (deleteErr) {
        Logging.logError(
          `Unable to remove the ${written.length} entities of a failed add: ${Helpers.getThrownErrorMessage(deleteErr)}`,
        );
        return err;
      }
    }

    if (writeError.code === 11000) {
      const { _id } = documents[writeError.index];
      return new Helpers.Errors.DuplicateIdError(writeError.index, isObjectId(_id) ? _id.toHexString() : String(_id));
    }
    return err;
  }

  override async batchUpdateProcess(
    id: string,
    body: UpdatePathBody,
    context: UpdatePathContext,
    schemaConfig: FlattenedSchemaProperty | false | undefined,
    model?: StandardModel<unknown>,
  ) {
    const { ops, result } = await this._prepareUpdate(id, body, context, schemaConfig, model);
    await this._applyUpdateOps(id, ops);
    return result;
  }

  /**
   * Applies all of one request's updates to an entity together, so either all of them take effect or none do.
   */
  override async updateByPaths(id: string, updates: UpdatePathOperation[], model?: StandardModel<unknown>) {
    const prepared: Awaited<ReturnType<MongodbAdapter['_prepareUpdate']>>[] = [];
    for (const update of updates) {
      prepared.push(await this._prepareUpdate(id, update.body, update.context, update.schemaConfig, model));
    }

    await this._applyUpdateOps(
      id,
      prepared.flatMap((update) => update.ops),
    );
    return prepared.map((update) => update.result);
  }

  // Works out the operations one update makes and the result the client gets back, without writing anything.
  async _prepareUpdate(
    id: string,
    body: UpdatePathBody,
    context: UpdatePathContext,
    schemaConfig: FlattenedSchemaProperty | false | undefined,
    model?: StandardModel<unknown>,
  ) {
    if (!context) throw new Error(`batchUpdateProcess called without context; ${id}`);

    const updateType = context.type;
    let response: unknown = null;

    const ops: UpdateOp[] = [];

    switch (updateType) {
      default: {
        throw new Error(`Invalid update type: ${updateType}`);
      }
      case 'vector-add':
        {
          let value: unknown = null;
          if (schemaConfig && schemaConfig.__schema) {
            value = Helpers.Schema.sanitizeArrayItem(schemaConfig.__schema, body.value);
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
            $push: {
              [body.path]: value,
            },
          });
          response = value;
        }
        break;
      case 'vector-rm':
        {
          const params = body.path.split('.');
          params.splice(-1, 1);
          const index = params.pop();
          body.path = params.join('.');

          // Only the item at the index goes, so the array's other nulls stay.
          ops.push({ [REMOVE_AT]: { [body.path]: Number(index) } });

          response = { numRemoved: 1, index: index };
        }
        break;
      case 'scalar':
        {
          let value: unknown = null;
          if (schemaConfig && schemaConfig.__schema && Array.isArray(body.value)) {
            // An array value replaces the whole array (see StandardModel.updateByPath), so each element is an item.
            const itemSchema = schemaConfig.__schema;
            value = body.value.map((item) => Helpers.Schema.sanitizeArrayItem(itemSchema, item));
          } else if (schemaConfig && schemaConfig.__schema) {
            value = Helpers.Schema.sanitizeArrayItem(schemaConfig.__schema, body.value);
          } else {
            value = body.value;
          }

          ops.push({
            $set: {
              [body.path]: value,
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
            $inc: {
              [path]: body.value,
            },
          });

          response = body.value;
        }
        break;
    }

    return {
      ops,
      result: {
        type: updateType,
        path: body.path,
        value: response,
      },
    };
  }

  // The update values carry ids as strings, so they're converted to ObjectIds before they're merged or applied.
  async _applyUpdateOps(id: string, ops: UpdateOp[]) {
    if (ops.length < 1) return;

    const storedOps = ops.map((op) => this._ids.toStored(op));
    const merged = mergeUpdateOps(storedOps);
    if (merged) {
      await this._write(() => this.collection?.updateOne({ _id: new ObjectId(id) }, merged as UpdateFilter<Document>));
      return;
    }

    await this._applyUpdateOpsInOneWrite(id, storedOps);
  }

  /**
   * Operations on overlapping paths can't share one update document, so they're worked out on the fields they touch as
   * read, and those fields are written back only if they haven't changed since. If they have, it tries again.
   */
  async _applyUpdateOpsInOneWrite(id: string, ops: UpdateOp[]) {
    if (!this.collection) throw new Error('No collection');

    const _id = new ObjectId(id);
    const fields = [...new Set(ops.map((op) => readOp(op).path.split('.')[0]))];
    const projection = Object.fromEntries(fields.map((field) => [field, 1]));

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const stored = await this.collection.findOne({ _id }, { projection });
      if (!stored) return;

      const updated: Document = BSON.deserialize(BSON.serialize(stored));
      applyUpdateOps(updated, ops);

      const unchanged: Filter<Document> = Object.fromEntries(
        fields.map((field) => [field, field in stored ? stored[field] : { $exists: false }]),
      );
      const $set = Object.fromEntries(
        fields.filter((field) => field in updated).map((field) => [field, updated[field]]),
      );
      const $unset = Object.fromEntries(fields.filter((field) => !(field in updated)).map((field) => [field, '']));
      const update: UpdateFilter<Document> = {
        ...(Object.keys($set).length > 0 ? { $set } : {}),
        ...(Object.keys($unset).length > 0 ? { $unset } : {}),
      };

      const res = await this._write(() => this.collection?.updateOne({ _id, ...unchanged }, update));
      if (res && res.matchedCount > 0) return;
    }

    throw new Helpers.Errors.RequestError(409, 'The entity changed while it was being updated, try again');
  }

  async _write<T>(write: () => Promise<T> | undefined): Promise<T | undefined> {
    try {
      return await write();
    } catch (err: unknown) {
      const { code, errmsg, message } = (err ?? {}) as { code?: unknown; errmsg?: unknown; message?: unknown };
      if (typeof code !== 'number' || !DATA_CONFLICT_CODES.includes(code)) throw err;
      throw refuseUpdate(String(errmsg ?? message).replace(/^.*caused by :: /, ''));
    }
  }

  override async update(select: AdapterQuery, update: AdapterQuery) {
    const object = await this.collection?.updateMany(this._query(select), this._ids.toStored(update));
    return this._modifyDocument(object);
  }

  override async updateOne(query: AdapterQuery, update: AdapterQuery) {
    const object = await this.collection?.updateOne(this._query(query), this._ids.toStored(update));
    return this._modifyDocument(object);
  }

  override async updateById(id: string, query: AdapterQuery) {
    const object = await this.collection?.updateOne({ _id: new ObjectId(id) }, this._ids.toStored(query));

    return this._modifyDocument(object);
  }

  // Async so an invalid id gives a resolved `false`, callers chain `.then()` on the result
  override async exists(id: string, extra: AdapterQuery = {}) {
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
  override async isDuplicate(details: unknown) {
    // An entity is a duplicate when it reuses the id of one already stored, which the insert would refuse.
    const id = (details as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !id) return false;

    return this.exists(id);
  }

  override async findStoredIds(ids: string[]) {
    if (!this.collection) throw new Error('No collection');

    // An id that isn't an ObjectId can't be stored.
    const objectIds = ids.flatMap((id) => (ObjectId.isValid(id) ? [new ObjectId(id)] : []));
    if (objectIds.length < 1) return [];

    const documents = await this.collection.find({ _id: { $in: objectIds } }, { projection: { _id: 1 } }).toArray();
    return documents.map((document) => document._id.toHexString());
  }

  /**
   * @param {string} id - id to be deleted
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  override async rm(id: string) {
    const cursor = this.collection?.deleteOne({ _id: new ObjectId(id) });
    if (!cursor) throw new Error('Unable to delete');

    return cursor;
  }

  /**
   * @param {Array} ids - Array of entity ids to delete
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  override rmBulk(ids: string[]) {
    // Logging.log(`rmBulk: ${this.collection.namespace} ${ids}`, Logging.Constants.LogLevel.SILLY);
    return this.rmAll({ _id: { $in: ids } });
  }

  /*
   * @param {Object} query - mongoDB query
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  override async rmAll(query?: AdapterQuery) {
    if (!query) query = {};

    const doc = await this.collection?.deleteMany(this._query(query));
    if (!doc) throw new Error('Unable to deleteMany');

    return doc;
  }

  /**
   * @param {String} id - entity id to get
   * @return {Promise} - resolves to an array of Companies
   */
  override async findById(id: string) {
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
      .find(this._query(query), excludes as FindOptions)
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
    const doc = await this.collection?.findOne(this._query(query), this._query(excludes) as FindOptions);

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

    return this.collection.countDocuments(this._query(query));
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

  // Modify a straem of docuemnts, converting _id to id and ObjectIds to strings
  _modifyDocument<T>(doc: T): T {
    return this._ids.fromStored(doc);
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

  // A query with its ids as ObjectIds and `id` as `_id`
  _query(query: AdapterQuery | undefined): Filter<Document> {
    return this._ids.toStored(query) as Filter<Document>;
  }
}
