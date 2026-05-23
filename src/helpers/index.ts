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
import { Transform, TransformCallback, TransformOptions } from 'node:stream';

import * as DataSharingHelpers from './data-sharing.js';

import Datastore from '../datastore/index.js';
import { Properties, Schema, FlattenedSchema } from '../types/schema.js';

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
  prop: (prop) => (val) => val[prop],
  func: (func) => (val) => val[func](),
  nop: () => () => null,
  inject: (value) => () => value,
  arrayProp: (prop) => (arr) => arr.map((a) => a[prop]),
};
export { PromiseHelpers as Promise };

export const shortId = (id) => {
  const toBase = (num, base) => {
    const symbols = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-'.split('');
    let decimal = num;
    let temp;
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
  id = Datastore.getInstance('core').ID.new(id);

  const date = id.getTimestamp();
  let time = date.getTime();

  let counter = parseInt(id.toHexString().slice(-6), 16);
  counter = parseInt(counter.toString().slice(-3), 10);

  time = counter + time;
  output = toBase(time, 64);
  output = output.slice(3);

  return output;
};

const __flattenRoles = (data, path) => {
  if (!path) path = [];

  return data.reduce((_roles, role) => {
    const _path = path.concat(`${role.name}`);
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

export const flatternObject = (
  obj: Record<string, unknown>,
  output: { [index: string]: unknown } = {},
  paths: string[] = [],
) => {
  return Object.getOwnPropertyNames(obj).reduce(function (out, key) {
    paths.push(key);

    if (
      typeof obj[key] === 'object' &&
      obj[key] !== null &&
      Object.prototype.toString.call(obj[key]) === '[object Object]'
    ) {
      flatternObject(obj[key] as Record<string, unknown>, out, paths);
    } else if (Array.isArray(obj[key])) {
      obj[key].forEach((item, index) => {
        paths.push(index.toString());
        flatternObject(item, out, paths);
      });
    } else {
      out[paths.join('.')] = obj[key];
    }
    paths.pop();
    return out;
  }, output);
};

export const mergeDeep = (...objects) => {
  const isObject = (obj) => obj && typeof obj === 'object';

  return objects.reduce((prev, obj) => {
    Object.keys(obj).forEach((key) => {
      const pVal = prev[key];
      const oVal = obj[key];

      if (Array.isArray(pVal) && Array.isArray(oVal)) {
        prev[key] = pVal.concat(...oVal);
      } else if (isObject(pVal) && isObject(oVal)) {
        prev[key] = mergeDeep(pVal, oVal);
      } else {
        prev[key] = oVal;
      }
    });

    return prev;
  }, {});
};

export const getFlattenedSchema = (schema: Schema | Properties) => {
  const __buildFlattenedSchema = (property, parent, path, flattened) => {
    path.push(property);

    if (parent[property].__type === 'array' && parent[property].__schema) {
      // Handle Array
      for (const childProp in parent[property].__schema) {
        if (!{}.hasOwnProperty.call(parent[property].__schema, childProp)) continue;
        __buildFlattenedSchema(childProp, parent[property].__schema, path, flattened);
      }

      parent[property].__schema = getFlattenedSchema({ properties: parent[property].__schema });
      flattened[path.join('.')] = parent[property];
    } else if (typeof parent[property] === 'object' && !parent[property].__type) {
      // Handle Object
      for (const childProp in parent[property]) {
        if (!{}.hasOwnProperty.call(parent[property], childProp)) continue;
        if (childProp.indexOf('__') === 0) continue;
        __buildFlattenedSchema(childProp, parent[property], path, flattened);
      }
    } else {
      flattened[path.join('.')] = parent[property];
    }

    path.pop();
  };

  const flattened: FlattenedSchema = {};
  const path = [];

  if (schema.properties) {
    for (const property in schema.properties) {
      if (!{}.hasOwnProperty.call(schema.properties, property)) continue;
      __buildFlattenedSchema(property, schema.properties, path, flattened);
    }
  }

  return flattened;
};

export const streamFirst = <T>(stream): Promise<T> => {
  if (!(stream !== null && typeof stream === 'object' && typeof stream.pipe === 'function')) {
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
export const streamAll = <T>(stream): Promise<T[]> => {
  if (!(stream !== null && typeof stream === 'object' && typeof stream.pipe === 'function')) {
    throw new Error(`Expected Stream but got '${stream}'`);
  }

  return new Promise((resolve, reject) => {
    const arr: T[] = [];
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(arr));
    stream.on('data', (item: T) => arr.push(item));
  });
};

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

export const checkAppPolicyProperty = async (appPolicyList, policyProperties) => {
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
      [operator] = Object.keys(policyProperties[key]);
    }
    const appPolicyPropertiesValues = appPolicyList[key];
    const equalValue = operator ? policyProperties[key][operator] : policyProperties[key];
    if (equalValue === null || equalValue === undefined) {
      res.passed = false;
      res.errMessage = 'Policy property value not listed';
    }

    const appContainsProp = appPolicyPropertiesValues.every((val) => {
      if (typeof val === 'string') {
        return val.toUpperCase() !== equalValue.toUpperCase();
      }
      if (typeof val === 'boolean') {
        return val !== equalValue;
      }
      if (typeof val === 'number') {
        return val < equalValue;
      }
    });
    if (equalValue !== undefined && appContainsProp) {
      res.passed = false;
      res.errMessage = 'Policy property value not listed';
    }
  }

  return res;
};

export const updateCoreSchemaObject = (update, extendedPathContext) => {
  const __updateObjectPath = (body) => {
    const bodyPath = body.path.replace(pattern, '');
    if (!Array.isArray(body) && body.value && typeof body.value === 'object' && !Array.isArray(body.value)) {
      body = Object.keys(body.value).reduce((arr: { path: string; value: unknown }[], key) => {
        const extendedPath = `${bodyPath}.${key}`;
        if (!extendedPathContextKeys.some((key) => key.includes(extendedPath))) return arr;

        arr.push({
          path: `${body.path}.${key}`,
          value: body.value[key],
        });

        return arr;
      }, []);
    }
  };

  const extendedPathContextKeys = Object.keys(extendedPathContext);
  const pattern = /\.\d+/g;
  if (Array.isArray(update)) {
    update.forEach((item) => __updateObjectPath(item));
  } else {
    update = __updateObjectPath(update);
  }

  return update;
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

    const left = valueA instanceof Date ? valueA.getTime() : valueA;
    const right = valueB instanceof Date ? valueB.getTime() : valueB;

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

export function redisPrefix(prefix: string, key: string): string {
  if (!prefix) return key;
  if (prefix.endsWith(':')) return `${prefix}${key}`;
  return `${prefix}:${key}`;
}

export class ExpireMap extends Map {
  expireTime: number;
  gcTimeout?: NodeJS.Timeout;

  constructor(expireTime) {
    super();
    this.expireTime = expireTime;
  }

  override set(key, value) {
    super.set(key, {
      value,
      expire: Date.now() + this.expireTime,
    });

    return this;
  }

  override get(key) {
    const item = super.get(key);
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
