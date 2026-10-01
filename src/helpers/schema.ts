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

import Logging from './logging.js';
import Sugar from './sugar.js';

import Errors from './errors.js';
import { decode as decodeValue, isDecodeError } from './codecs.js';

import Plugins from '../plugins/index.js';
import Datastore from '../datastore/index.js';

import { FlattenedSchema, Properties, PropertyDefinition, Schema } from '../types/schema.js';

import { v4 as uuidv4 } from 'uuid';

export type { Schema };

/**
 * A single value from a body, keyed by its dotted path.
 */
export interface FlattenedBodyProperty {
  path: string;
  value: unknown;
}

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

/* ********************************************************************************
 *
 * SCHEMA HELPERS
 *
 **********************************************************************************/
const __getFlattenedBody = (body: unknown) => {
  const bodyObj = body as Record<string, unknown>;
  const __buildFlattenedBody = (
    property: string,
    parent: Record<string, unknown>,
    path: string[],
    flattened: FlattenedBodyProperty[],
  ) => {
    if (/^_/.test(property)) return; // ignore internals
    path.push(property);

    if (
      typeof parent[property] !== 'object' ||
      parent[property] instanceof Date ||
      Array.isArray(parent[property]) ||
      parent[property] === null ||
      Datastore.getInstance('core').ID.instanceOf(bodyObj[property])
    ) {
      flattened.push({
        path: path.join('.'),
        value: parent[property],
      });
      path.pop();
      return;
    }

    const child = parent[property] as Record<string, unknown>;

    // Treat an empty object as null
    if (typeof child === 'object') {
      const keys = Object.keys(child);
      if (keys.length < 1) {
        flattened.push({
          path: path.join('.'),
          value: null,
        });
      }
    }

    for (const childProp in child) {
      if (!{}.hasOwnProperty.call(child, childProp)) continue;
      __buildFlattenedBody(childProp, child, path, flattened);
    }

    path.pop();
    return;
  };

  const flattened: FlattenedBodyProperty[] = [];
  const path: string[] = [];
  for (const property in bodyObj) {
    if (!{}.hasOwnProperty.call(bodyObj, property)) continue;
    __buildFlattenedBody(property, bodyObj, path, flattened);
  }

  return flattened;
};
export const getFlattenedBody = __getFlattenedBody;

const __getObjProperty = (obj: unknown, path: string) => {
  const parts = path.split('.');

  let current = obj;
  parts.forEach((part) => {
    if (!current) return;
    if (current && typeof current === 'object' && current !== null && (current as Record<string, unknown>)[part]) {
      current = (current as Record<string, unknown>)[part];
    } else {
      current = undefined;
    }
  });

  return current;
};

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
          const length = 36;
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
          const mask = 0x3d;

          const bytes = crypto.randomBytes(length);
          let str = '';
          for (let x = 0; x < bytes.length; x++) {
            const byte = bytes[x];
            str += chars[byte & mask];
          }
          res = str;
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
 * Whether `prop.value` is a value of the property's type, which it's converted to in place, through the type's codec.
 * A null value has no type to check.
 */
const __validateProp = (prop: { value?: unknown }, config: PropertyConfig) => checkProp(prop, config) === null;

/**
 * As validateProp, but gives the issue with the value, or null when it's valid.
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
export const validateProp = __validateProp;

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

const __validate = (
  schema: FlattenedSchema,
  values: FlattenedBodyProperty[],
  parentProperty: string,
  body?: unknown,
): SchemaValidationResult => {
  const bodyObj = body as Record<string, unknown> | undefined;
  const res: SchemaValidationResult = {
    isValid: true,
    missing: [],
    invalid: [],
    issues: [],
  };

  for (const property in schema) {
    if (!{}.hasOwnProperty.call(schema, property)) continue;
    let propVal = values.find((v) => v.path === property);
    const config = schema[property];

    const path = property.split('.');
    let isSubPropOfArray = false;
    if (path.length > 1) {
      path.reduce((prev, next, idx, arr) => {
        const np = idx !== 0 ? `${prev}.${next}` : next;
        if (idx !== arr.length - 1 && schema[np] && schema[np].__type === 'array') {
          isSubPropOfArray = true;
        }
        return np;
      }, '');
    }
    if (isSubPropOfArray) continue;

    if (propVal === undefined || (propVal && propVal.value === config.__default)) {
      // NOTE: This feels wrong
      if (bodyObj && bodyObj[property] && schema && schema[property] && schema[property].__type === 'object') {
        const bodyValue = bodyObj[property] as Record<string, unknown>;
        const definedObjectKeys = Object.keys(schema)
          .filter((key) => key !== property)
          .map((v) => v.replace(`${property}.`, ''));
        const blankObjectValues = Object.keys(bodyValue).reduce((arr: Record<string, unknown>, key) => {
          if (!definedObjectKeys.includes(key) || property !== key) {
            arr[key] = bodyValue[key];
          }

          return arr;
        }, {});

        if (blankObjectValues) {
          values.push({
            path: property,
            value: blankObjectValues,
          });
        } else {
          values.push({
            path: property,
            value: __getPropDefault(config),
          });
        }
        continue;
      }

      if (config.__required && propVal === undefined && (config.__default === null || config.__default === undefined)) {
        res.isValid = false;
        Logging.logWarn(`Missing required ${property}`);
        res.missing.push(`${parentProperty}${property}`);
        res.issues.push({ path: `${parentProperty}${property}`, code: 'required' });
        continue;
      }

      const defaultValue = __getPropDefault(config);
      if (bodyObj && propVal && propVal.value === config.__default) {
        bodyObj[property] = defaultValue;
      }

      propVal = {
        path: property,
        value: defaultValue,
      };
      values.push(propVal);
    }

    const given = propVal.value;
    const issue = checkProp(propVal, config, `${parentProperty}${property}`);
    if (issue) {
      Logging.logWarn(`Invalid ${property}: ${given} [${typeof given}]`);
      res.isValid = false;
      res.invalid.push(`${parentProperty}${property}:${given}[${typeof given}]`);
      res.issues.push(issue);
      continue;
    }

    if (config.__type === 'array' && config.__schema) {
      const itemSchema = config.__schema;
      // validateProp has checked it's an array (or null)
      (propVal.value as unknown[]).forEach((v, idx) => {
        const notObject = describeNonObjectItem(`${parentProperty}${property}.${idx}`, v);
        if (notObject) {
          res.isValid = false;
          res.invalid.push(notObject);
          res.issues.push({
            path: `${parentProperty}${property}.${idx}`,
            code: 'type',
            expected: 'object',
            received: describeType(v),
          });
          return;
        }

        const itemRes = __validate(itemSchema, __getFlattenedBody(v), `${parentProperty}${property}.${idx}.`, v);
        if (itemRes.isValid) return;

        res.isValid = false;
        res.missing = res.missing.concat(itemRes.missing);
        res.invalid = res.invalid.concat(itemRes.invalid);
        res.issues = res.issues.concat(itemRes.issues);
      });
    } else if (config.__type === 'array' && config.__itemtype) {
      const items = propVal.value as unknown[];
      for (const idx in items) {
        if (!{}.hasOwnProperty.call(items, idx)) continue;
        const nullItem = describeNullItem(`${parentProperty}${property}.${idx}`, items[idx], config.__itemtype);
        const itemPath = `${parentProperty}${property}.${idx}`;
        if (nullItem) {
          res.isValid = false;
          res.invalid.push(nullItem);
          res.issues.push({ path: itemPath, code: 'type', expected: config.__itemtype, received: 'null' });
          continue;
        }
        const prop = {
          value: items[idx],
        };
        const itemIssue = checkProp(prop, { __type: config.__itemtype }, itemPath);
        if (itemIssue) {
          res.issues.push(itemIssue);
          Logging.logWarn(
            `Invalid ${property}.${idx}: ${prop.value} [${typeof prop.value}] expected [${config.__itemtype}]`,
          );
          res.isValid = false;
          res.invalid.push(
            `${parentProperty}${property}.${idx}:${prop.value}[${typeof prop.value}] [${config.__itemtype}]`,
          );
        }
        items[idx] = prop.value;
      }
    }
  }

  return res;
};
export const validate = __validate;

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

// `path` is consumed (shifted) as the object is inflated.
const __inflateObject = (parent: unknown, path: string[], value: unknown): unknown => {
  if (path.length === 0) {
    parent = value;
    return parent;
  }

  const parentObj = parent as Record<string, unknown>;
  if (path.length > 1) {
    const parentKey = path.shift() as string;
    if (!parentObj[parentKey]) {
      parentObj[parentKey] = {};
    }
    __inflateObject(parentObj[parentKey], path, value);
    return parentObj;
  }

  parentObj[path.shift() as string] = value;
  return parentObj;
};

function __unflattenObject(data: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const i of Object.keys(data)) {
    const keys = i.split('.');
    keys.reduce(function (r: Record<string, unknown>, e, j) {
      return (r[e] || (r[e] = isNaN(Number(keys[j + 1])) ? (keys.length - 1 == j ? data[i] : {}) : [])) as Record<
        string,
        unknown
      >;
    }, result);
  }
  return result;
}
export const unflattenObject = __unflattenObject;

// TODO: Need to handle flatterned array paths
// TODO: Shared has simliar code, this may be a duplicate
/**
 * @param {Object} schemaFlat - a flatterned schema
 * @param {Array} values - Array of values, path/value
 * @param {Object} body
 * @return {Object} - A fully populated object using schema defaults and values provided.
 */
export const sanitizeObject = (schemaFlat: FlattenedSchema, values: FlattenedBodyProperty[], body: unknown = null) => {
  const res: Record<string, unknown> = {};
  const objects: Record<string, unknown> = {};

  for (const property in schemaFlat) {
    if (!{}.hasOwnProperty.call(schemaFlat, property)) continue;
    let propVal: Partial<FlattenedBodyProperty> | undefined = values.find((v) => v.path === property);
    const config = schemaFlat[property];

    if (property === 'source') {
      // Source is a special case, we don't actually want it in our objects that get saved
      // as Buttress adds this property to objects to give the client ha hit on whhere the
      // object came from.
      continue;
    }

    const path = property.split('.');
    let isSubPropOfArray = false;
    if (path.length > 1) {
      path.reduce((prev, next, idx, arr) => {
        const np = idx !== 0 ? `${prev}.${next}` : next;
        if (idx !== arr.length - 1 && schemaFlat[np] && schemaFlat[np].__type === 'array') {
          isSubPropOfArray = true;
        }
        return np;
      }, '');
    }
    if (isSubPropOfArray) continue;

    const root = path.shift();

    if (body && propVal === undefined && schemaFlat[property].__type === 'object') {
      const getChild = (obj: unknown, str: string) => (obj as Record<string, unknown> | undefined)?.[str];
      const value = property.split('.').reduce(getChild, body);
      propVal = {};
      propVal.path = property.split('.').pop();
      propVal.value = value ? value : __getPropDefault(config);
    }

    if (propVal === undefined) {
      propVal = {
        path: property,
        value: __getPropDefault(config),
      };
    }

    if (propVal === undefined) continue;
    __validateProp(propVal, config);

    let value = propVal.value;
    if (config.__type === 'array' && config.__schema) {
      const itemSchema = config.__schema;
      if (!body || !__getObjProperty(body, property)) {
        value = [];
      } else {
        value = (value as unknown[]).map((item) => sanitizeArrayItem(itemSchema, item));
        if (root && property.split('.').length > 1) {
          objects[root] = __inflateObject(objects[root], path, value);
          value = objects[root];
        }
      }
    } else if ((root && path.length > 0) || schemaFlat[property].__type === 'object') {
      if (!root) throw new Error("root is required but condition wasn't set to handle it being undefined");
      if (!objects[root]) {
        objects[root] = {};
      }
      objects[root] = __inflateObject(objects[root], path, value);
      value = objects[root];
    }

    if (root !== undefined) res[root] = value;
  }
  return res;
};

/**
 * Cleans one item of an array that has an item `__schema`. The item is also passed as the body, so object properties
 * keep their values as they do when a whole entity is added.
 */
export const sanitizeArrayItem = (itemSchemaFlat: FlattenedSchema, item: unknown) =>
  sanitizeObject(itemSchemaFlat, __getFlattenedBody(item), item);

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
