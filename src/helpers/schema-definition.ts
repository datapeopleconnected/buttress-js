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

import type { ValidationIssue } from './schema.js';

const PROPERTY_TYPES = ['string', 'number', 'boolean', 'date', 'id', 'uuid', 'object', 'array'];
const ITEM_TYPES = PROPERTY_TYPES.filter((type) => type !== 'array');

// What each key of a property definition takes; `__schema` only an array's
const BOOLEAN_KEYS = ['__required', '__allowUpdate'];
const DEFINITION_KEYS = new Set([
  '__type',
  '__default',
  '__enum',
  '__itemtype',
  '__schema',
  '__timeSeries',
  ...BOOLEAN_KEYS,
]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// A property name a body or an update path can give: not empty, without a dot, and not an operator, nor an internal,
// which only the server sets, unless the schema is the server's own
const isPropertyName = (name: string, internals: boolean) =>
  name !== '' && !name.includes('.') && !name.startsWith('$') && (internals || !name.startsWith('_'));

interface CheckOptions {
  internals: boolean;
}

/**
 * The problems with a property definition, typed (it has `__type`) or a nested object of properties.
 */
const checkProperty = (definition: unknown, path: string, options: CheckOptions): ValidationIssue[] => {
  if (!isPlainObject(definition)) return [{ path, code: 'type', expected: 'object' }];

  const keys = Object.keys(definition);
  // A nested object holds further properties; one with definition keys is a definition missing its type
  if (definition.__type === undefined) {
    if (keys.some((key) => key.startsWith('__'))) return [{ path: `${path}.__type`, code: 'required' }];
    return checkProperties(definition, `${path}.`, options);
  }

  const issues: ValidationIssue[] = [];
  if (typeof definition.__type !== 'string' || !PROPERTY_TYPES.includes(definition.__type)) {
    issues.push({ path: `${path}.__type`, code: 'enum', expected: PROPERTY_TYPES });
  }

  for (const key of keys) {
    const keyPath = `${path}.${key}`;
    const value = definition[key];
    if (!DEFINITION_KEYS.has(key) || (key === '__schema' && definition.__type !== 'array')) {
      issues.push({ path: keyPath, code: 'unknown_path' });
    } else if (BOOLEAN_KEYS.includes(key) && typeof value !== 'boolean') {
      issues.push({ path: keyPath, code: 'type', expected: 'boolean' });
    } else if (key === '__enum' && !Array.isArray(value)) {
      issues.push({ path: keyPath, code: 'type', expected: 'array' });
    } else if (key === '__itemtype' && (typeof value !== 'string' || !ITEM_TYPES.includes(value))) {
      issues.push({ path: keyPath, code: 'enum', expected: ITEM_TYPES });
    } else if (key === '__timeSeries' && typeof value !== 'string') {
      issues.push({ path: keyPath, code: 'type', expected: 'string' });
    } else if (key === '__schema') {
      issues.push(
        ...(isPlainObject(value)
          ? checkProperties(value, `${keyPath}.`, options)
          : [{ path: keyPath, code: 'type', expected: 'object' }]),
      );
    }
  }

  return issues;
};

const checkProperties = (
  properties: Record<string, unknown>,
  prefix: string,
  options: CheckOptions,
): ValidationIssue[] =>
  Object.entries(properties).flatMap(([name, definition]) =>
    isPropertyName(name, options.internals)
      ? checkProperty(definition, `${prefix}${name}`, options)
      : [{ path: `${prefix}${name}`, code: 'invalid_name' }],
  );

/**
 * The problems with a schema's property definitions, so a schema is refused when it's saved rather than misbehaving
 * when it's used: unknown types and keys (a misspelt `__requried`), keys of the wrong type, and names a body can't
 * give. Each issue's path is the property's, then the key.
 * @param {Object} schema - a schema as an app saves it
 * @param {Object} [options]
 * @param {boolean} [options.internals] - take `_`-prefixed names, as a core model's schema has
 * @return {ValidationIssue[]}
 */
export function checkSchemaDefinition(
  schema: { properties?: unknown },
  options: Partial<CheckOptions> = {},
): ValidationIssue[] {
  if (schema.properties === undefined) return [];
  if (!isPlainObject(schema.properties)) return [{ path: 'properties', code: 'type', expected: 'object' }];
  return checkProperties(schema.properties, '', { internals: options.internals ?? false });
}
