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
import { ALIASES, findUnknownOperator, LOGICAL_ALIASES } from './operators.js';

// The verbs a config can grant: a request's method, or all of them
const VERBS = ['GET', 'QUERY', 'SEARCH', 'POST', 'PUT', 'DELETE', '%ALL%'];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// An optional field that, given, must be an object
const checkOptionalObject = (value: unknown, path: string): ValidationIssue[] =>
  value === undefined || value === null || isPlainObject(value) ? [] : [{ path, code: 'type', expected: 'object' }];

// The operator a query names that nothing knows, at its property's path (R3 step 7)
const queryOperatorIssues = (query: Record<string, unknown>, path: string): ValidationIssue[] => {
  const unknown = findUnknownOperator(query);
  return unknown ? [{ path: `${path}.${unknown.path}`, code: 'unknown_operator', received: unknown.operator }] : [];
};

// The operators a condition names that nothing knows. A key names an env value, with operators for it, or is @and
// or @or (or $and or $or) with a list of conditions; any other name with an operator's prefix isn't one a condition
// takes
const conditionOperatorIssues = (condition: unknown, path: string): ValidationIssue[] => {
  if (!isPlainObject(condition)) return [];

  return Object.entries(condition).flatMap(([key, value]): ValidationIssue[] => {
    const logical = Object.hasOwn(LOGICAL_ALIASES, key) ? LOGICAL_ALIASES[key] : undefined;
    if (logical === '$and' || logical === '$or') {
      return Array.isArray(value)
        ? value.flatMap((part, idx) => conditionOperatorIssues(part, `${path}.${key}.${idx}`))
        : [];
    }
    if (key.startsWith('@') || key.startsWith('$')) return [{ path, code: 'unknown_operator', received: key }];
    if (!isPlainObject(value)) return [];

    return Object.keys(value).flatMap((operator) =>
      Object.hasOwn(ALIASES, operator)
        ? []
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
      return isPlainObject(value) ? queryOperatorIssues(value, path) : [{ path, code: 'required' }];
    case 'projection':
      if (value === undefined || value === null) return [];
      if (!isPlainObject(value)) return [{ path, code: 'type', expected: 'object' }];
      return isStringList(value.keys) ? [] : [{ path: `${path}.keys`, code: 'type', expected: 'array' }];
    case 'endpoints':
      return value === undefined || value === null || isStringList(value)
        ? []
        : [{ path, code: 'type', expected: 'array' }];
    case 'condition':
      return [...checkOptionalObject(value, path), ...conditionOperatorIssues(value, path)];
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
