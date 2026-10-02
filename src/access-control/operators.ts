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

import { FlattenedSchema } from '../types/schema.js';
import { isObjectId } from '../datastore/adapters/object-id.js';

/**
 * The query operators, as REST compiles them for MongoDB and as realtime matches them in memory. The in-memory match
 * decides as MongoDB does, so a policy's query reaches the same entities either way (R5, D-31).
 *
 * The query DSL and the policy language name them `$op` and `@op`; `ALIASES` gives each name's MongoDB operator, with
 * its options and how its operand is written. `matchQuery` takes a query as REST parses it: MongoDB's operators, with
 * the operands read as their properties' types (`StandardModel.parseQuery`).
 */

export type MongoOperator =
  | '$eq'
  | '$ne'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$in'
  | '$nin'
  | '$all'
  | '$exists'
  | '$regex'
  | '$elemMatch';

export interface OperatorAlias {
  operator: MongoOperator;
  // `$options` for a `$regex`
  options?: string;
  // The operand as MongoDB takes it
  operand?: (operand: unknown) => unknown;
}

// Text matched as it is, rather than as a pattern
const escapePattern = (operand: unknown) =>
  typeof operand === 'string' ? operand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : operand;

const DSL_ALIASES: Record<string, OperatorAlias> = {
  $eq: { operator: '$eq' },
  $ne: { operator: '$ne' },
  $not: { operator: '$ne' },
  $gt: { operator: '$gt' },
  $gte: { operator: '$gte' },
  $lt: { operator: '$lt' },
  $lte: { operator: '$lte' },
  $gtDate: { operator: '$gt' },
  $gteDate: { operator: '$gte' },
  $ltDate: { operator: '$lt' },
  $lteDate: { operator: '$lte' },
  $in: { operator: '$in' },
  $nin: { operator: '$nin' },
  $all: { operator: '$all' },
  $exists: { operator: '$exists' },
  // $rex is case-sensitive and $rexi isn't (D-1)
  $rex: { operator: '$regex' },
  $rexi: { operator: '$regex', options: 'i' },
  $regex: { operator: '$regex' },
  // The property holds the text
  $inProp: { operator: '$regex', operand: escapePattern },
  $elMatch: { operator: '$elemMatch' },
  $elemMatch: { operator: '$elemMatch' },
};

/**
 * Every name an operator is given by, `$op` and the policy language's `@op`, and what it is for MongoDB.
 */
export const ALIASES: Record<string, OperatorAlias> = Object.fromEntries(
  Object.entries(DSL_ALIASES).flatMap(([name, alias]) => [
    [name, alias],
    [`@${name.slice(1)}`, alias],
  ]),
);

export const LOGICAL_OPERATORS = ['$and', '$or', '$nor'] as const;

// An object of fields: not a list, a date or an id
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => key.startsWith('$'));

/**
 * The values a dotted path reaches in a document, as MongoDB reaches them: through each object of an array on the way
 * (or the item a numeric segment names), and at the end an array as well as each of its items. Nothing for a path the
 * document hasn't got.
 */
const valuesAt = (value: unknown, segments: string[]): unknown[] => {
  if (segments.length < 1) {
    if (value === undefined) return [];
    return Array.isArray(value) ? [value, ...value] : [value];
  }

  const [head, ...rest] = segments;
  if (Array.isArray(value)) {
    const byIndex = /^\d+$/.test(head) ? valuesAt(value[Number(head)], rest) : [];
    return [...byIndex, ...value.flatMap((item) => (isPlainObject(item) ? valuesAt(item[head], rest) : []))];
  }
  return isPlainObject(value) ? valuesAt(value[head], rest) : [];
};

// An id is its hex string, as ids are outside the MongoDB adapter
const asCompared = (value: unknown) => (isObjectId(value) ? value.toHexString() : value);

// MongoDB compares values of one type only: numbers with numbers, text with text, dates with dates...
const typeOf = (value: unknown) =>
  value === null
    ? 'null'
    : value instanceof Date
      ? 'date'
      : Array.isArray(value)
        ? 'array'
        : typeof value === 'object'
          ? 'object'
          : typeof value;

const isEqual = (x: unknown, y: unknown): boolean => {
  const [a, b] = [asCompared(x), asCompared(y)];
  const type = typeOf(a);
  if (type !== typeOf(b)) return false;
  if (type === 'date') return (a as Date).getTime() === (b as Date).getTime();
  if (type === 'array') {
    const [x, y] = [a as unknown[], b as unknown[]];
    return x.length === y.length && x.every((item, idx) => isEqual(item, y[idx]));
  }
  if (type === 'object') {
    const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
    const keys = Object.keys(x);
    return (
      keys.length === Object.keys(y).length &&
      keys.every((key, idx) => Object.keys(y)[idx] === key && isEqual(x[key], y[key]))
    );
  }
  return a === b;
};

// The order of two values of one type, or null for values MongoDB doesn't compare
const order = (x: unknown, y: unknown): number | null => {
  const [a, b] = [asCompared(x), asCompared(y)];
  const type = typeOf(a);
  if (type !== typeOf(b)) return null;
  if (type === 'number' || type === 'string' || type === 'boolean') {
    return a === b ? 0 : (a as number) > (b as number) ? 1 : -1;
  }
  if (type === 'date') return Math.sign((a as Date).getTime() - (b as Date).getTime());
  return null;
};

// A field equal to the operand: one of its values is, and null for a field that's null or that it hasn't got
const equals = (values: unknown[], operand: unknown) =>
  operand === null ? values.length < 1 || values.includes(null) : values.some((value) => isEqual(value, operand));

const compares = (values: unknown[], operand: unknown, passes: (order: number) => boolean, orEqualNull: boolean) => {
  if (operand === null) return orEqualNull && equals(values, null);
  return values.some((value) => {
    const result = order(value, operand);
    return result !== null && passes(result);
  });
};

const asList = (operand: unknown): unknown[] => (Array.isArray(operand) ? operand : [operand]);

// Whether one item of an array matches an $elemMatch: as a document, or as a value its operators test
const itemMatches = (item: unknown, query: Record<string, unknown>) =>
  isOperatorObject(query) ? matchOperators([item], query) : isPlainObject(item) && matchQuery(query, item);

/**
 * Whether a field's values (from `valuesAt`) pass each of an operator object's operators, all of them.
 */
const matchOperators = (values: unknown[], operators: Record<string, unknown>): boolean =>
  Object.entries(operators).every(([operator, operand]) => {
    switch (operator) {
      case '$eq':
        return equals(values, operand);
      case '$ne':
        return !equals(values, operand);
      case '$gt':
        return compares(values, operand, (r) => r > 0, false);
      case '$gte':
        return compares(values, operand, (r) => r >= 0, true);
      case '$lt':
        return compares(values, operand, (r) => r < 0, false);
      case '$lte':
        return compares(values, operand, (r) => r <= 0, true);
      case '$in':
        return asList(operand).some((item) => equals(values, item));
      case '$nin':
        return !asList(operand).some((item) => equals(values, item));
      case '$all':
        return asList(operand).every((item) => equals(values, item));
      case '$exists':
        return values.length > 0 === Boolean(operand);
      case '$regex': {
        const pattern = new RegExp(String(operand), typeof operators.$options === 'string' ? operators.$options : '');
        return values.some((value) => typeof value === 'string' && pattern.test(value));
      }
      case '$options':
        return true;
      case '$elemMatch':
        return (
          isPlainObject(operand) &&
          values.some((value) => Array.isArray(value) && value.some((item) => itemMatches(item, operand)))
        );
      default:
        // An operator nothing knows matches nothing, rather than everything
        return false;
    }
  });

/**
 * Whether a document matches a query as MongoDB would decide: each field's condition and each logical operator, all
 * of them. The query is as `StandardModel.parseQuery` gives it, and the document's values as `asQueried` reads them.
 * @param {object} query
 * @param {object} document
 * @return {boolean}
 */
export function matchQuery(query: Record<string, unknown>, document: unknown): boolean {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$and') return asList(condition).every((part) => matchQuery(part as Record<string, unknown>, document));
    if (key === '$or') return asList(condition).some((part) => matchQuery(part as Record<string, unknown>, document));
    if (key === '$nor') return !asList(condition).some((part) => matchQuery(part as Record<string, unknown>, document));
    if (key.startsWith('$')) return false;

    const values = valuesAt(document, key.split('.'));
    return isOperatorObject(condition) ? matchOperators(values, condition) : equals(values, condition);
  });
}

/**
 * An entity as realtime has it, its JSON, with its dates read as dates, so it's matched as it's stored. A date
 * that can't be read is left as it is.
 * @param {object} entity
 * @param {FlattenedSchema} schemaFlat
 * @return {object}
 */
export function asQueried(entity: unknown, schemaFlat: FlattenedSchema): unknown {
  const read = (value: unknown, flat: FlattenedSchema, prefix: string): unknown => {
    if (Array.isArray(value)) return value.map((item) => read(item, flat, prefix));
    if (!isPlainObject(value)) return value;

    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => {
        const path = `${prefix}${key}`;
        const config = flat[path];
        if (config?.__type === 'date' || (config?.__type === 'array' && config.__itemtype === 'date')) {
          return [key, asDate(field)];
        }
        if (config?.__type === 'array' && config.__schema) return [key, read(field, config.__schema, '')];
        if (config?.__type === 'object') return [key, field];
        return [key, read(field, flat, `${path}.`)];
      }),
    );
  };
  return read(entity, schemaFlat, '');
}

const asDate = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(asDate);
  if (typeof value !== 'string') return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
};
