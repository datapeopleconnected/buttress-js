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
import crypto from 'node:crypto';

import Sugar from './sugar.js';

import Errors from './errors.js';
import Logging from './logging.js';
import { decode as decodeValue, isDecodeError } from './codecs.js';

import Plugins from '../plugins/index.js';
import Datastore from '../datastore/index.js';

import { FlattenedSchema, Properties, PropertyDefinition, Schema } from '../types/schema.js';

import { v4 as uuidv4 } from 'uuid';

export type { Schema };

/**
 * One problem with a body or an update: the path it's at, what's wrong (`required`, `type`, `enum`,
 * `unknown_path`), what was expected, and the type of what was given. The value itself isn't kept, as it can be a
 * secret.
 */
export interface ValidationIssue {
  path: string;
  code: string;
  expected?: unknown;
  received?: string;
}

export interface SchemaValidationResult {
  isValid: boolean;
  missing: string[];
  invalid: string[];
  issues: ValidationIssue[];
}

// The parts of a schema property that are used to default and validate a value.
interface PropertyConfig {
  __type?: string;
  __default?: unknown;
  __enum?: unknown[];
}

const RANDOM_STRING_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A cryptographically random string of letters and digits, each picked evenly from all 62 of them.
 * @param {number} length
 * @return {string}
 */
export const randomString = (length = 36) => {
  let str = '';
  for (let x = 0; x < length; x++) str += RANDOM_STRING_CHARS[crypto.randomInt(RANDOM_STRING_CHARS.length)];
  return str;
};

/* ********************************************************************************
 *
 * SCHEMA HELPERS
 *
 **********************************************************************************/
const __getPropDefault = (config: PropertyConfig) => {
  let res: unknown;
  switch (config.__type) {
    default:
    case 'boolean':
      res = config.__default === undefined ? false : config.__default;
      break;
    case 'string':
      if (config.__default !== null || config.__default !== undefined) {
        if (config.__default === 'randomString') {
          res = randomString();
        } else {
          res = config.__default;
        }
      }
      break;
    case 'number':
      res = config.__default === undefined ? 0 : config.__default;
      break;
    case 'array':
      res = config.__default === undefined ? [] : config.__default;
      break;
    case 'object':
      res = config.__default === undefined ? {} : config.__default;
      break;
    case 'id':
      if (config.__default) {
        if (config.__default === 'new') {
          res = Datastore.getInstance('core').ID.new();
        } else {
          res = config.__default;
        }
      } else {
        res = null;
      }
      break;
    case 'uuid':
      if (config.__default) {
        if (config.__default === 'new') {
          res = uuidv4();
        } else {
          res = config.__default;
        }
      } else {
        res = null;
      }
      break;
    case 'date':
      if (config.__default === null) {
        res = null;
      } else if (config.__default) {
        res = Sugar.Date.create(config.__default as string | number | Date);
      } else {
        res = new Date();
      }
  }
  return res;
};
export const getPropDefault = __getPropDefault;

/**
 * Reads `prop.value` as the property's type, through the type's codec, converting it in place. Gives the issue with
 * the value, or null when it's valid. A null value has no type to check.
 * @param {object} prop - `{value}`, converted in place
 * @param {object} config - the property's schema
 * @param {string} path - where the value is, for the issue
 * @return {ValidationIssue|null}
 */
export const checkProp = (
  prop: { value?: unknown },
  config: PropertyConfig,
  path: string = '',
): ValidationIssue | null => {
  if (prop.value === null) return null;

  const decoded = decodeValue(config.__type, prop.value, config);
  if (isDecodeError(decoded)) {
    return decoded.error === 'enum'
      ? { path, code: 'enum', expected: config.__enum, received: describeType(prop.value) }
      : { path, code: 'type', expected: config.__type, received: describeType(prop.value) };
  }

  prop.value = decoded.value;
  return null;
};

// The type of a value as an issue gives it
export const describeType = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : value instanceof Date ? 'date' : typeof value;

const describeItemType = (item: unknown) => (item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item);

/**
 * An item of an array with an item `__schema` has to be an object, and null isn't one. Gives the invalid value to
 * report for an item at `path` that isn't one, or null if it is.
 */
export const describeNonObjectItem = (path: string, item: unknown) => {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) return null;

  return `${path}:${item}[${describeItemType(item)}] [object]`;
};

/**
 * An item of an array with an `__itemtype` can't be null, though a property of that type can. Gives the invalid value
 * to report for a null item at `path`, or null if the item isn't null.
 */
export const describeNullItem = (path: string, item: unknown, itemtype: string) =>
  item === null ? `${path}:null[null] [${itemtype}]` : null;

const __prepareSchemaResult = (result: unknown, sourceId: string | null = null, projection: boolean = false) => {
  const _prepare = (chunk: unknown, path: string | null): unknown => {
    if (!chunk) return chunk;

    if (path) {
      if (path.indexOf('_') === 0) return undefined;
    }

    if (typeof chunk === 'object') {
      if (Datastore.getInstance('core').ID.isValid(chunk)) return chunk;
      if (chunk instanceof Date) return chunk;

      const obj: Record<string, unknown> = Object.assign({}, chunk as Record<string, unknown>);

      // If no path is provided then we're dealing with a root object.
      if (!path) {
        // If there's no sourceId, then it's an object from us.
        if (!obj.sourceId && sourceId) obj.sourceId = sourceId;
      }

      // NOT GOOD
      // if (token && token.type === 'app') return chunk;
      // if (token && token.type === 'dataSharing') return chunk;

      if (projection) {
        // TODO: Make a pass on the projections
      }

      for (const key in obj) {
        if (!{}.hasOwnProperty.call(obj, key)) continue;
        const value = obj[key];
        obj[key] = Array.isArray(value) ? value.map((c: unknown) => _prepare(c, key)) : _prepare(value, key);

        // We've done some processing, if we're left with undefined, remove it.
        if (obj[key] === undefined) delete obj[key];
      }

      return obj;
    }

    return chunk;
  };

  return Array.isArray(result) ? result.map((c: unknown) => _prepare(c, null)) : _prepare(result, null);
};
export const prepareSchemaResult = __prepareSchemaResult;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// `value` without the property at `segments`, through any arrays on the way, as a copy where anything is left out
const omitPath = (value: unknown, segments: string[]): unknown => {
  if (Array.isArray(value)) return value.map((item) => omitPath(item, segments));
  if (!isPlainRecord(value) || segments.length < 1) return value;

  const [head, ...rest] = segments;
  if (!(head in value)) return value;
  if (rest.length < 1) {
    const { [head]: _omitted, ...others } = value;
    return others;
  }
  return { ...value, [head]: omitPath(value[head], rest) };
};

/**
 * A result without its schema's `__private` properties, e.g. a user's `auth.password`, for a response. What it's
 * given isn't changed.
 * @param {unknown} result - an entity, or a list of them
 * @param {string[][]} privatePaths - each private property's path, split into its segments
 * @return {unknown}
 */
export const stripPrivate = (result: unknown, privatePaths: string[][]): unknown =>
  privatePaths.reduce((value, segments) => omitPath(value, segments), result);

/**
 * An update's results, `{type, path, value}` each as updateByPath gives them, without what they'd show of the schema's
 * `__private` properties: a result at or beneath one is left out, and one above it has it taken out of its value.
 * What it's given isn't changed.
 * @param {unknown[]} changes
 * @param {string[][]} privatePaths - each private property's path, split into its segments
 * @return {unknown[]}
 */
export const stripPrivateChanges = (changes: unknown[], privatePaths: string[][]): unknown[] =>
  changes.flatMap((change) => {
    if (!isPlainRecord(change) || typeof change.path !== 'string') return [change];

    // Array indexes and the increment suffix aren't part of the property's name
    const segments = change.path
      .replace(/\.__increment__$/, '')
      .split('.')
      .filter((segment) => !/^\d+$/.test(segment));
    const startsWith = (path: string[], prefix: string[]) =>
      prefix.length <= path.length && prefix.every((segment, idx) => segment === path[idx]);

    if (privatePaths.some((privatePath) => startsWith(segments, privatePath))) return [];

    const value = privatePaths
      .filter((privatePath) => startsWith(privatePath, segments))
      .reduce((given, privatePath) => omitPath(given, privatePath.slice(segments.length)), change.value);
    return [value === change.value ? change : { ...change, value }];
  });

const __getSchemaKeys = (obj: FlattenedSchema): string[] => {
  return Object.keys(obj).reduce((arr: string[], key) => {
    if (obj[key].__type === 'object') {
      arr.push(key);
    }

    if (obj[key].__type === 'array' && obj[key].__itemtype === 'object') {
      arr.push(key);
    }

    const itemSchema = obj[key].__schema;
    if (obj[key].__type === 'array' && itemSchema) {
      arr = arr.concat(__getSchemaKeys(itemSchema));
    }

    return arr;
  }, []);
};
export const getSchemaKeys = __getSchemaKeys;

export const validTypes = ['collection', 'template'];

export const encode = (obj: unknown) => {
  return JSON.stringify(obj);
  // return JSON.parse(Schema.encodeKey(JSON.stringify(obj)));
};

export const decode = (obj: string): Schema[] => {
  return JSON.parse(obj) as Schema[];
  // return JSON.parse(Schema.decodeKey(JSON.stringify(obj)));
};

/**
 * An app's stored schema, or null when it can't be read: when it isn't JSON or isn't a list. That's logged, naming the
 * app, so a caller going through every app can pass over this one rather than stop the apps after it getting theirs.
 * Anything else that fails is rethrown.
 */
export const decodeStored = (app: { id: string; __schema: string }): Schema[] | null => {
  let decoded: unknown;
  try {
    decoded = decode(app.__schema);
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError)) throw err;
    Logging.logWarn(`Unable to read the stored schema of app ${app.id}: ${err.message}`);
    return null;
  }
  if (!Array.isArray(decoded)) {
    Logging.logWarn(`Unable to read the stored schema of app ${app.id}: it isn't a list`);
    return null;
  }

  return decoded as Schema[];
};

export const encodeKey = (key: string) => {
  return key.replace(/\\/g, '\\\\').replace(/\$/g, '\\u0024').replace(/\./g, '\\u002e');
};

export const decodeKey = (key: string) => {
  return key
    .replace(/\\u002e/g, '.')
    .replace(/\\u0024/g, '$')
    .replace(/\\\\/g, '\\');
};

export const routeToModel = (name: string) => {
  if (!name) return;

  return name
    .split('/')
    .map((part) => Sugar.String.camelize(part, false))
    .join('-');
};

export const modelToRoute = (name: string) => {
  if (!name) return;

  return name
    .split('-')
    .map((part) => Sugar.String.dasherize(part))
    .join('/');
};

export const buildCollections = async (schemas: Schema[]): Promise<Schema[]> => {
  const builtSchemas = await build(schemas);
  return builtSchemas.filter((s) => s.type.indexOf('collection') === 0);
};

export const build = async (schemas: Schema[]): Promise<Schema[]> => {
  schemas = await Plugins.apply_filters('before_schema_build', schemas);
  schemas = schemas.map((schema) => {
    schema.properties = schema.properties || {};
    schema.properties.id = { __type: 'id', __default: 'new', __allowUpdate: false };
    schema.properties.sourceId = { __type: 'id', __allowUpdate: false };
    return extend(schemas, schema);
  });
  for await (const schema of schemas) {
    const res = await createTimeSeriesSchema(schema.name, schema.properties);
    if (!res) continue;
    Object.keys(res).forEach((key) => {
      schemas.push(res[key]);
    });
  }
  schemas = await Plugins.apply_filters('after_schema_build', schemas);
  return schemas;
};

export const merge = (schemasA: Schema[], schemasB: Schema[]): Schema[] => {
  schemasB.forEach((cS) => {
    const appSchemaIdx = schemasA.findIndex((s) => s.name === cS.name);
    const schema = schemasA[appSchemaIdx];
    if (!schema) {
      return schemasA.push(cS);
    }
    schema.properties = Object.assign(schema.properties, cS.properties);
    schemasA[appSchemaIdx] = schema;
  });

  return schemasA;
};

export const extend = (schemas: Schema[], schema: Schema): Schema => {
  if (schema.extends) {
    schema.extends
      // We'll filter out any schema that's prefix with a plugin name
      .filter((dependencyName) => dependencyName.indexOf(':') === -1)
      .forEach((dependencyName) => {
        const dependencyIdx = schemas.findIndex((s) => s.name === dependencyName);
        // This should be thrown when the user adds or updates the schema.
        if (dependencyIdx === -1) {
          throw new Errors.SchemaInvalid(`Schema dependency ${dependencyName} for ${schema.name} missing.`);
        }
        const dependency = extend(schemas, schemas[dependencyIdx]);
        if (!dependency.properties) return; // Skip if dependency has no properties
        if (!schema.properties) schema.properties = {};
        // The schema's own properties must win over ones it inherits via `extends`.
        schema.properties = Object.assign({}, dependency.properties, schema.properties);
      });
  }

  return schema;
};

export const createTimeSeriesSchema = async (
  schemaName: string,
  schemaProps: Properties,
  timeSeries: Record<string, Schema> = {},
): Promise<Record<string, Schema> | false> => {
  if (!schemaProps || Object.keys(schemaProps).length < 1) return false;

  for await (const prop of Object.keys(schemaProps)) {
    if (typeof schemaProps[prop] !== 'object') continue;
    const propSchema = schemaProps[prop] as PropertyDefinition;
    if (propSchema.__type && propSchema.__type === 'array') continue;

    if (propSchema.__timeSeries) {
      if (!timeSeries[propSchema.__timeSeries]) {
        timeSeries[propSchema.__timeSeries] = {
          name: `${schemaName}-${propSchema.__timeSeries}`,
          type: 'collection',
          extends: ['timestamps'],
          properties: {
            entityId: {
              __type: 'string',
              __default: null,
              __required: true,
              __allowUpdate: false,
            },
          },
        };
      }
      const timesSeriesObj = Object.assign({}, propSchema);
      delete timesSeriesObj.__timeSeries;
      timeSeries[propSchema.__timeSeries].properties[prop] = timesSeriesObj;
      continue;
    }

    if (!propSchema.__type) {
      await createTimeSeriesSchema(schemaName, schemaProps[prop] as Properties, timeSeries);
    }
  }

  if (Object.keys(timeSeries).length < 1) return false;
  return timeSeries;
};
