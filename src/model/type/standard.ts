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
import { AdapterDocument, AdapterQuery, UpdatePathBody } from '../../types/datastore.js';
import { FlattenedSchema, FlattenedSchemaProperty } from '../../types/schema.js';

// The types a compared query value is read as, and the operators that compare
const QUERY_TYPES = new Set(['boolean', 'number', 'uuid', 'date', 'id']);
const COMPARISONS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$all']);

const invalidQueryValue = (property: string, type: string) =>
  Helpers.Errors.badRequest('invalid_value', `The value for ${property} is not a valid ${type}`, {
    path: property,
    expected: type,
  });

// A query after parseQuery, with each property's operators resolved to their datastore form
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
    return Shared.validateSchemaObject(this.schemaData, body);
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
  ): ParsedQuery {
    let output: Record<string, unknown> = {};

    for (const property in query) {
      if (!{}.hasOwnProperty.call(query, property)) continue;
      if (property === '__crPath') continue;
      const command = query[property];

      if (property === '$or' && Array.isArray(command)) {
        if (command.length > 0) {
          output['$or'] = (command as Record<string, unknown>[]).map((q) => this.parseQuery(q, envFlat, schemaFlat));
        }
      } else if ((property === '$and' || property === '$nor') && Array.isArray(command)) {
        if (command.length > 0) {
          output[property] = (command as Record<string, unknown>[]).map((q) => this.parseQuery(q, envFlat, schemaFlat));
        }
      } else if (typeof command === 'object' && command !== null && !this.isValidId(command)) {
        const operators = command as Record<string, unknown>;
        for (let operator in operators) {
          if (!{}.hasOwnProperty.call(operators, operator)) continue;
          let operand = operators[operator];
          let operandOptions: string | undefined = undefined;

          switch (operator) {
            case '$not':
              operator = '$ne';
              break;

            case '$elMatch':
              operator = '$elemMatch';
              break;
            case '$gtDate':
              operator = '$gt';
              break;
            case '$ltDate':
              operator = '$lt';
              break;
            case '$gteDate':
              operator = '$gte';
              break;
            case '$lteDate':
              operator = '$lte';
              break;

            // $rex is case-sensitive and $rexi isn't, as in the SPR, policy selection and crag.
            case '$rex':
              operator = '$regex';
              break;
            case '$rexi':
              operator = '$regex';
              operandOptions = 'i';
              break;
            // The property holds the text, which is matched as it is
            case '$inProp':
              operator = '$regex';
              if (typeof operand === 'string') operand = operand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              break;

            default:
            // TODO: Throw an error if operator isn't supported
          }

          output = this.parseQueryProperty(property, operator, operand, operandOptions, output, envFlat, schemaFlat);
        }
      } else {
        // Direct compare
        output = this.parseQueryProperty(property, '$eq', command, null, output, envFlat, schemaFlat);
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
    operandOptions?: string | null,
    output: Record<string, unknown> = {},
    envFlat: Record<string, unknown> = {},
    schemaFlat: FlattenedSchema = {},
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

    if (operator === '$elemMatch' && propSchema && propSchema.__schema) {
      operand = this.parseQuery(operand as Record<string, unknown>, envFlat, propSchema.__schema);
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
      if (type && COMPARISONS.has(operator)) operand = this.__decodeOperand(property, type, operand);
    }

    if (!output[property]) {
      output[property] = {};
    }
    const propertyOutput = output[property] as Record<string, unknown>;

    if (operandOptions) {
      propertyOutput[`$options`] = operandOptions;
    }

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

    if (body.id) {
      entity.id = this.adapter.ID.new(body.id as string);
    } else {
      entity.id = this.adapter.ID.new();
    }

    if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
      entity.createdAt = Sugar.Date.create();
      entity.updatedAt = body.updatedAt ? Sugar.Date.create(body.updatedAt as string | number | Date) : null;
    }

    return Object.assign(Shared.sanitizeSchemaObject(this.schemaData, body), entity);
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
    const sharedFn = Shared.validateUpdate({}, this.schemaData);
    return sharedFn(body);
  }

  /**
   * @param {object} body
   * @param {string} id
   * @param {string} sourceId
   * @param {string} model
   * @return {promise}
   */
  // TODO: Model shouldn't be being passed through this way.
  async updateByPath(
    body: UpdatePathBody | UpdatePathBody[],
    id: string,
    _sourceId: string | null = null,
  ): Promise<unknown[]> {
    if (body instanceof Array === false) {
      body = [body];
    }

    if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
      body.push({
        path: 'updatedAt',
        value: new Date(),
        contextPath: '^updatedAt$',
      });
    }

    // const schema = __getCollectionSchema(collectionName);
    const flattenedSchema = this.schemaData ? Helpers.getFlattenedSchema(this.schemaData) : false;
    const extendedPathContext = Shared.extendPathContext({}, flattenedSchema || {}, '');

    const updates = body.map((update) => {
      let config = flattenedSchema === false ? false : flattenedSchema[update.path];
      if (!config && flattenedSchema) {
        config = flattenedSchema[update.path.replace(/\.\d+/g, '')];
      }

      // If we're doing a vector-add operation but the user has provided an array as the value then we want to
      // update the whole property.
      // The update's been validated, so it has a context path.
      let context = extendedPathContext[update.contextPath as string];
      if (context.type === 'vector-add' && Array.isArray(update.value)) {
        context = { type: 'scalar', values: [] };
      }

      return { body: update, context, schemaConfig: config };
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
   * @param {string} sourceId
   * @param {object} extra
   * @return {Promise}
   */
  exists(id: string, _sourceId: string | null = null, extra: AdapterQuery = {}) {
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
   * @param {string} sourceId - used by federated models
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  // Takes `unknown` as App takes an entity rather than its id
  rm(id: unknown, _sourceId: string | null = null): Promise<unknown> {
    return this.adapter.rm(id as string);
  }

  /**
   * @param {Array} ids - Array of entity ids to delete
   * @param {Array} sourceIds - the source of each, used by federated models
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  rmBulk(ids: string[], _sourceIds: (string | null | undefined)[] = []) {
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
