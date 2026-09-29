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

import Logging from '../helpers/logging.js';
import * as Helpers from '../helpers/index.js';
import { FlattenedSchema, FlattenedSchemaProperty, Schema } from '../types/schema.js';
import { UpdatePathBody, UpdatePathContexts } from '../types/datastore.js';

export interface UpdateValidationResult {
  isValid: boolean;
  isMissingRequired: boolean;
  missingRequired: string;
  isPathValid: boolean;
  invalidPath: string;
  invalidValue: string;
  isValueValid: boolean;
  invalidValid: string;
}

/* ********************************************************************************
 *
 * APP-SPECIFIC SCHEMA
 *
 **********************************************************************************/
export const validateSchemaObject = function (schema: Schema | false, body: unknown) {
  // const schema = __getCollectionSchema(collection);
  if (schema === false)
    return {
      isValid: true,
      missing: [],
      invalid: [],
    };

  const flattenedSchema = Helpers.getFlattenedSchema(schema);
  const flattenedBody = Helpers.Schema.getFlattenedBody(body);

  return Helpers.Schema.validate(flattenedSchema, flattenedBody, '', body);
};

/**
 * @param {Object} schema - schema object
 * @param {Object} body - object containing properties to be applied
 * @return {Object} - returns an object with only validated properties
 */
export const sanitizeSchemaObject = function (schema: Schema | false, body: unknown) {
  // const schema = __getCollectionSchema(collection);
  if (schema === false) return {};

  const flattenedSchema = Helpers.getFlattenedSchema(schema);
  const flattenedBody = Helpers.Schema.getFlattenedBody(body);

  return Helpers.Schema.sanitizeObject(flattenedSchema, flattenedBody, body);
};

/* ********************************************************************************
 *
 * UPDATE BY PATH
 *
 **********************************************************************************/

interface ArrayItemCheck {
  value: unknown;
  missingRequired?: string;
  invalidValue?: string;
}

const isTypedArray = (config: FlattenedSchemaProperty | false | null | undefined) =>
  !!config && config.__type === 'array' && Boolean(config.__schema || config.__itemtype);

/**
 * Finds the typed array that a `path.N` update sets one item of, e.g. `contacts` for `contacts.2`.
 */
const getItemArrayConfig = (flattenedSchema: FlattenedSchema, path: string) => {
  const match = /^(.+)\.\d+$/.exec(path);
  // `matrix.0.1` is inside an item of `matrix`, not an item of it.
  if (!match || /\.\d+$/.test(match[1])) return null;

  const config = flattenedSchema[match[1].replace(/\.\d+/g, '')];
  return isTypedArray(config) ? config : null;
};

/**
 * Finds the field of an array item that a path through that item names, e.g. `contacts.qty` for `contacts.2.qty`, so it
 * is checked like the field. A path ending in an index sets a whole item instead (see getItemArrayConfig).
 */
const getItemFieldConfig = (flattenedSchema: FlattenedSchema, path: string): FlattenedSchemaProperty | undefined => {
  if (!/\.\d+\./.test(path) || /\.\d+$/.test(path)) return undefined;

  return flattenedSchema[path.replace(/\.\d+/g, '')];
};

/**
 * Checks one item of a typed array against the array's item schema or item type. The returned value is the item
 * converted to the item type, as validateProp converts values.
 */
const checkArrayItem = (config: FlattenedSchemaProperty, item: unknown, path: string): ArrayItemCheck => {
  if (config.__schema) {
    const notObject = Helpers.Schema.describeNonObjectItem(path, item);
    if (notObject) return { value: item, invalidValue: notObject };

    const validation = Helpers.Schema.validate(
      config.__schema,
      Helpers.Schema.getFlattenedBody(item),
      `${path}.`,
      item,
    );
    if (validation.isValid === true) return { value: item };

    return { value: item, missingRequired: validation.missing[0], invalidValue: validation.invalid[0] };
  }

  const itemtype = config.__itemtype ?? '';
  const nullItem = Helpers.Schema.describeNullItem(path, item, itemtype);
  if (nullItem) return { value: item, invalidValue: nullItem };

  const prop = { value: item };
  if (!Helpers.Schema.validateProp(prop, { __type: itemtype })) {
    return { value: item, invalidValue: `${path}:${String(item)}[${typeof item}] [${itemtype}]` };
  }

  return { value: prop.value };
};

/**
 * Says why validateUpdate refused an update, for the error a route sends back.
 */
export const describeInvalidUpdate = (validation: UpdateValidationResult) => {
  if (!validation.isPathValid && (validation.missingRequired === 'path' || validation.missingRequired === 'value')) {
    return `Update is missing its ${validation.missingRequired}`;
  }
  if (validation.isPathValid === false) return `Update path is invalid: ${validation.invalidPath}`;
  if (validation.isMissingRequired) return `Missing required property: ${validation.missingRequired}`;

  return `Update value is invalid: ${validation.invalidValue}`;
};

// A property name as it's matched in an update path spec
const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The property typed object that `fullPath` is a path beneath. A typed object declares no properties of its own (a
 * nested object with declared properties is untyped, and its properties have their own specs). Each segment beneath
 * it must be a plain name, not one of the `__`-prefixed update operations.
 * @param {String} fullPath - update path
 * @param {Object} schemaFlat - flattened schema
 * @return {String|undefined} - the property's key
 */
const objectKeyOf = (fullPath: string, schemaFlat: FlattenedSchema) =>
  Object.keys(schemaFlat).find((key) => {
    if (schemaFlat[key].__type !== 'object' || !fullPath.startsWith(`${key}.`)) return false;

    const segments = fullPath.slice(key.length + 1).split('.');
    return segments.every((segment) => segment !== '' && !segment.startsWith('__'));
  });

/**
 * @param {Object} pathContext - object that defines path specification
 * @param {Object} flattenedSchema - schema object keyed on path
 * @return {Object} - returns an object with validation context
 */
export const doValidateUpdate = function (pathContext: UpdatePathContexts, flattenedSchema: FlattenedSchema | false) {
  const schemaFlat = flattenedSchema || {};
  return (body: UpdatePathBody) => {
    const res: UpdateValidationResult = {
      isValid: false,
      isMissingRequired: false,
      missingRequired: '',
      isPathValid: false,
      invalidPath: '',
      invalidValue: '',
      isValueValid: false,
      invalidValid: '',
    };

    // A request with no body, or an item of an array that isn't an update, has nothing to read a path from
    if (!body || typeof body !== 'object') {
      res.missingRequired = 'path';
      return res;
    }
    Logging.logSilly(`doValidateUpdate: path: ${body.path}, value: ${body.value}`);

    const fullPath = body.path;
    if (!fullPath || typeof fullPath !== 'string') {
      res.missingRequired = 'path';
      return res;
    }

    // Seperate between the full update path vs stripped suffix
    const suffix = '.__increment__';
    const pathStrippedSuffix = fullPath.replace(suffix, '');

    if (body.value === undefined) {
      res.missingRequired = 'value';
      return res;
    }

    res.missingRequired = '';

    let validPath = false;
    body.contextPath = false;
    for (const pathSpec in pathContext) {
      if (!{}.hasOwnProperty.call(pathContext, pathSpec)) {
        continue;
      }

      const rex = new RegExp(pathSpec);
      const matches = rex.exec(fullPath);
      if (matches) {
        matches.splice(0, 1);
        validPath = true;
        body.contextPath = pathSpec;
        body.contextParams = matches;
        break;
      }
    }

    // A property typed object takes writes to paths beneath it
    if (!validPath) {
      const objectKey = objectKeyOf(fullPath, schemaFlat);
      const pathSpec = objectKey ? `^${escapeRegExp(objectKey)}$` : null;
      if (pathSpec && pathContext[pathSpec]) {
        validPath = true;
        body.contextPath = pathSpec;
        body.contextParams = [];
      }
    }

    if (validPath === false) {
      res.invalidPath = `${fullPath} <> ${Object.getOwnPropertyNames(pathContext)}`;
      return res;
    }

    res.isPathValid = true;
    // A valid path means a context path was found
    const context = pathContext[body.contextPath as string];
    if (body.value !== null && context.values.length > 0 && context.values.indexOf(body.value) === -1) {
      res.invalidValue = `${body.value} <> ${context.values}`;
      return res;
    }

    const config = schemaFlat[pathStrippedSuffix] ?? getItemFieldConfig(schemaFlat, pathStrippedSuffix);
    const itemArrayConfig = config ? null : getItemArrayConfig(schemaFlat, pathStrippedSuffix);
    // The typed array the update writes to: the property itself, or the array that a `path.N` sets one item of.
    const arrayConfig = config && isTypedArray(config) ? config : itemArrayConfig;

    let checks: ArrayItemCheck[] = [];
    if (config && isTypedArray(config) && Array.isArray(body.value)) {
      // An array value replaces the whole array (see StandardModel.updateByPath), so each element is an item.
      checks = body.value.map((item, idx) => checkArrayItem(config, item, `${pathStrippedSuffix}.${idx}`));
      body.value = checks.map((check) => check.value);
    } else if (arrayConfig) {
      // A push of one item to the array, or a `path.N` set of one item.
      checks = [checkArrayItem(arrayConfig, body.value, pathStrippedSuffix)];
      body.value = checks[0].value;
    } else if (config?.__type === 'array') {
      // An array with no item type takes any value: one to append, or an array to replace it with.
    } else if (config && !config.__schema && !Helpers.Schema.validateProp(body, config)) {
      res.invalidValue = `${fullPath} failed schema test`;
      return res;
    }

    const failed = checks.find((check) => check.missingRequired || check.invalidValue);
    if (failed) {
      if (failed.missingRequired) {
        res.isMissingRequired = true;
        res.missingRequired = failed.missingRequired;
      }
      if (failed.invalidValue) {
        res.invalidValue = failed.invalidValue;
      }
      return res;
    }

    res.isValueValid = true;
    res.isValid = true;
    return res;
  };
};

export const extendPathContext = (
  pathContext: UpdatePathContexts,
  schema: FlattenedSchema,
  prefix: string,
): UpdatePathContexts => {
  if (!schema) return pathContext;
  let extended: UpdatePathContexts = {};
  for (const property in schema) {
    if (!{}.hasOwnProperty.call(schema, property)) continue;
    const config = schema[property];
    if (config.__allowUpdate === false) continue;
    // The specs are regular expressions: the property name is escaped, and the dots between segments are `\.`
    const name = `${prefix}${escapeRegExp(property)}`;
    switch (config.__type) {
      default:
      case 'number':
        extended[`^${name}$`] = { type: 'scalar', values: [] };
        extended[`^${name}\\.__increment__$`] = { type: 'scalar-increment', values: [] };
        break;
      case 'object':
      case 'date':
        extended[`^${name}$`] = { type: 'scalar', values: [] };
        break;
      case 'string':
        if (config.__enum) {
          extended[`^${name}$`] = { type: 'scalar', values: config.__enum };
        } else {
          extended[`^${name}$`] = { type: 'scalar', values: [] };
        }
        break;
      case 'array':
        extended[`^${name}$`] = { type: 'vector-add', values: [] };
        extended[`^${name}\\.([0-9]{1,11})\\.__remove__$`] = { type: 'vector-rm', values: [] };
        extended[`^${name}\\.([0-9]{1,11})$`] = { type: 'scalar', values: [] };
        if (config.__schema) {
          extended = extendPathContext(extended, config.__schema, `${name}\\.([0-9]{1,11})\\.`);
        } else if (config.__itemtype) {
          extended[`^${name}\\.([0-9]{1,11})\\.(.+)$`] = { type: 'scalar', values: [] };
        }
        break;
    }
  }
  return Object.assign(extended, pathContext);
};

export const validateUpdate = function (pathContext: UpdatePathContexts, schema: Schema) {
  return function (body: unknown) {
    Logging.logDebug(body instanceof Array);
    // const schema = __getCollectionSchema(collection);
    const flattenedSchema = schema ? Helpers.getFlattenedSchema(schema) : false;
    const extendedPathContext = extendPathContext(pathContext, flattenedSchema || {}, '');

    // One update or an array of them. updateCoreSchemaObject only handles an array, it returns undefined for one.
    if (body instanceof Array === false) {
      body = [body];
    }

    if (schema.core) {
      body = Helpers.updateCoreSchemaObject(body, extendedPathContext);
    }

    const validation = (body as UpdatePathBody[])
      .map(doValidateUpdate(extendedPathContext, flattenedSchema))
      .filter((v) => v.isValid === false);

    return {
      validation: validation.length >= 1 ? validation[0] : ({ isValid: true } as const),
      body: body as UpdatePathBody[],
    };
  };
};
