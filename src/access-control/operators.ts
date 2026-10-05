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
 * The query operators. A Buttress query, the query DSL a client sends and a partner is sent, and the policy language,
 * names them `$op` or `@op`; `StandardModel.parseQuery` checks one and reads its values, and gives it back in those
 * names. MongoDB's own query is made from it only where it's needed, by `toMongoQuery`: in the MongoDB adapter, and for
 * `matchQuery`, which decides in memory as MongoDB does, so a policy's query reaches the same entities in realtime as
 * on REST (R5, D-31).
 *
 * `ALIASES` gives each name its MongoDB operator, with its options and how its operand is written.
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
  // Compares dates. A query reads them by the property's type; the policy language, which has no schema, by this
  date?: true;
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
  $gtDate: { operator: '$gt', date: true },
  $gteDate: { operator: '$gte', date: true },
  $ltDate: { operator: '$lt', date: true },
  $lteDate: { operator: '$lte', date: true },
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

// A lookup that has only the names given it, so a name such as `constructor` isn't found on Object.prototype
const lookup = <T>(entries: [string, T][]): Record<string, T> =>
  Object.assign(Object.create(null) as Record<string, T>, Object.fromEntries(entries));

/**
 * Every name an operator is given by, `$op` and the policy language's `@op`, and what it is for MongoDB.
 */
export const ALIASES: Record<string, OperatorAlias> = lookup(
  Object.entries(DSL_ALIASES).flatMap(([name, alias]): [string, OperatorAlias][] => [
    [name, alias],
    [`@${name.slice(1)}`, alias],
  ]),
);

export const LOGICAL_OPERATORS = ['$and', '$or', '$nor'] as const;

/**
 * Every name a logical operator is given by, `$op` and the policy language's `@op`, and what it is for MongoDB.
 */
export const LOGICAL_ALIASES: Record<string, (typeof LOGICAL_OPERATORS)[number]> = lookup(
  LOGICAL_OPERATORS.flatMap((operator): [string, (typeof LOGICAL_OPERATORS)[number]][] => [
    [operator, operator],
    [`@${operator.slice(1)}`, operator],
  ]),
);

// An object of fields: not a list, a date or an id
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => key.startsWith('$'));

/**
 * Whether what an $elemMatch takes is the operators a value of the list must pass (`{$gt: 1}`), rather than a query an
 * item must match (`{sku: 'a'}`, `{$or: [...]}`): every key an operator's name, `$op` or `@op`, and none a logical
 * operator's.
 */
export const isValueOperators = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every(
    (key) => (key.startsWith('$') || key.startsWith('@')) && !Object.hasOwn(LOGICAL_ALIASES, key),
  );

// A document's own field, not a name an object has from Object.prototype
const ownField = (document: Record<string, unknown>, name: string) =>
  Object.hasOwn(document, name) ? document[name] : undefined;

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
    return [...byIndex, ...value.flatMap((item) => (isPlainObject(item) ? valuesAt(ownField(item, head), rest) : []))];
  }
  return isPlainObject(value) ? valuesAt(ownField(value, head), rest) : [];
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
  isValueOperators(query) ? matchOperators([item], query) : isPlainObject(item) && matchQuery(query, item);

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
      case '$all': {
        // MongoDB's $all of an empty list matches nothing
        const list = asList(operand);
        return list.length > 0 && list.every((item) => equals(values, item));
      }
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
 * Whether an object a Buttress query gives a property is its operators: one of its keys is an operator's name, `$op`
 * or `@op`. An object without one is a value, compared whole as MongoDB compares it.
 */
export const hasOperatorNames = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) && Object.keys(value).some((key) => key.startsWith('$') || key.startsWith('@'));

/**
 * The first operator a Buttress query names that the registry doesn't know, with the property it's given, or null. A
 * name with an operator's prefix in a property's place must be a logical operator; its path is its own name.
 * @param {object} query
 * @return {object|null} - `{path, operator}`
 */
export function findUnknownOperator(query: Record<string, unknown>): { path: string; operator: string } | null {
  for (const [key, condition] of Object.entries(query)) {
    if (Object.hasOwn(LOGICAL_ALIASES, key)) {
      for (const part of Array.isArray(condition) ? condition : []) {
        const found = isPlainObject(part) ? findUnknownOperator(part) : null;
        if (found) return found;
      }
      continue;
    }
    if (key.startsWith('$') || key.startsWith('@')) return { path: key, operator: key };
    if (!hasOperatorNames(condition)) continue;

    for (const [operator, operand] of Object.entries(condition)) {
      if (!Object.hasOwn(ALIASES, operator)) return { path: key, operator };
      if (ALIASES[operator].operator !== '$elemMatch' || !isPlainObject(operand)) continue;

      // An item's query, or the operators a value must pass
      const found = isValueOperators(operand) ? findUnknownOperator({ [key]: operand }) : findUnknownOperator(operand);
      if (found) return found;
    }
  }
  return null;
}

// An object of operators in a Buttress query: every key an operator's name, `$op` or `@op`
const isButtressOperators = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => key.startsWith('$') || key.startsWith('@'));

// One field's condition in MongoDB's terms: a value is left as it is, an object of fields included
const toMongoCondition = (condition: unknown): unknown => {
  if (!isButtressOperators(condition)) return condition;

  const output: Record<string, unknown> = {};
  for (const [name, operand] of Object.entries(condition)) {
    const alias = Object.hasOwn(ALIASES, name) ? ALIASES[name] : undefined;
    // A name the registry doesn't have is the datastore's own, such as $options
    if (!alias) {
      output[name] = operand;
      continue;
    }

    if (alias.operator === '$elemMatch' && isPlainObject(operand)) {
      output.$elemMatch = isValueOperators(operand) ? toMongoCondition(operand) : toMongoQuery(operand);
    } else {
      output[alias.operator] = alias.operand ? alias.operand(operand) : operand;
    }
    if (alias.options) output.$options = alias.options;
  }
  return output;
};

/**
 * A Buttress query in MongoDB's terms, as the MongoDB adapter gives it MongoDB: each operator by MongoDB's name, with
 * its options and its operand as MongoDB takes them (`$rexi` is `$regex` with `$options: 'i'`, `$not` is `$ne`,
 * `$gtDate` is `$gt`), and `@and`, `@or` and `@nor` as `$and`, `$or` and `$nor`. Values are left as they are.
 * @param {object} query - as `StandardModel.parseQuery` gives it
 * @return {object}
 */
export function toMongoQuery(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).map(([key, condition]) => {
      const logical = Object.hasOwn(LOGICAL_ALIASES, key) ? LOGICAL_ALIASES[key] : undefined;
      if (!logical) return [key, toMongoCondition(condition)];

      const parts = Array.isArray(condition)
        ? condition.map((part) => (isPlainObject(part) ? toMongoQuery(part) : part))
        : condition;
      return [logical, parts];
    }),
  );
}

/**
 * Whether a document matches a query as MongoDB would decide: each field's condition and each logical operator, all
 * of them. The query is MongoDB's (`toMongoQuery` of what `StandardModel.parseQuery` gives), and the document's values
 * as `asQueried` reads them.
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
        const config = Object.hasOwn(flat, path) ? flat[path] : undefined;
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
