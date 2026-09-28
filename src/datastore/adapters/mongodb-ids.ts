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
import { ObjectId } from 'mongodb';

import type { Properties } from '../../types/schema.js';
import { isObjectId } from './object-id.js';

// Query operators whose values are never ids, even under an id property
const NON_ID_OPERATORS = new Set(['$regex', '$options', '$exists', '$type', '$size', '$mod']);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// A path with array indexes and operators ($in, $push, $elemMatch, ...) dropped, e.g. `$set.auth.0.appId` -> `auth.appId`
const normalisePath = (path: string) =>
  path
    .split('.')
    .filter((part) => part !== '' && !part.startsWith('$') && !/^\d+$/.test(part))
    .join('.');

// The paths of a schema's id properties, walking nested objects and the item schemas of arrays. Works on both the
// raw and the flattened form of an array's `__schema`.
const collectIdPaths = (properties: Properties | undefined, prefix = '', paths = new Set<string>()) => {
  if (!properties) return paths;

  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (key.startsWith('__') || !isPlainObject(value)) continue;
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof value.__type !== 'string') {
      collectIdPaths(value as Properties, path, paths);
      continue;
    }

    if (value.__type === 'id' || (value.__type === 'array' && value.__itemtype === 'id')) paths.add(path);
    if (value.__type === 'array' && isPlainObject(value.__schema)) {
      collectIdPaths(value.__schema as Properties, path, paths);
    }
  }

  return paths;
};

/**
 * Ids are strings everywhere outside this adapter, and ObjectIds in MongoDB. This converts between the two, going by
 * the schema: properties with `__type: 'id'`, arrays with `__itemtype: 'id'`, and each document's own `id`.
 */
export default class MongodbIds {
  private _idPaths = new Set<string>();

  setSchema(properties: Properties | undefined) {
    this._idPaths = collectIdPaths(properties);
  }

  isIdPath(path: string) {
    const normalised = normalisePath(path);
    return normalised === 'id' || normalised === '_id' || this._idPaths.has(normalised);
  }

  /**
   * Returns a copy of a document, query or update with the id strings under id properties as ObjectIds, and a
   * top-level `id` as `_id`. Strings that aren't valid ids are left alone, except for a top-level `id`, which throws.
   */
  toStored<T>(value: T): T {
    return this._toStored(value, '') as T;
  }

  /**
   * Converts every ObjectId in a stored document to a string, and its `_id` to `id`, in place.
   */
  fromStored<T>(doc: T): T {
    if (!isPlainObject(doc)) return doc;

    const document: Record<string, unknown> = doc;
    if (document._id) {
      document.id = document._id;
      delete document._id;
    }
    this._stringify(document);

    return doc;
  }

  private _toStored(value: unknown, path: string): unknown {
    if (typeof value === 'string') return this.isIdPath(path) && ObjectId.isValid(value) ? new ObjectId(value) : value;
    if (Array.isArray(value)) return value.map((item) => this._toStored(item, path));
    if (!isPlainObject(value)) return value;

    const atRoot = normalisePath(path) === '';
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (NON_ID_OPERATORS.has(key)) {
        output[key] = child;
      } else if (atRoot && key === 'id' && child) {
        output._id = typeof child === 'string' ? new ObjectId(child) : this._toStored(child, '_id');
      } else {
        output[key] = this._toStored(child, path ? `${path}.${key}` : key);
      }
    }

    return output;
  }

  private _stringify(value: Record<string, unknown> | unknown[]) {
    const keys = Array.isArray(value) ? value.keys() : Object.keys(value);
    for (const key of keys) {
      const child: unknown = (value as Record<string | number, unknown>)[key];
      if (isObjectId(child)) {
        (value as Record<string | number, unknown>)[key] = child.toHexString();
      } else if (Array.isArray(child) || isPlainObject(child)) {
        this._stringify(child);
      }
    }
  }
}
