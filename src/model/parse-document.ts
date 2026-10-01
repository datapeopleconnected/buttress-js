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

import {
  checkProp,
  describeNonObjectItem,
  describeNullItem,
  describeType,
  getPropDefault,
  ValidationIssue,
} from '../helpers/schema.js';
import { FlattenedSchema, FlattenedSchemaProperty } from '../types/schema.js';

/**
 * A body read against a schema: what's stored for it, and every problem with it. `missing` (the paths of required
 * properties not given) and `invalid` (each refused value, as `path:value[type]`) give the error's message.
 */
export interface ParsedDocument {
  value: Record<string, unknown>;
  issues: ValidationIssue[];
  missing: string[];
  invalid: string[];
}

type Problems = Omit<ParsedDocument, 'value'>;

// A property of the schema, or a nested object (a property without a `__type`) and the properties beneath it
type SchemaNode = { key: string; config: FlattenedSchemaProperty } | { key: string; children: SchemaNode[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

const trees = new WeakMap<FlattenedSchema, SchemaNode[]>();

/**
 * The flattened schema as a tree, in the schema's order: a nested object's properties beneath it, and an array's
 * item properties left to its `__schema`.
 */
const toTree = (schemaFlat: FlattenedSchema): SchemaNode[] => {
  const cached = trees.get(schemaFlat);
  if (cached) return cached;

  const root: SchemaNode[] = [];
  const nested = new Map<string, SchemaNode[]>();
  for (const [path, config] of Object.entries(schemaFlat)) {
    const segments = path.split('.');
    const parents = segments.slice(0, -1).map((_, idx) => segments.slice(0, idx + 1).join('.'));
    if (parents.some((parent) => schemaFlat[parent]?.__type === 'array')) continue;

    let siblings = root;
    parents.forEach((parent, idx) => {
      let children = nested.get(parent);
      if (!children) {
        children = [];
        nested.set(parent, children);
        siblings.push({ key: segments[idx], children });
      }
      siblings = children;
    });
    siblings.push({ key: segments[segments.length - 1], config });
  }

  trees.set(schemaFlat, root);
  return root;
};

// A property's default, generated where it's made new for each entity, and a copy where it's a list or an object
const defaultOf = (config: FlattenedSchemaProperty) => {
  const value = getPropDefault(config);
  return value !== null && typeof value === 'object' && !(value instanceof Date) ? structuredClone(value) : value;
};

const refuse = (problems: Problems, issue: ValidationIssue, invalid: string) => {
  problems.issues.push(issue);
  problems.invalid.push(invalid);
};

const parseTypedItems = (itemtype: string, items: unknown[], path: string, problems: Problems) =>
  items.map((item, idx) => {
    const itemPath = `${path}.${idx}`;
    const nullItem = describeNullItem(itemPath, item, itemtype);
    if (nullItem) {
      refuse(problems, { path: itemPath, code: 'type', expected: itemtype, received: 'null' }, nullItem);
      return item;
    }

    const prop = { value: item };
    const issue = checkProp(prop, { __type: itemtype }, itemPath);
    if (issue) refuse(problems, issue, `${itemPath}:${String(item)}[${typeof item}] [${itemtype}]`);
    return prop.value;
  });

const parseItems = (itemSchema: FlattenedSchema, items: unknown[], path: string, problems: Problems) =>
  items.map((item, idx) => {
    const itemPath = `${path}.${idx}`;
    const notObject = describeNonObjectItem(itemPath, item);
    if (notObject) {
      refuse(problems, { path: itemPath, code: 'type', expected: 'object', received: describeType(item) }, notObject);
      return item;
    }

    return parseObject(toTree(itemSchema), item, `${itemPath}.`, problems, true);
  });

// A value given for a property, or its default, read as the property's type
const parseValue = (config: FlattenedSchemaProperty, given: unknown, path: string, problems: Problems): unknown => {
  // No value; an array of items is stored without any
  if (given === null) return config.__type === 'array' && config.__schema ? [] : null;

  const prop = { value: given };
  const issue = checkProp(prop, config, path);
  if (issue) {
    refuse(problems, issue, `${path}:${String(given)}[${typeof given}]`);
    return given;
  }

  if (config.__type !== 'array') return prop.value;
  if (config.__schema) return parseItems(config.__schema, prop.value as unknown[], path, problems);
  if (config.__itemtype) return parseTypedItems(config.__itemtype, prop.value as unknown[], path, problems);
  return prop.value;
};

const parseProperty = (config: FlattenedSchemaProperty, given: unknown, path: string, problems: Problems) => {
  const hasDefault = config.__default !== undefined && config.__default !== null;

  if (given === undefined) {
    if (config.__required && !hasDefault) {
      problems.issues.push({ path, code: 'required' });
      problems.missing.push(path);
      return defaultOf(config);
    }

    const value = defaultOf(config);
    // A string without a default is left out
    return value === undefined ? undefined : parseValue(config, value, path, problems);
  }

  // A default given as the value, e.g. `'new'` for an id, is made as it is when the value's left out
  return parseValue(config, hasDefault && given === config.__default ? defaultOf(config) : given, path, problems);
};

// A nested object's properties, from what was given for it. Null, or nothing, gives them their defaults.
const parseNested = (children: SchemaNode[], given: unknown, path: string, problems: Problems) => {
  if (given === undefined || given === null || isPlainObject(given)) {
    return parseObject(children, given ?? {}, `${path}.`, problems, false);
  }

  refuse(
    problems,
    { path, code: 'type', expected: 'object', received: describeType(given) },
    `${path}:${String(given)}[${typeof given}]`,
  );
  return parseObject(children, {}, `${path}.`, { issues: [], missing: [], invalid: [] }, false);
};

/**
 * The properties `nodes` describe, read from `body`. Fields they don't describe are left out, as are `_`-prefixed
 * keys, which only the server sets. An entity's or an item's `source` is checked but never stored: Buttress gives
 * it on what it returns.
 */
const parseObject = (
  nodes: SchemaNode[],
  body: unknown,
  prefix: string,
  problems: Problems,
  isEntity: boolean,
): Record<string, unknown> => {
  const given = isPlainObject(body) ? body : {};
  const value: Record<string, unknown> = {};

  for (const node of nodes) {
    const path = `${prefix}${node.key}`;
    const raw = node.key.startsWith('_') ? undefined : given[node.key];
    const parsed =
      'children' in node
        ? parseNested(node.children, raw, path, problems)
        : parseProperty(node.config, raw, path, problems);

    if (isEntity && node.key === 'source') continue;
    value[node.key] = parsed;
  }

  return value;
};

/**
 * Reads a body against a schema in one pass: each value as its property's type, defaults for what's left out, and
 * every problem, at its path. `body` isn't changed. A schema's `strict` check is the caller's.
 * @param {FlattenedSchema} schemaFlat - the flattened schema, or an array's flattened item schema
 * @param {unknown} body
 * @param {string} [prefix] - the path of `body` within the entity, for the issues
 * @return {ParsedDocument}
 */
export const parseDocument = (schemaFlat: FlattenedSchema, body: unknown, prefix: string = ''): ParsedDocument => {
  const problems: Problems = { issues: [], missing: [], invalid: [] };
  const value = parseObject(toTree(schemaFlat), body, prefix, problems, true);
  return { value, ...problems };
};
