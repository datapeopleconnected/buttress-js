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
import { Readable, Transform, TransformCallback, TransformOptions } from 'node:stream';
import { ObjectId } from 'bson';

import * as DataSharingHelpers from './data-sharing.js';

import Datastore from '../datastore/index.js';
import { isObjectId } from '../datastore/adapters/object-id.js';
import { Properties, FlattenedSchema, FlattenedSchemaProperty } from '../types/schema.js';

export const DataSharing = DataSharingHelpers;

export * as Errors from './errors.js';

export * as Schema from './schema.js';

export * as Stream from './stream.js';

export class Timer {
  private _start: number;
  private _last: number;

  constructor() {
    this._start = 0;
    this._last = 0;
  }

  start() {
    const hrTime = process.hrtime();
    this._last = this._start = hrTime[0] * 1000000 + hrTime[1] / 1000;
  }

  get lapTime() {
    const hrTime = process.hrtime();
    const time = hrTime[0] * 1000000 + hrTime[1] / 1000;
    const lapTime = time - this._last;
    this._last = time;
    return lapTime / 1000000;
  }
  get interval() {
    const hrTime = process.hrtime();
    const time = hrTime[0] * 1000000 + hrTime[1] / 1000;
    return (time - this._start) / 1000000;
  }
}

// The stages reported in a Server-Timing header, each timed from its own mark in RequestContext.timings to the next.
const SERVER_TIMING_STAGES: { name: string; desc?: string; from: string; to: string }[] = [
  { name: 'auth', desc: 'token', from: 'authenticateToken', to: 'accessControl' },
  { name: 'ac', desc: 'access control', from: 'accessControl', to: 'configCrossDomain' },
  { name: 'validate', from: 'validate', to: 'exec' },
  { name: 'exec', from: 'exec', to: 'respond' },
];

/**
 * Builds a Server-Timing header value, in milliseconds, from a request's timing marks (seconds since it started).
 * A stage missing either of its marks is left out. `total` runs to the start of the response, so it doesn't include
 * sending a streamed body.
 */
export const serverTimingHeader = (timings: Record<string, unknown>) => {
  const mark = (name: string) => {
    const value = timings[name];
    return typeof value === 'number' ? value : null;
  };
  const ms = (seconds: number) => (seconds * 1000).toFixed(3);

  const metrics = SERVER_TIMING_STAGES.flatMap(({ name, desc, from, to }) => {
    const start = mark(from);
    const end = mark(to);
    if (start === null || end === null) return [];
    return [`${name};dur=${ms(end - start)}${desc ? `;desc="${desc}"` : ''}`];
  });

  const respond = mark('respond');
  if (respond !== null) metrics.push(`total;dur=${ms(respond)};desc="until response"`);

  return metrics.join(', ');
};

export class JSONStringifyStream extends Transform {
  private _first: boolean;
  private prepare: (chunk: unknown) => unknown;

  constructor(options: TransformOptions, prepare: (chunk: unknown) => unknown) {
    super(Object.assign(options || {}, { objectMode: true }));

    if (!prepare || typeof prepare !== 'function') throw new Error('JSONStringifyStream requires a prepare function');

    this._first = true;
    this.prepare = prepare;
  }

  override _transform(chunk: unknown, encoding: BufferEncoding, cb: TransformCallback) {
    void encoding;
    chunk = this.prepare(chunk);

    // Dont return any blank objects
    if (chunk === null || (typeof chunk === 'object' && Object.keys(chunk).length < 1)) return cb();

    // Stringify the object thats come in and strip any keys/props which are prefixed with a underscore
    const str = JSON.stringify(chunk);

    if (this._first) {
      this._first = false;
      this.push(`[`);
      this.push(`${str}\n`);
    } else {
      this.push(`,${str}\n`);
    }

    cb();
  }

  override _flush(cb: TransformCallback) {
    if (this._first) {
      this._first = false;
      this.push('[');
    }

    this.push(']');
    cb();
  }
}

const PromiseHelpers = {
  prop:
    (prop: string) =>
    <T extends object>(val: T) =>
      val[prop as keyof T],
  func: (func: string) => (val: Record<string, () => unknown>) => val[func](),
  nop: () => () => null,
  inject:
    <T>(value: T) =>
    () =>
      value,
  arrayProp:
    (prop: string) =>
    <T extends object>(arr: T[]) =>
      arr.map((a) => a[prop as keyof T]),
};
export { PromiseHelpers as Promise };

export const shortId = (id: string) => {
  const toBase = (num: number, base: number) => {
    const symbols = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-'.split('');
    let decimal = num;
    let temp: number;
    let output = '';

    if (base > symbols.length || base <= 1) {
      throw new RangeError(`Radix must be less than ${symbols.length} and greater than 1`);
    }

    while (decimal > 0) {
      temp = Math.floor(decimal / base);
      output = symbols[decimal - base * temp] + output;
      decimal = temp;
    }

    return output;
  };

  let output = '';
  if (!id) return output;

  // HACK: need to make sure the id is in the correct format to extract the timestamp
  const objectId = new ObjectId(Datastore.getInstance('core').ID.new(id));

  const date = objectId.getTimestamp();
  let time = date.getTime();

  let counter = parseInt(objectId.toHexString().slice(-6), 16);
  counter = parseInt(counter.toString().slice(-3), 10);

  time = counter + time;
  output = toBase(time, 64);
  output = output.slice(3);

  return output;
};

export interface RoleNode {
  name: string;
  roles?: RoleNode[];
  [key: string]: unknown;
}

const __flattenRoles = (data: RoleNode[], path?: string[]): RoleNode[] => {
  if (!path) path = [];
  const parentPath = path;

  return data.reduce((_roles: RoleNode[], role) => {
    const _path = parentPath.concat(`${role.name}`);
    if (role.roles && role.roles.length > 0) {
      return _roles.concat(__flattenRoles(role.roles, _path));
    }

    const flatRole = Object.assign({}, role);
    flatRole.name = _path.join('.');
    _roles.push(flatRole);
    return _roles;
  }, []);
};
export const flattenRoles = __flattenRoles;

export const flattenedObject = (
  obj: unknown,
  output: { [index: string]: unknown } = {},
  paths: string[] = [],
): { [index: string]: unknown } => {
  if (obj === null || typeof obj !== 'object') {
    return output;
  }

  // NOTE: returns obj itself rather than output here, callers only pass other objects at the top level
  if (obj instanceof Date || isObjectId(obj)) {
    return (output[paths.join('.')] = obj) as unknown as { [index: string]: unknown };
  }

  Object.getOwnPropertyNames(obj).forEach((key) => {
    const value = (obj as Record<string, unknown>)[key];
    const currentPath = [...paths, key];

    if (Array.isArray(value)) {
      if (value.length < 1) {
        output[currentPath.join('.')] = value;
      } else {
        value.forEach((item: unknown, index) => {
          const arrayPath = [...currentPath, index.toString()];
          if (!item || typeof item !== 'object' || item instanceof Date || isObjectId(item)) {
            output[arrayPath.join('.')] = item;
          } else {
            flattenedObject(item, output, arrayPath);
          }
        });
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenedObject(value, output, currentPath);
    } else {
      output[currentPath.join('.')] = value;
    }
  });

  return output;
};

// export const flattenedObject = (obj, output: { [index: string]: any } = {}, paths: string[] = []) => {
//   return Object.getOwnPropertyNames(obj).reduce(function (out, key) {
//     paths.push(key);

//     if (typeof obj[key] === 'object' && obj[key] !== null && obj[key] === '[object Object]') {
//       flattenedObject(obj[key], out, paths);
//     } else if (Array.isArray(obj[key])) {
//       obj[key].forEach((item, index) => {
//         paths.push(index.toString());
//         flattenedObject(item, out, paths);
//       });
//     } else {
//       out[paths.join('.')] = obj[key];
//     }
//     paths.pop();
//     return out;
//   }, output);
// };

export const mergeDeep = <T extends object>(...objects: T[]): T => {
  const isObject = (obj: unknown): obj is Record<string, unknown> => !!obj && typeof obj === 'object';

  return objects.reduce((prev: Record<string, unknown>, obj) => {
    Object.keys(obj).forEach((key) => {
      const pVal = prev[key];
      const oVal = (obj as Record<string, unknown>)[key];

      if (Array.isArray(pVal) && Array.isArray(oVal)) {
        prev[key] = pVal.concat(...oVal);
      } else if (isObject(pVal) && isObject(oVal)) {
        prev[key] = mergeDeep(pVal, oVal);
      } else {
        prev[key] = oVal;
      }
    });

    return prev;
  }, {}) as T;
};

/**
 * The schema's properties keyed by their dotted paths. An array's `__schema` is given flattened in the result, and
 * its item properties are also listed beneath the array's key (`items.sku`). The schema itself is left as it is.
 */
export const getFlattenedSchema = (schema: { properties?: Properties }) => {
  const __buildFlattenedSchema = (property: string, parent: Properties, path: string[], flattened: FlattenedSchema) => {
    path.push(property);

    const prop: Record<string, unknown> = parent[property];
    if (prop.__type === 'array' && prop.__schema) {
      // Handle Array
      const arraySchema = prop.__schema as Properties;
      for (const childProp in arraySchema) {
        if (!{}.hasOwnProperty.call(arraySchema, childProp)) continue;
        __buildFlattenedSchema(childProp, arraySchema, path, flattened);
      }

      flattened[path.join('.')] = {
        ...prop,
        __schema: getFlattenedSchema({ properties: arraySchema }),
      } as FlattenedSchemaProperty;
    } else if (typeof prop === 'object' && !prop.__type) {
      // Handle Object
      const nested = prop as Properties;
      for (const childProp in nested) {
        if (!{}.hasOwnProperty.call(nested, childProp)) continue;
        if (childProp.indexOf('__') === 0) continue;
        __buildFlattenedSchema(childProp, nested, path, flattened);
      }
    } else {
      flattened[path.join('.')] = prop as FlattenedSchemaProperty;
    }

    path.pop();
  };

  const flattened: FlattenedSchema = {};
  const path: string[] = [];

  if (schema.properties) {
    for (const property in schema.properties) {
      if (!{}.hasOwnProperty.call(schema.properties, property)) continue;
      __buildFlattenedSchema(property, schema.properties, path, flattened);
    }
  }

  return flattened;
};

const isStream = (stream: unknown): stream is Readable =>
  stream !== null && typeof stream === 'object' && typeof (stream as Readable).pipe === 'function';

export const streamFirst = <T>(stream: unknown): Promise<T> => {
  if (!isStream(stream)) {
    throw new Error(`Expected Stream but got '${stream}'`);
  }

  return new Promise((resolve, reject) => {
    stream.on('error', (err) => reject(err));
    stream.on('end', () => reject(new Error('Stream ended without data')));
    stream.on('data', (item: T) => {
      stream.destroy();
      resolve(item);
    });
  });
};
export const streamAll = <T>(stream: unknown): Promise<T[]> => {
  if (!isStream(stream)) {
    throw new Error(`Expected Stream but got '${stream}'`);
  }

  return new Promise((resolve, reject) => {
    const arr: T[] = [];
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(arr));
    stream.on('data', (item: T) => arr.push(item));
  });
};

/**
 * Whether a token's domains are a list of non-empty strings. The cross-domain check matches each one against the
 * request's origin.
 */
export const isDomainList = (domains: unknown): domains is string[] =>
  Array.isArray(domains) && domains.every((domain) => typeof domain === 'string' && domain.trim() !== '');

export const trimSlashes = (str: string) => {
  return str ? str.replace(/^\/+|\/+$/g, '') : str;
};

export const awaitAll = async <T>(arr: T[], handler: (item: T) => Promise<unknown>) => {
  return await Promise.all(arr.map(async (item) => await handler(item)));
};
export const awaitForEach = async <T>(arr: T[], handler: (item: T) => Promise<void>) => {
  await arr.reduce(async (prev, item) => {
    await prev;
    await handler(item);
  }, Promise.resolve());
};

type PolicyPropertyValue = string | number | boolean | null;

export const checkAppPolicyProperty = async (
  appPolicyList: Record<string, PolicyPropertyValue | PolicyPropertyValue[]> | null | undefined,
  policyProperties: Record<string, unknown>,
) => {
  const res: {
    passed: boolean;
    errMessage: string;
  } = {
    passed: true,
    errMessage: '',
  };

  if (!appPolicyList) {
    res.passed = false;
    res.errMessage = 'The app does not include a policy property list';
    return res;
  }

  const appPolicyPropertiesKeys = Object.keys(appPolicyList);
  for await (const key of Object.keys(policyProperties)) {
    if (!appPolicyPropertiesKeys.includes(key)) {
      res.passed = false;
      res.errMessage = 'Policy property key not listed';
      continue;
    }

    let operator: string | null = null;
    if (typeof policyProperties[key] === 'object') {
      [operator] = Object.keys(policyProperties[key] as object);
    }
    // The app's list holds the allowed values for each key
    const appPolicyPropertiesValues = ([] as PolicyPropertyValue[]).concat(appPolicyList[key]);
    const equalValue = operator ? (policyProperties[key] as Record<string, unknown>)[operator] : policyProperties[key];
    if (equalValue === null || equalValue === undefined) {
      res.passed = false;
      res.errMessage = 'Policy property value not listed';
    }

    // Only a value exactly as the app lists it (D-34)
    const isListed = (value: unknown) => appPolicyPropertiesValues.some((val) => val === value);
    // An array, as an operator like @in takes, is listed when every value in it is
    const values = Array.isArray(equalValue) ? equalValue : [equalValue];
    if (equalValue !== undefined && (values.length < 1 || !values.every(isListed))) {
      res.passed = false;
      res.errMessage = 'Policy property value not listed';
    }
  }

  return res;
};

/**
 * Whether a policy's selection names only properties and values `appPolicyList` lists, each key checked as
 * checkAppPolicyProperty checks it. `@and` and `@or` must hold a list of one or more selections, each checked the same
 * way. A selection with no keys names nothing, and passes.
 * @param {object} appPolicyList - the app's policy property list
 * @param {object} selection
 * @return {Promise<{passed: boolean, errMessage: string}>}
 */
export const checkPolicySelection = async (
  appPolicyList: Record<string, PolicyPropertyValue | PolicyPropertyValue[]> | null | undefined,
  selection: Record<string, unknown>,
): Promise<{ passed: boolean; errMessage: string }> => {
  for (const [key, criteria] of Object.entries(selection)) {
    if (key === '@and' || key === '@or') {
      const isSelection = (branch: unknown) =>
        typeof branch === 'object' && branch !== null && !Array.isArray(branch) && Object.keys(branch).length > 0;
      if (!Array.isArray(criteria) || criteria.length < 1 || !criteria.every(isSelection)) {
        return { passed: false, errMessage: `${key} takes a list of selections` };
      }

      for (const branch of criteria as Record<string, unknown>[]) {
        const res = await checkPolicySelection(appPolicyList, branch);
        if (!res.passed) return res;
      }
      continue;
    }

    const res = await checkAppPolicyProperty(appPolicyList, { [key]: criteria });
    if (!res.passed) return res;
  }

  return { passed: true, errMessage: '' };
};

export const compareByProps = (
  compareProperties: Map<string, number>,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
) => {
  for (const key of compareProperties.keys()) {
    const sortOrder = compareProperties.get(key) || 1;

    // TODO: path resolution.
    const valueA = a && a[key] ? a[key] : null;
    const valueB = b && b[key] ? b[key] : null;

    // ObjectIds (and id strings) are normalised to strings so the string-comparison branch
    // below can order them - otherwise they fall through every branch and are treated as tied,
    // which silently breaks the default id-based sort when merging federated result streams.
    const left =
      valueA instanceof Date
        ? valueA.getTime()
        : valueA !== null && ObjectId.isValid(valueA as string)
          ? (valueA as ObjectId).toString()
          : valueA;
    const right =
      valueB instanceof Date
        ? valueB.getTime()
        : valueB !== null && ObjectId.isValid(valueB as string)
          ? (valueB as ObjectId).toString()
          : valueB;

    if (left === null && right === null) continue;
    if (left === null) return -1 * sortOrder;
    if (right === null) return 1 * sortOrder;

    if (typeof left === 'string' && typeof right === 'string') {
      if (left < right) return -1 * sortOrder;
      if (left > right) return 1 * sortOrder;
      continue;
    }

    if (typeof left === 'number' && typeof right === 'number') {
      if (left < right) return -1 * sortOrder;
      if (left > right) return 1 * sortOrder;
    }
  }

  return 0;
};

export const get = function (path: string, root: unknown): unknown {
  const parts = path.toString().split('.');
  let prop: unknown = root;

  for (let i = 0; i < parts.length; i += 1) {
    if (!prop) return undefined;
    const part = parts[i];
    if (prop instanceof Map) {
      prop = prop.get(part);
      continue;
    }

    if (typeof prop === 'object' && prop !== null) {
      prop = (prop as Record<string, unknown>)[part];
      continue;
    }

    return undefined;
  }

  return prop;
};

export interface NormalizedThrownError {
  message: string;
  name?: string;
  stack?: string;
  raw?: unknown;
}

const getStringProperty = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' ? prop : undefined;
};

export const normalizeThrownError = (err: unknown): NormalizedThrownError => {
  if (err instanceof Error) {
    return {
      message: err.message || 'Unknown error',
      name: err.name,
      stack: err.stack,
      raw: err,
    };
  }

  const objectMessage = getStringProperty(err, 'errMessage') || getStringProperty(err, 'message');
  if (objectMessage) {
    return {
      message: objectMessage,
      name: getStringProperty(err, 'name'),
      stack: getStringProperty(err, 'stack'),
      raw: err,
    };
  }

  if (typeof err === 'string') {
    return {
      message: err,
      raw: err,
    };
  }

  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return {
      message: String(err),
      raw: err,
    };
  }

  return {
    message: 'Unknown error',
    raw: err,
  };
};

export const getThrownErrorMessage = (err: unknown): string => {
  return normalizeThrownError(err).message;
};

export interface ThrownErrorDetails {
  message: string;
  code?: string;
  httpStatus?: number;
  retryable?: boolean;
  errors?: Array<{ code?: string; message?: string; path?: string }>;
}

export const getThrownErrorDetails = (err: unknown): ThrownErrorDetails => {
  const normalized = normalizeThrownError(err);
  const raw = normalized.raw as Record<string, unknown> | undefined;
  return {
    message: normalized.message,
    code: typeof raw?.code === 'string' ? raw.code : undefined,
    httpStatus: typeof raw?.httpStatus === 'number' ? raw.httpStatus : undefined,
    retryable: typeof raw?.retryable === 'boolean' ? raw.retryable : undefined,
    errors: Array.isArray(raw?.errors) ? (raw.errors as ThrownErrorDetails['errors']) : undefined,
  };
};

export function redisPrefix(prefix: string, key: string): string {
  if (!prefix) return key;
  if (prefix.endsWith(':')) return `${prefix}${key}`;
  return `${prefix}:${key}`;
}

// Values are stored wrapped with their expiry time, so the Map's own iterators return the wrappers.
export class ExpireMap<K = unknown, V = unknown> extends Map<K, unknown> {
  expireTime: number;
  gcTimeout?: NodeJS.Timeout;

  constructor(expireTime: number) {
    super();
    this.expireTime = expireTime;
  }

  override set(key: K, value: V) {
    super.set(key, {
      value,
      expire: Date.now() + this.expireTime,
    });

    return this;
  }

  override get(key: K): V | undefined {
    const item = super.get(key) as { value: V; expire: number } | undefined;
    if (!item) return undefined;

    if (item.expire < Date.now()) {
      this.delete(key);
      return undefined;
    }

    return item.value;
  }

  // This is dumb
  destroy() {
    if (this.gcTimeout) clearTimeout(this.gcTimeout);
    this.clear();
  }

  _gc() {
    this.gcTimeout = setTimeout(() => {
      for (const key of this.keys()) {
        this.get(key);
      }

      this._gc();
    }, this.expireTime);
  }
}
