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

import type { ValidationIssue } from '../helpers/schema.js';
import type { UpdatePathBody } from '../types/datastore.js';
import { describeType } from '../helpers/schema.js';
import { ALIASES, hasOperatorNames, isValueOperators, LOGICAL_ALIASES, operandProblem } from './operators.js';

// The verbs a config can grant: a request's method, or all of them
const VERBS = ['GET', 'QUERY', 'SEARCH', 'POST', 'PUT', 'DELETE', '%ALL%'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// An optional field that, given, must be an object
const checkOptionalObject = (value: unknown, path: string): ValidationIssue[] =>
  value === undefined || value === null || isPlainObject(value) ? [] : [{ path, code: 'type', expected: 'object' }];

// A logical operator's list: one or more queries, or conditions
const isPartsList = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.length > 0 && value.every((part) => isPlainObject(part));

// The problem with an operator's operand, at its property's path: one it can't take (operandProblem, as a search's is
// checked). An #env value is read when the policy is, so it isn't checked here
const operandIssues = (operator: string, operand: unknown, path: string): ValidationIssue[] => {
  if (typeof operand === 'string' && operand.startsWith('#env.')) return [];
  const expected = operandProblem(operator, operand);
  return expected ? [{ path, code: 'type', expected }] : [];
};

/**
 * The problems with a policy's query, at its properties' paths: an operator nothing knows, an operand an operator can't
 * take, or a logical operator not given a list of one or more queries. A search's query is refused for each of them,
 * and a stored policy's query with one grants nothing (R3 step 7).
 * @param {Object} query
 * @param {string} path - the query's, e.g. `config.2.query`
 * @return {ValidationIssue[]}
 */
const queryIssues = (query: Record<string, unknown>, path: string): ValidationIssue[] =>
  Object.entries(query).flatMap(([key, condition]): ValidationIssue[] => {
    if (Object.hasOwn(LOGICAL_ALIASES, key)) {
      if (!isPartsList(condition)) return [{ path: `${path}.${key}`, code: 'type', expected: 'array' }];
      return condition.flatMap((part) => queryIssues(part, path));
    }
    // Any other name with an operator's prefix names no property
    if (key.startsWith('$') || key.startsWith('@')) {
      return [{ path: `${path}.${key}`, code: 'unknown_operator', received: key }];
    }
    // A value, compared whole
    if (!hasOperatorNames(condition)) return [];

    return Object.entries(condition).flatMap(([operator, operand]): ValidationIssue[] => {
      if (!Object.hasOwn(ALIASES, operator)) {
        return [{ path: `${path}.${key}`, code: 'unknown_operator', received: operator }];
      }
      const issues = operandIssues(operator, operand, `${path}.${key}`);
      if (issues.length > 0 || ALIASES[operator].operator !== '$elemMatch' || !isPlainObject(operand)) return issues;

      // The operators a value of the list must pass, or a query an item must match
      return isValueOperators(operand) ? queryIssues({ [key]: operand }, path) : queryIssues(operand, path);
    });
  });

/**
 * The problems with a condition, at their paths. A key names an env value, with an object of one or more operators for
 * it, each one the registry knows given an operand it can take; or is @and or @or (or $and or $or) with a list of one
 * or more conditions. Any other name with an operator's prefix isn't one a condition takes. A criterion that isn't an
 * object, or has no operator, never holds.
 * @param {unknown} condition
 * @param {string} path - the condition's, e.g. `config.2.condition`
 * @return {ValidationIssue[]}
 */
const conditionIssues = (condition: unknown, path: string): ValidationIssue[] => {
  if (!isPlainObject(condition)) return [];

  return Object.entries(condition).flatMap(([key, value]): ValidationIssue[] => {
    const logical = Object.hasOwn(LOGICAL_ALIASES, key) ? LOGICAL_ALIASES[key] : undefined;
    if (logical === '$and' || logical === '$or') {
      if (!isPartsList(value)) return [{ path: `${path}.${key}`, code: 'type', expected: 'array' }];
      return value.flatMap((part, idx) => conditionIssues(part, `${path}.${key}.${idx}`));
    }
    if (key.startsWith('@') || key.startsWith('$')) return [{ path, code: 'unknown_operator', received: key }];
    if (!isPlainObject(value)) return [{ path: `${path}.${key}`, code: 'type', expected: 'object' }];
    if (Object.keys(value).length < 1) return [{ path: `${path}.${key}`, code: 'required' }];

    return Object.entries(value).flatMap(([operator, operand]) =>
      Object.hasOwn(ALIASES, operator)
        ? operandIssues(operator, operand, `${path}.${key}`)
        : [{ path: `${path}.${key}`, code: 'unknown_operator', received: operator }],
    );
  });
};

/**
 * The problems with one field of a config.
 * @param {string} field
 * @param {unknown} value
 * @param {string} path - the field's path, e.g. `config.2.query`
 * @return {ValidationIssue[]}
 */
const checkField = (field: string, value: unknown, path: string): ValidationIssue[] => {
  switch (field) {
    case 'verbs':
      if (!Array.isArray(value) || value.length < 1) return [{ path, code: 'required' }];
      return value.flatMap((verb, idx) =>
        typeof verb === 'string' && VERBS.includes(verb)
          ? []
          : [{ path: `${path}.${idx}`, code: 'enum', expected: VERBS, received: describeType(verb) }],
      );
    case 'schema':
      if (!Array.isArray(value) || value.length < 1) return [{ path, code: 'required' }];
      return isStringList(value) ? [] : [{ path, code: 'type', expected: 'array' }];
    // A config without a query grants nothing
    case 'query':
      return isPlainObject(value) ? queryIssues(value, path) : [{ path, code: 'required' }];
    case 'projection':
      if (value === undefined || value === null) return [];
      if (!isPlainObject(value)) return [{ path, code: 'type', expected: 'object' }];
      return isStringList(value.keys) ? [] : [{ path: `${path}.keys`, code: 'type', expected: 'array' }];
    case 'endpoints':
      return value === undefined || value === null || isStringList(value)
        ? []
        : [{ path, code: 'type', expected: 'array' }];
    case 'condition':
      return [...checkOptionalObject(value, path), ...conditionIssues(value, path)];
    case 'env':
      return checkOptionalObject(value, path);
    default:
      return [];
  }
};

const FIELDS = ['verbs', 'schema', 'query', 'projection', 'endpoints', 'condition', 'env'];

const checkItem = (item: unknown, path: string): ValidationIssue[] => {
  if (!isPlainObject(item)) return [{ path, code: 'type', expected: 'object' }];
  return FIELDS.flatMap((field) => checkField(field, item[field], `${path}.${field}`));
};

/**
 * The problems with a policy's configs: those that would leave a config granting nothing, as request-time evaluation
 * drops a config without verbs, a schema or a query, or failing when it's evaluated. A policy is refused with them
 * when it's saved.
 * @param {unknown} config - the policy's `config`
 * @return {ValidationIssue[]}
 */
export function checkPolicyConfig(config: unknown): ValidationIssue[] {
  if (!Array.isArray(config)) return [{ path: 'config', code: 'type', expected: 'array' }];
  if (config.length < 1) return [{ path: 'config', code: 'required' }];
  return config.flatMap((item, idx) => checkItem(item, `config.${idx}`));
}

/**
 * The problems with what an update writes to a policy's configs: all of them, one (`config.N`, or `config` for one
 * added), or one field of one (`config.N.query`). An update to anything else has none, and one below a config's field
 * is checked with the configs it leaves (checkUpdatedPolicyConfig).
 * @param {Object} update - `{path, value}`
 * @return {ValidationIssue[]}
 */
export function checkPolicyConfigUpdate(update: { path?: unknown; value?: unknown }): ValidationIssue[] {
  if (typeof update.path !== 'string') return [];
  const [root, index, field, ...rest] = update.path.split('.');
  if (root !== 'config' || rest.length > 0) return [];

  if (index === undefined) {
    return Array.isArray(update.value) ? checkPolicyConfig(update.value) : checkItem(update.value, 'config');
  }
  if (field === undefined) return checkItem(update.value, update.path);
  return checkField(field, update.value, update.path);
}

const INDEX = /^[0-9]+$/;
// The last segment of a path that removes the array item before it
const REMOVE = '__remove__';

type Container = Record<string | number, unknown>;

// What a document or array has at a key of its own, or undefined
const at = (container: Container, key: string | number) => (Object.hasOwn(container, key) ? container[key] : undefined);

/**
 * Whether an update writes into one of a policy's configs by its index (`config.0`, `config.0.query`,
 * `config.0.query.status`), which the configs it leaves are checked for, as its value alone can't be: one below a
 * config's field, or a config past the end of the list. Not one that removes a config.
 * @param {Object} update - `{path, value}`
 * @return {boolean}
 */
export const writesIntoConfig = (update: { path?: unknown }): boolean => {
  if (typeof update.path !== 'string') return false;
  const [root, index, next] = update.path.split('.');
  return root === 'config' && index !== undefined && INDEX.test(index) && next !== REMOVE;
};

// A value set at an array's index, the missing items before it null, as the datastore sets one
const setKey = (container: Container, key: string | number, value: unknown) => {
  if (Array.isArray(container)) {
    while (container.length < (key as number)) container.push(null);
  }
  container[key] = value;
};

/**
 * Does `write` at a path in a document, as the datastore writes an update there: the documents a path names that are
 * missing are made on the way, and a path through a value that isn't a document, or naming something other than an
 * index in an array, is refused. Without `make`, a path that doesn't lead anywhere writes nothing, as for a removal.
 * @return {boolean} - false when the datastore would refuse it
 */
const writeAt = (
  document: Container,
  segments: string[],
  make: boolean,
  write: (container: Container, key: string | number) => boolean,
): boolean => {
  let container = document;
  for (const [idx, segment] of segments.entries()) {
    const key = Array.isArray(container) ? (INDEX.test(segment) ? Number(segment) : null) : segment;
    if (key === null) return !make;
    if (idx === segments.length - 1) return write(container, key);

    let next = at(container, key);
    if (next === undefined) {
      if (!make) return true;
      next = {};
      setKey(container, key, next);
    }
    if (next === null || typeof next !== 'object') return !make;
    container = next as Container;
  }
  return true;
};

/**
 * Applies an update to a policy as the datastore writes one: `config` adds a config, or replaces them with a list; a
 * path ending `.N.__remove__` takes that item away; any other path sets its value there.
 * @return {boolean} - false when the datastore would refuse it
 */
const applyUpdate = (policy: Container, { path, value }: UpdatePathBody): boolean => {
  const segments = path.split('.');
  if (segments.at(-1) === REMOVE) {
    const index = Number(segments.at(-2));
    return writeAt(policy, segments.slice(0, -2), false, (container, key) => {
      const items = at(container, key);
      if (items === undefined) return true;
      if (!Array.isArray(items)) return false;
      if (index < items.length) items.splice(index, 1);
      return true;
    });
  }
  if (path === 'config' && !Array.isArray(value)) {
    return writeAt(policy, segments, true, (container, key) => {
      const configs = at(container, key);
      if (configs !== undefined && !Array.isArray(configs)) return false;
      setKey(container, key, [...(configs ?? []), structuredClone(value)]);
      return true;
    });
  }
  return writeAt(policy, segments, true, (container, key) => {
    setKey(container, key, structuredClone(value));
    return true;
  });
};

/**
 * The problems with the configs a policy's updates leave: the stored configs with each update to them applied in turn,
 * as the datastore writes them, checked as a new policy's are. An update the datastore would refuse, such as one
 * beneath a condition that's null, is refused when it's written, so there are none to check.
 * @param {unknown} config - the policy's stored configs, which are left as they are
 * @param {Object[]} updates - `{path, value}`, a request's updates to the policy in order
 * @return {ValidationIssue[]}
 */
export function checkUpdatedPolicyConfig(config: unknown, updates: UpdatePathBody[]): ValidationIssue[] {
  const policy: Container = { config: structuredClone(config) };
  for (const update of updates) {
    if (update.path !== 'config' && !update.path.startsWith('config.')) continue;
    if (!applyUpdate(policy, update)) return [];
  }
  return checkPolicyConfig(policy.config);
}
