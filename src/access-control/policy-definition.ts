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
 * object never holds, and one with no operator always would.
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
 * added), or one field of one (`config.N.query`). An update to anything else has none.
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
