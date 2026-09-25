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
import { FlattenedSchema, Schema } from '../types/schema.js';

/* ********************************************************************************
 *
 * APP-SPECIFIC SCHEMA
 *
 **********************************************************************************/
export const validateSchemaObject = function (schema, body) {
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
export const sanitizeSchemaObject = function (schema, body) {
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

const isTypedArray = (config) => config?.__type === 'array' && Boolean(config.__schema || config.__itemtype);

/**
 * Finds the typed array that a `path.N` update sets one item of, e.g. `contacts` for `contacts.2`.
 */
const getItemArrayConfig = (flattenedSchema, path: string) => {
  const match = /^(.+)\.\d+$/.exec(path);
  // `matrix.0.1` is inside an item of `matrix`, not an item of it.
  if (!match || /\.\d+$/.test(match[1])) return null;

  const config = flattenedSchema[match[1].replace(/\.\d+/g, '')];
  return isTypedArray(config) ? config : null;
};

/**
 * Checks one item of a typed array against the array's item schema or item type. The returned value is the item
 * converted to the item type, as validateProp converts values.
 */
const checkArrayItem = (config, item: unknown, path: string): ArrayItemCheck => {
  if (config.__schema) {
    if (item !== null && (typeof item !== 'object' || Array.isArray(item))) {
      return { value: item, invalidValue: `${path}:${item}[${Array.isArray(item) ? 'array' : typeof item}] [object]` };
    }

    const validation = Helpers.Schema.validate(
      config.__schema,
      Helpers.Schema.getFlattenedBody(item),
      `${path}.`,
      item,
    );
    if (validation.isValid === true) return { value: item };

    return { value: item, missingRequired: validation.missing[0], invalidValue: validation.invalid[0] };
  }

  const prop = { value: item };
  if (!Helpers.Schema.validateProp(prop, { __type: config.__itemtype })) {
    return { value: item, invalidValue: `${path}:${item}[${typeof item}] [${config.__itemtype}]` };
  }

  return { value: prop.value };
};

/**
 * @param {Object} pathContext - object that defines path specification
 * @param {Object} flattenedSchema - schema object keyed on path
 * @return {Object} - returns an object with validation context
 */
export const doValidateUpdate = function (pathContext, flattenedSchema) {
  return (body) => {
    Logging.logSilly(`doValidateUpdate: path: ${body.path}, value: ${body.value}`);
    const res = {
      isValid: false,
      isMissingRequired: false,
      missingRequired: '',
      isPathValid: false,
      invalidPath: '',
      invalidValue: '',
      isValueValid: false,
      invalidValid: '',
    };

    // Seperate between the full update path vs stripped suffix
    const suffix = ['.__increment__'];
    const fullPath = body.path;
    const pathStrippedSuffix = fullPath.replace(suffix, '');

    if (!fullPath) {
      res.missingRequired = 'path';
      return res;
    }
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

      const blankObjectKeys = Helpers.Schema.getSchemaKeys(flattenedSchema);
      const matchObject = blankObjectKeys.reduce((match: RegExpExecArray | null, key) => {
        const rexMatch = rex.exec(key);
        if (!rexMatch) return match;

        return rexMatch;
      }, null);

      if (!matchObject || !fullPath.includes(matchObject.input)) continue;

      const isRemoved = fullPath.includes('remove');
      matchObject.splice(0, 1);
      validPath = true;
      body.contextPath = isRemoved ? fullPath : pathSpec;
      body.contextParams = matchObject;
    }

    if (validPath === false) {
      res.invalidPath = `${fullPath} <> ${Object.getOwnPropertyNames(pathContext)}`;
      return res;
    }

    res.isPathValid = true;
    if (
      body.value !== null &&
      pathContext[body.contextPath].values.length > 0 &&
      pathContext[body.contextPath].values.indexOf(body.value) === -1
    ) {
      res.invalidValue = `${body.value} <> ${pathContext[body.contextPath].values}`;
      return res;
    }

    const config = flattenedSchema[pathStrippedSuffix];
    const itemArrayConfig = config ? null : getItemArrayConfig(flattenedSchema, pathStrippedSuffix);

    let checks: ArrayItemCheck[] = [];
    if (isTypedArray(config) && Array.isArray(body.value)) {
      // An array value replaces the whole array (see StandardModel.updateByPath), so each element is an item.
      checks = body.value.map((item, idx) => checkArrayItem(config, item, `${pathStrippedSuffix}.${idx}`));
      body.value = checks.map((check) => check.value);
    } else if (isTypedArray(config) || itemArrayConfig) {
      // A push of one item to the array, or a `path.N` set of one item.
      checks = [checkArrayItem(config || itemArrayConfig, body.value, pathStrippedSuffix)];
      body.value = checks[0].value;
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

export const extendPathContext = (pathContext, schema: FlattenedSchema, prefix: string) => {
  if (!schema) return pathContext;
  let extended = {};
  for (const property in schema) {
    if (!{}.hasOwnProperty.call(schema, property)) continue;
    const config = schema[property];
    if (config.__allowUpdate === false) continue;
    switch (config.__type) {
      default:
      case 'number':
        extended[`^${prefix}${property}$`] = { type: 'scalar', values: [] };
        extended[`^${prefix}${property}\.__increment__$`] = { type: 'scalar-increment', values: [] };
        break;
      case 'object':
      case 'date':
        extended[`^${prefix}${property}$`] = { type: 'scalar', values: [] };
        break;
      case 'string':
        if (config.__enum) {
          extended[`^${prefix}${property}$`] = { type: 'scalar', values: config.__enum };
        } else {
          extended[`^${prefix}${property}$`] = { type: 'scalar', values: [] };
        }
        break;
      case 'array':
        extended[`^${prefix}${property}$`] = { type: 'vector-add', values: [] };
        extended[`^${prefix}${property}\.([0-9]{1,11})\.__remove__$`] = { type: 'vector-rm', values: [] };
        extended[`^${prefix}${property}\.([0-9]{1,11})$`] = { type: 'scalar', values: [] };
        if (config.__schema) {
          extended = extendPathContext(extended, config.__schema, `${prefix}${property}\.([0-9]{1,11})\.`);
        } else if (config.__itemtype) {
          extended[`^${prefix}${property}\.([0-9]{1,11})\.(.+)$`] = { type: 'scalar', values: [] };
        }
        break;
    }
  }
  return Object.assign(extended, pathContext);
};

export const validateUpdate = function (pathContext, schema: Schema) {
  return function (body) {
    Logging.logDebug(body instanceof Array);
    // const schema = __getCollectionSchema(collection);
    const flattenedSchema = schema ? Helpers.getFlattenedSchema(schema) : false;
    const extendedPathContext = extendPathContext(pathContext, flattenedSchema || {}, '');

    if (schema.core) {
      body = Helpers.updateCoreSchemaObject(body, extendedPathContext);
    }

    if (body instanceof Array === false) {
      body = [body];
    }

    const validation = body
      .map(doValidateUpdate(extendedPathContext, flattenedSchema))
      .filter((v) => v.isValid === false);

    return {
      validation: validation.length >= 1 ? validation[0] : { isValid: true },
      body: body,
    };
  };
};
