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
import Sugar from '../../helpers/sugar.js';
import { ALIASES, hasOperatorNames, isPlainObject, LOGICAL_ALIASES } from '../../access-control/operators.js';
import Logging from '../../helpers/logging.js';
import * as Helpers from '../../helpers/index.js';
import { decode, isDecodeError } from '../../helpers/codecs.js';

import * as Shared from '../shared.js';
import NodeRedisPubsub from '../../services/nrp.js';

import { Schema } from '../../helpers/schema.js';
import { App } from '../core/app.js';
import { Services } from '../../bootstrap.js';
import { ModelManager } from '../index.js';
import AbstractAdapter, { AdapterFindResult } from '../../datastore/abstract-adapter.js';
import { Datastore } from '../../datastore/index.js';
import { AdapterDocument, AdapterQuery, UpdatePathBody, UpdatePathContext } from '../../types/datastore.js';
import { isQueryPath, isUpdatePathRefusal, resolveUpdatePath } from '../update-paths.js';
import { FlattenedSchema, FlattenedSchemaProperty } from '../../types/schema.js';

// The types a compared query value is read as, and the operators that compare
const QUERY_TYPES = new Set(['boolean', 'number', 'uuid', 'date', 'id']);
const COMPARISONS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$all']);

const invalidQueryValue = (property: string, type: string) =>
  Helpers.Errors.badRequest('invalid_value', `The value for ${property} is not a valid ${type}`, {
    path: property,
    expected: type,
  });

// A query names an operator Buttress doesn't know: refused, rather than sent on for MongoDB to refuse (R3 step 7)
const unknownQueryOperator = (path: string, operator: string) =>
  Helpers.Errors.badRequest('unknown_operator', `The query names an operator Buttress doesn't know: ${operator}`, {
    path,
    received: operator,
  });

// A strict schema's query names a path it doesn't have: refused, as a create giving one is (R3 step 7)
const unknownQueryPath = (path: string) =>
  Helpers.Errors.badRequest('unknown_path', `The query names a path the schema doesn't have: ${path}`, { path });

// An operator in its `$` name: `@op` is `$op`
const operatorName = (operator: string) => (operator.startsWith('@') ? `$${operator.slice(1)}` : operator);

// Text JavaScript reads as a pattern
const isPattern = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try {
    new RegExp(value);
    return true;
  } catch (_err) {
    return false;
  }
};

// A query after parseQuery: a Buttress query, its operators in their `$` names and its values read as their
// properties' types. The MongoDB adapter gives it MongoDB's names (toMongoQuery).
export type ParsedQuery = Record<string, unknown>;

/* ********************************************************************************
 *
 * LOCALS
 *
 **********************************************************************************/

export default class StandardModel<TDocument = AdapterDocument> {
  static name = 'Model';

  private _schemaData!: Schema;
  flatSchemaData: FlattenedSchema = {};

  app: App | null;

  isCoreAPI: boolean = false;

  appShortId: string | null;
  collectionName: string;

  protected __services: Services;
  protected __nrp: NodeRedisPubsub;
  protected __modelManager: ModelManager;

  // Set by initAdapter, which the model manager calls before the model's used
  adapter!: AbstractAdapter;

  // Stops the model listening for its app's schema changes, once it's replaced or dropped
  private _unsubscribeSchemaUpdates?: Promise<() => unknown>;

  constructor(schemaData: Schema, app: App | null, services: Services) {
    this.schemaData = schemaData;

    this.app = app;

    if (!this.app) this.isCoreAPI = true;

    this.appShortId = app ? Helpers.shortId(app.id) : null;
    this.collectionName = schemaData.name;

    if (this.appShortId) {
      this.collectionName = `${this.appShortId}-${this.collectionName}`;
    }

    this.__services = services;

    this.__nrp = services.get('nrp') as NodeRedisPubsub;
    if (!this.__nrp) throw new Error('Unable to find nrp in services');

    this.__modelManager = this.__services.get('modelManager') as ModelManager;
    if (!this.__modelManager) throw new Error('Unable to find modelManager in services');

    // A core model has no app whose schema could change
    if (!app) return;
    this._unsubscribeSchemaUpdates = this.__nrp.on('app:update-schema', (json: string) => {
      const data = JSON.parse(json) as { appId: string; schemas: Schema[] };
      if (app.id.toString() !== data.appId) return;

      data.schemas.forEach((schema) => {
        if (schema.name !== this.schemaData.name) return;

        this.schemaData = schema;
      });
    });
  }

  get schemaData(): Schema {
    return this._schemaData;
  }

  // The flattened schema that queries are parsed against follows the schema
  set schemaData(schemaData: Schema) {
    this._schemaData = schemaData;
    this.flatSchemaData = schemaData ? Helpers.getFlattenedSchema(schemaData) : {};
  }

  /**
   * Lets the model go: it stops listening for its app's schema changes. The model manager calls this when it replaces
   * or drops the model.
   */
  async destroy() {
    const unsubscribe = await this._unsubscribeSchemaUpdates;
    delete this._unsubscribeSchemaUpdates;
    await unsubscribe?.();
  }

  async initAdapter(datastore?: Datastore | null) {
    if (datastore) {
      Logging.logSilly(`initAdapter ${this.schemaData.name}`);
      this.adapter = datastore.adapter.cloneAdapterConnection();
      await this.adapter.connect();
      await this.adapter.setCollection(this.collectionName);
      await this.adapter.updateSchema(this.schemaData);
    }
  }

  createId(id?: string) {
    return this.adapter.ID.new(id);
  }

  isValidId(id: unknown) {
    return this.adapter.ID.isValid(id);
  }

  convertStringToId<T>(id?: T) {
    return id && this.isValidId(id) ? this.adapter.ID.new(id as string) : id;
  }

  __doValidation(body: unknown) {
    return Shared.validateSchemaObject(this.schemaData, body, this.flatSchemaData);
  }

  validate(body: unknown) {
    if (body instanceof Array === false) {
      body = [body];
    }
    const validation = (body as unknown[]).map((b) => this.__doValidation(b)).filter((v) => v.isValid === false);

    return validation.length >= 1 ? validation[0] : ({ isValid: true } as const);
  }

  /**
   * @param {object} query
   * @param {object} [envFlat={}]
   * @param {object} [schemaFlat={}]
   * @return {object} query
   */
  parseQuery(
    query: Record<string, unknown>,
    envFlat: Record<string, unknown> = {},
    schemaFlat: FlattenedSchema = this.flatSchemaData,
    // A strict schema's query names only paths the schema has
    checkPaths: boolean = this.schemaData?.strict === true,
  ): ParsedQuery {
    let output: Record<string, unknown> = {};

    for (const property in query) {
      if (!Object.hasOwn(query, property)) continue;
      if (property === '__crPath') continue;
      const command = query[property];

      // @and, @or and @nor, or their $ names, take a list of queries
      if (Object.hasOwn(LOGICAL_ALIASES, property)) {
        if (!Array.isArray(command) || !command.every(isPlainObject)) throw invalidQueryValue(property, 'array');
        if (command.length > 0) {
          output[LOGICAL_ALIASES[property]] = command.map((q) => this.parseQuery(q, envFlat, schemaFlat, checkPaths));
        }
        continue;
      }
      // Any other operator's name in a property's place names no property
      if (property.startsWith('$') || property.startsWith('@')) throw unknownQueryOperator(property, property);
      if (checkPaths && !isQueryPath(schemaFlat, property)) throw unknownQueryPath(property);

      if (hasOperatorNames(command)) {
        // An operator keeps its Buttress name, in its `$` form: the query stays a Buttress query, and only the MongoDB
        // adapter gives it MongoDB's names (toMongoQuery). Every key must be one the registry knows.
        for (const operator of Object.keys(command)) {
          if (!Object.hasOwn(ALIASES, operator)) throw unknownQueryOperator(property, operator);
          output = this.parseQueryProperty(
            property,
            operatorName(operator),
            command[operator],
            output,
            envFlat,
            schemaFlat,
            checkPaths,
          );
        }
      } else {
        // A value, compared whole as MongoDB compares it: a list, an object of fields, a date
        output = this.parseQueryProperty(property, '$eq', command, output, envFlat, schemaFlat, checkPaths);
      }
    }

    return output;
  }

  /**
   * A query value, or each of a list of them, read as `type`. Null is left, to match a property with no value.
   * @param {string} property
   * @param {string} type
   * @param {unknown} operand
   * @return {unknown}
   */
  // Operators given as a value's conditions, each one the registry knows, in its `$` name
  __parseOperators(property: string, operators: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(operators).map(([operator, operand]) => {
        if (!Object.hasOwn(ALIASES, operator)) throw unknownQueryOperator(property, operator);
        return [operatorName(operator), operand];
      }),
    );
  }

  __decodeOperand(property: string, type: string, operand: unknown): unknown {
    if (Array.isArray(operand)) return operand.map((item) => this.__decodeOperand(property, type, item));
    if (operand === null || operand === undefined) return operand;

    // An id is the model's adapter's, as it's stored
    if (type === 'id') {
      if (this.isValidId(operand)) return this.convertStringToId(operand);
      throw invalidQueryValue(property, type);
    }

    const decoded = decode(type, operand);
    if (isDecodeError(decoded)) throw invalidQueryValue(property, type);
    return decoded.value;
  }

  parseQueryProperty(
    property: string,
    operator: string,
    operand: unknown,
    output: Record<string, unknown> = {},
    envFlat: Record<string, unknown> = {},
    schemaFlat: FlattenedSchema = {},
    checkPaths: boolean = false,
  ) {
    // Check to see if operand is a path and fetch value
    if (operand && (operand as string).indexOf && (operand as string).indexOf('.') !== -1) {
      const parts = (operand as string).split('.');
      const key = parts.shift();

      const path = parts.join('.');

      if (key === 'env' && envFlat[path]) {
        operand = envFlat[path];
      } else {
        // throw new Error(`Unable to find ${path} in schema.authFilter.env`);
      }
    }

    // Convert id
    let propSchema: FlattenedSchemaProperty | undefined = undefined;
    if (schemaFlat[property]) {
      propSchema = schemaFlat[property];
    } else if (Object.keys(schemaFlat).length > 0) {
      // throw Helpers.Errors.badRequest('unknown_property', `Unknown property ${property} in query`);
    }

    // What the operator is for MongoDB, which says how its operand is read
    const mongoOperator = Object.hasOwn(ALIASES, operator) ? ALIASES[operator].operator : operator;

    // An operand MongoDB couldn't take is refused, rather than failing the request when MongoDB reads it
    if (['$in', '$nin', '$all'].includes(mongoOperator) && !Array.isArray(operand)) {
      throw invalidQueryValue(property, 'array');
    }
    if (mongoOperator === '$regex') {
      // $inProp looks for text, the others for a pattern
      if (operator === '$inProp' && typeof operand !== 'string') throw invalidQueryValue(property, 'string');
      if (operator !== '$inProp' && !isPattern(operand)) throw invalidQueryValue(property, 'pattern');
    }

    if (mongoOperator === '$elemMatch') {
      if (!isPlainObject(operand)) throw invalidQueryValue(property, 'object');
      // The operators a value of the list must pass, or a query an item must match, read against the items' schema
      // An item's query is checked against the items' schema, when the array has one
      operand = hasOperatorNames(operand)
        ? this.__parseOperators(property, operand)
        : this.parseQuery(operand, envFlat, propSchema?.__schema ?? {}, checkPaths && Boolean(propSchema?.__schema));
    } else if (propSchema) {
      const itemSchema = propSchema.__schema;
      if (propSchema.__type === 'array' && itemSchema && typeof operand === 'object' && operand !== null) {
        const operands = operand as Record<string, Record<string, unknown>>;
        // An operand keyed by the items' properties has their ids converted; any other, e.g. $in's list, is left
        Object.keys(operands).forEach((op) => {
          if (itemSchema[op]?.__type === 'id' && typeof operands[op] === 'object' && operands[op] !== null) {
            Object.keys(operands[op]).forEach((key) => {
              operands[op][key] = this.convertStringToId(operands[op][key]);
            });
          }
        });
      }

      // A compared value is read as a body's would be, so a boolean or number given as text matches, and one that
      // can't be read is refused rather than compared as something else
      const type = QUERY_TYPES.has(propSchema.__type)
        ? propSchema.__type
        : propSchema.__type === 'array' && propSchema.__itemtype && QUERY_TYPES.has(propSchema.__itemtype)
          ? propSchema.__itemtype
          : undefined;
      if (type && COMPARISONS.has(mongoOperator)) operand = this.__decodeOperand(property, type, operand);
    }

    if (!output[property]) {
      output[property] = {};
    }
    const propertyOutput = output[property] as Record<string, unknown>;

    if (operator.indexOf('$') !== 0) {
      propertyOutput[`$${operator}`] = operand;
    } else {
      propertyOutput[`${operator}`] = operand;
    }

    return output;
  }

  /*
   * @param {Object} body - body passed through from a POST request
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  __parseAddBody(body: AdapterDocument, internals?: unknown): AdapterDocument {
    const entity: AdapterDocument = Object.assign({}, internals);
    const document = Shared.sanitizeSchemaObject(this.schemaData, body, this.flatSchemaData);

    if (body.id) {
      // As the schema reads it, so an id given as its `'new'` default is a new one
      entity.id = this.adapter.ID.new((document.id ?? body.id) as string);
    } else {
      entity.id = this.adapter.ID.new();
    }

    if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
      entity.createdAt = Sugar.Date.create();
      entity.updatedAt = body.updatedAt ? Sugar.Date.create(body.updatedAt as string | number | Date) : null;
    }

    return Object.assign(document, entity);
  }
  // Subclasses take their own body and internals, and can resolve to other than a stream
  add(body: unknown, internals?: unknown): Promise<unknown> {
    return this.adapter.add(body, (item) => this.__parseAddBody(item, internals));
  }

  /**
   * @param {*} select
   * @param {*} update
   * @return {promise}
   */
  update(select: AdapterQuery, update: unknown) {
    return this.adapter.update(select, update as AdapterQuery);
  }

  /**
   * @param {*} query
   * @param {*} update
   * @return {promise}
   */
  updateOne(query: AdapterQuery, update: AdapterQuery) {
    return this.adapter.updateOne(query, update);
  }

  /**
   * @param {*} id
   * @param {*} query
   * @return {promise}
   */
  updateById(id: string, query: AdapterQuery) {
    return this.adapter.updateById(id, query);
  }

  /**
   * @param {object} body
   * @return {promise}
   */
  validateUpdate(body: unknown) {
    return Shared.validateUpdate(this.schemaData, this.flatSchemaData)(body);
  }

  /**
   * @param {object} body
   * @param {string} id
   * @param {string} via - for a federated model, the agreement the record was read through (its sourceOf)
   * @return {promise}
   */
  // TODO: Model shouldn't be being passed through this way.
  async updateByPath(
    body: UpdatePathBody | UpdatePathBody[],
    id: string,
    _via: string | null = null,
  ): Promise<unknown[]> {
    if (body instanceof Array === false) {
      body = [body];
    }

    if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
      body.push({ path: 'updatedAt', value: new Date() });
    }

    const updates = body.map((update) => {
      // The update's been validated, but the server's own (updatedAt) may write a property clients can't
      const resolved = resolveUpdatePath(this.flatSchemaData, update.path);
      const kind = isUpdatePathRefusal(resolved) ? 'scalar' : resolved.kind;
      // An array given for the whole array replaces it rather than being added as one item
      const context: UpdatePathContext = {
        type: kind === 'vector-add' && Array.isArray(update.value) ? 'scalar' : kind,
        values: isUpdatePathRefusal(resolved) ? [] : resolved.values,
      };
      const schemaConfig =
        this.flatSchemaData[update.path] ?? this.flatSchemaData[update.path.replace(/\.\d+/g, '')] ?? false;

      return { body: update, context, schemaConfig };
    });

    // An adapter that can apply the request's updates together does, so they all take effect or none do.
    if (typeof this.adapter.updateByPaths === 'function') {
      return this.adapter.updateByPaths(id, updates, this);
    }

    const results: unknown[] = [];
    for (const update of updates) {
      results.push(await this.adapter.batchUpdateProcess(id, update.body, update.context, update.schemaConfig, this));
    }
    return results;
  }

  /**
   * @param {string} id
   * @param {string} via - for a federated model, the agreement the record was read through (its sourceOf)
   * @param {object} extra
   * @return {Promise}
   */
  exists(id: string, _via: string | null = null, extra: AdapterQuery = {}) {
    return this.adapter.exists(id, extra);
  }

  /**
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  isDuplicate(details: unknown) {
    return this.adapter.isDuplicate(details);
  }

  /**
   * @param {string[]} ids - ids of entities about to be added
   * @return {Promise<string[]>} - the ids among them that are already stored
   */
  findStoredIds(ids: string[]) {
    return this.adapter.findStoredIds(ids);
  }

  /**
   * @param {string} id - id to be deleted
   * @param {string} via - for a federated model, the agreement the record was read through (its sourceOf)
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  // Takes `unknown` as App takes an entity rather than its id
  rm(id: unknown, _via: string | null = null): Promise<unknown> {
    return this.adapter.rm(id as string);
  }

  /**
   * @param {Array} ids - Array of entity ids to delete
   * @param {Array} vias - for a federated model, the agreement each record was read through (its sourceOf)
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  rmBulk(ids: string[], _vias: (string | null | undefined)[] = []) {
    return this.adapter.rmBulk(ids);
  }

  /**
   * @param {Object} query - mongoDB query
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  rmAll(query?: AdapterQuery) {
    return this.adapter.rmAll(query);
  }

  /**
   * @param {String} id - entity id to get
   * @return {Promise} - resolves to an array of Companies
   */
  findById(id: string, _sourceId: string | null = null) {
    return this.adapter.findById(id) as Promise<TDocument>;
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
  find(
    query: AdapterQuery,
    excludes?: AdapterQuery | null,
    limit?: number,
    skip?: number,
    sort?: Record<string, unknown> | null,
    project?: Record<string, unknown> | null | false,
  ): AdapterFindResult {
    // TODO: Handle AC query

    return this.adapter.find(query, excludes, limit, skip, sort, project);
  }

  /**
   * @param {Object} query - mongoDB query
   * @param {Object} excludes - mongoDB query excludes
   * @return {Promise} - resolves to a single doc or null
   */
  findOne(query: AdapterQuery, excludes: AdapterQuery = {}): Promise<TDocument | null> {
    return this.adapter.findOne(query, excludes) as Promise<TDocument | null>;
  }

  /**
   * @return {Promise} - resolves to an array of Companies
   */
  findAll(): AdapterFindResult {
    return this.adapter.findAll();
  }

  /**
   * @param {Array} ids - Array of entities ids to get
   * @return {Promise} - resolves to an array of Companies
   */
  findByIds(ids: string[]) {
    return this.adapter.findAllById(ids);
  }

  /**
   * @param {Object} query - mongoDB query
   * @return {Promise} - resolves to an array of Companies
   */
  count(query?: AdapterQuery) {
    return this.adapter.count(query);
  }

  /**
   * @return {Promise}
   */
  drop() {
    return this.adapter.drop();
  }
}
