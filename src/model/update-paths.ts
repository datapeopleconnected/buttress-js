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

import { FlattenedSchema, FlattenedSchemaProperty } from '../types/schema.js';
import { UpdatePathContext } from '../types/datastore.js';

export type UpdateKind = UpdatePathContext['type'];

/**
 * What an update path writes to: the schema property, without array indexes (`items.sku` for `items.2.sku`), its
 * definition, how the update applies, the values a string with an `__enum` takes, and which part of the property it
 * writes: the property itself, one item of an array, or a path beneath an object property or an array item.
 */
export interface ResolvedUpdatePath {
  property: string;
  config: FlattenedSchemaProperty;
  kind: UpdateKind;
  values: unknown[];
  target: 'property' | 'item' | 'beneath';
}

// Why a path can't be updated: the schema doesn't have it, or it doesn't allow updates
export type UpdatePathRefusal = { error: 'unknown_path' | 'immutable' };

const INDEX = /^[0-9]{1,11}$/;
const INCREMENT = '__increment__';
const REMOVE = '__remove__';

// A name beneath a typed object: not empty, and not an update operation
const isPlainSegment = (segment: string) => segment !== '' && !segment.startsWith('__');

// The types a value of which can be incremented
const isIncrementable = (config: FlattenedSchemaProperty) =>
  !['string', 'object', 'date', 'array'].includes(config.__type);

/**
 * The schema key a path starts with, and the segments after it. A nested object's properties are flattened to
 * dotted keys, so the longest key that matches is the one; a flattened array's item properties are reached through
 * the array, with an index, not as their own keys.
 */
const matchKey = (schemaFlat: FlattenedSchema, segments: string[]) => {
  // The schema's own keys, not names an object has from Object.prototype
  const own = (key: string) => (Object.hasOwn(schemaFlat, key) ? schemaFlat[key] : undefined);

  for (let length = segments.length; length > 0; length--) {
    const key = segments.slice(0, length).join('.');
    if (!own(key)) continue;

    const withinArray = segments
      .slice(0, length - 1)
      .some((_, idx) => own(segments.slice(0, idx + 1).join('.'))?.__type === 'array');
    if (withinArray) continue;

    return { key, rest: segments.slice(length) };
  }
  return null;
};

const resolveSegments = (schemaFlat: FlattenedSchema, segments: string[]): ResolvedUpdatePath | UpdatePathRefusal => {
  const match = matchKey(schemaFlat, segments);
  if (!match) return { error: 'unknown_path' };

  const { key, rest } = match;
  const config = schemaFlat[key];
  if (config.__allowUpdate === false) return { error: 'immutable' };

  const resolved = (
    kind: UpdateKind,
    target: ResolvedUpdatePath['target'] = 'property',
    values: unknown[] = [],
  ): ResolvedUpdatePath => ({ property: key, config, kind, values, target });

  if (rest.length === 0) {
    if (config.__type === 'array') return resolved('vector-add');
    if (config.__type === 'string' && Array.isArray(config.__enum))
      return resolved('scalar', 'property', config.__enum);
    return resolved('scalar');
  }

  if (rest.length === 1 && rest[0] === INCREMENT && isIncrementable(config)) return resolved('scalar-increment');

  // A property typed object takes writes to paths beneath it
  if (config.__type === 'object') {
    return rest.every(isPlainSegment) ? resolved('scalar', 'beneath') : { error: 'unknown_path' };
  }

  if (config.__type !== 'array' || !INDEX.test(rest[0])) return { error: 'unknown_path' };

  // One item of the array: set, removed, or, through the item, one of its properties
  if (rest.length === 1) return resolved('scalar', 'item');
  if (rest.length === 2 && rest[1] === REMOVE) return resolved('vector-rm', 'item');
  if (config.__schema) {
    const item = resolveSegments(config.__schema, rest.slice(1));
    return 'error' in item ? item : { ...item, property: `${key}.${item.property}` };
  }
  if (config.__itemtype) return resolved('scalar', 'beneath');

  return { error: 'unknown_path' };
};

// Whether a query's path, as segments, is one the schema has
const querySegments = (schemaFlat: FlattenedSchema, segments: string[]): boolean => {
  const match = matchKey(schemaFlat, segments);
  // A nested object, compared whole, whose properties are flattened beneath it
  if (!match) return Object.keys(schemaFlat).some((key) => key.startsWith(`${segments.join('.')}.`));

  const { key, rest } = match;
  const config = schemaFlat[key];
  // A property typed object owns everything beneath it
  if (rest.length === 0 || config.__type === 'object') return true;
  if (config.__type !== 'array') return false;

  // An array's item, or, through an item (an index or every item), one of its properties
  const withinItem = INDEX.test(rest[0]) ? rest.slice(1) : rest;
  if (withinItem.length === 0) return true;
  if (config.__schema) return querySegments(config.__schema, withinItem);
  return !config.__itemtype;
};

/**
 * Whether a query's path is one the schema has: a property, a nested object or one of its properties, a path beneath
 * a property typed object, an array's item (`tags.0`) or an item's property (`lines.sku`, `lines.0.sku`), or a path
 * into the items of an array that doesn't type them. `_`-prefixed internals always are.
 * @param {Object} schemaFlat - the model's flattened schema, or an array's flattened item schema
 * @param {string} path - e.g. `lines.0.sku`
 * @return {boolean}
 */
export function isQueryPath(schemaFlat: FlattenedSchema, path: string): boolean {
  if (typeof path !== 'string' || path === '') return false;
  if (path.startsWith('_')) return true;
  return querySegments(schemaFlat, path.split('.'));
}

/**
 * What an update path writes to, and how, in the schema; or why it can't be updated.
 * @param {Object} schemaFlat - the model's flattened schema
 * @param {string} path - the update's path, e.g. `items.2.qty.__increment__`
 * @return {ResolvedUpdatePath|UpdatePathRefusal}
 */
export function resolveUpdatePath(schemaFlat: FlattenedSchema, path: string): ResolvedUpdatePath | UpdatePathRefusal {
  if (typeof path !== 'string' || path === '') return { error: 'unknown_path' };
  return resolveSegments(schemaFlat, path.split('.'));
}

export const isUpdatePathRefusal = (resolved: ResolvedUpdatePath | UpdatePathRefusal): resolved is UpdatePathRefusal =>
  'error' in resolved;
