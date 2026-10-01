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

import * as Helpers from '../helpers/index.js';
import { FlattenedSchema, FlattenedSchemaProperty, Schema } from '../types/schema.js';
import type { ValidationIssue } from '../helpers/schema.js';
import { UpdatePathBody } from '../types/datastore.js';
import { isUpdatePathRefusal, resolveUpdatePath } from './update-paths.js';

export interface UpdateValidationResult {
  isValid: boolean;
  isMissingRequired: boolean;
  missingRequired: string;
  isPathValid: boolean;
  invalidPath: string;
  invalidValue: string;
  isValueValid: boolean;
  invalidValid: string;
  // Every problem, of the request's every update when validateUpdate gives it
  issues: ValidationIssue[];
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
      issues: [],
    };

  const flattenedSchema = Helpers.getFlattenedSchema(schema);
  const flattenedBody = Helpers.Schema.getFlattenedBody(body);

  const validation = Helpers.Schema.validate(flattenedSchema, flattenedBody, '', body);
  if (!schema.strict) return validation;

  const unknown = findUnknownPaths(flattenedSchema, body, '', true);
  if (unknown.length < 1) return validation;
  return { ...validation, isValid: false, issues: [...validation.issues, ...unknown] };
};

// Set by the server, or ignored, so a strict schema doesn't refuse them: the entity's id, the app it came from in a
// federated collection, and `_`-prefixed internals
const ENVELOPE = new Set(['id', 'sourceId']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/**
 * The fields of `body` the schema doesn't define, for a strict schema. A property typed `object` owns everything
 * beneath it; the items of an array with a `__schema` are checked against it.
 * @param {Object} schemaFlat - the flattened schema, or an array's flattened item schema
 * @param {unknown} body
 * @param {string} prefix - the path of `body` within the entity
 * @param {boolean} top - whether `body` is the entity itself, which may have the envelope fields
 * @param {string} within - the path of `body` within the schema, for a nested object's properties
 * @return {ValidationIssue[]}
 */
const findUnknownPaths = (
  schemaFlat: FlattenedSchema,
  body: unknown,
  prefix: string,
  top: boolean,
  within: string = '',
): ValidationIssue[] => {
  if (!isPlainObject(body)) return [];

  return Object.entries(body).flatMap(([key, value]): ValidationIssue[] => {
    if (key.startsWith('_') || (top && !within && ENVELOPE.has(key))) return [];

    const schemaPath = `${within}${key}`;
    const path = `${prefix}${schemaPath}`;
    const config = schemaFlat[schemaPath];
    if (config) {
      if (config.__type !== 'array' || !config.__schema || !Array.isArray(value)) return [];
      const itemSchema = config.__schema;
      return value.flatMap((item, idx) => findUnknownPaths(itemSchema, item, `${path}.${idx}.`, false));
    }

    // A nested object with properties of its own
    if (isPlainObject(value) && Object.keys(schemaFlat).some((name) => name.startsWith(`${schemaPath}.`))) {
      return findUnknownPaths(schemaFlat, value, prefix, top, `${schemaPath}.`);
    }

    return [{ path, code: 'unknown_path' }];
  });
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
  issues?: ValidationIssue[];
}

const isTypedArray = (config: FlattenedSchemaProperty | false | null | undefined) =>
  !!config && config.__type === 'array' && Boolean(config.__schema || config.__itemtype);

/**
 * Checks one item of a typed array against the array's item schema or item type. The returned value is the item
 * converted to the item type, as validateProp converts values.
 */
const checkArrayItem = (config: FlattenedSchemaProperty, item: unknown, path: string): ArrayItemCheck => {
  if (config.__schema) {
    const notObject = Helpers.Schema.describeNonObjectItem(path, item);
    if (notObject) {
      return {
        value: item,
        invalidValue: notObject,
        issues: [{ path, code: 'type', expected: 'object', received: Helpers.Schema.describeType(item) }],
      };
    }

    const validation = Helpers.Schema.validate(
      config.__schema,
      Helpers.Schema.getFlattenedBody(item),
      `${path}.`,
      item,
    );
    if (validation.isValid === true) return { value: item };

    return {
      value: item,
      missingRequired: validation.missing[0],
      invalidValue: validation.invalid[0],
      issues: validation.issues,
    };
  }

  const itemtype = config.__itemtype ?? '';
  const nullItem = Helpers.Schema.describeNullItem(path, item, itemtype);
  if (nullItem) {
    return {
      value: item,
      invalidValue: nullItem,
      issues: [{ path, code: 'type', expected: itemtype, received: 'null' }],
    };
  }

  const prop = { value: item };
  const issue = Helpers.Schema.checkProp(prop, { __type: itemtype }, path);
  if (issue) {
    return { value: item, invalidValue: `${path}:${String(item)}[${typeof item}] [${itemtype}]`, issues: [issue] };
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

/**
 * The error for an update validateUpdate refused, 400 invalid_update, saying why.
 * @param {string} schema - the name of what's being updated
 * @param {object} validation
 * @return {ApiError}
 */
export const invalidUpdateError = (schema: string | undefined, validation: UpdateValidationResult) =>
  Helpers.Errors.badRequest('invalid_update', `${schema}: ${describeInvalidUpdate(validation)}`, {
    schema,
    ...(validation.issues ? { issues: validation.issues } : {}),
  });

/**
 * The error for an entity validate() refused: 400 missing_field for its first missing field, or invalid_value for its
 * first invalid value, given as `path:value[type]`.
 * @param {string} schema - the name of what's being added
 * @param {object} validation
 * @param {number} [index] - the entity's place in a list of them
 * @return {ApiError}
 */
export const invalidEntityError = (
  schema: string | undefined,
  validation: { missing?: string[]; invalid?: string[]; issues?: ValidationIssue[] },
  index?: number,
) => {
  const at = index === undefined ? '' : ` at index ${index}`;
  const where = {
    ...(index === undefined ? {} : { index }),
    ...(validation.issues ? { issues: validation.issues } : {}),
  };
  const [missing] = validation.missing ?? [];
  if (missing !== undefined) {
    return Helpers.Errors.badRequest('missing_field', `${schema}: Missing field: ${missing}${at}`, {
      schema,
      path: missing,
      ...where,
    });
  }

  const [invalid] = validation.invalid ?? [];
  if (invalid !== undefined) {
    return Helpers.Errors.badRequest('invalid_value', `${schema}: Invalid value: ${invalid}${at}`, {
      schema,
      path: invalid.split(':')[0],
      ...where,
    });
  }

  const unknown = validation.issues?.find((issue) => issue.code === 'unknown_path');
  if (unknown) {
    return Helpers.Errors.badRequest('unknown_path', `${schema}: Unknown field: ${unknown.path}${at}`, {
      schema,
      path: unknown.path,
      ...where,
    });
  }

  return Helpers.Errors.badRequest('invalid_value', `${schema}: Invalid entity${at}`, { schema, ...where });
};

/**
 * Checks one update against the schema, through the path it writes to. A value is converted to its type in place, and
 * a whole array's items are checked as items.
 * @param {Object} schemaFlat - the model's flattened schema
 * @return {Function} - checks an update
 */
export const doValidateUpdate = function (schemaFlat: FlattenedSchema) {
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
      issues: [],
    };

    // A request with no body, or an item of an array that isn't an update, has nothing to read a path from
    if (!body || typeof body !== 'object' || !body.path || typeof body.path !== 'string') {
      res.missingRequired = 'path';
      res.issues.push({ path: '', code: 'required', expected: 'path' });
      return res;
    }
    const fullPath = body.path;
    if (body.value === undefined) {
      res.missingRequired = 'value';
      res.issues.push({ path: fullPath, code: 'required', expected: 'value' });
      return res;
    }

    const resolved = resolveUpdatePath(schemaFlat, fullPath);
    if (isUpdatePathRefusal(resolved)) {
      res.invalidPath = fullPath;
      res.issues.push({ path: fullPath, code: resolved.error });
      return res;
    }

    res.isPathValid = true;
    const { config, kind, target, values } = resolved;
    if (body.value !== null && values.length > 0 && !values.includes(body.value)) {
      res.invalidValue = `${body.value} <> ${values}`;
      res.issues.push({
        path: fullPath,
        code: 'enum',
        expected: values,
        received: Helpers.Schema.describeType(body.value),
      });
      return res;
    }

    // A removal names the item by its path, a write beneath an object property or array item takes any value
    let checks: ArrayItemCheck[] = [];
    if (kind === 'vector-rm' || target === 'beneath') {
      // Nothing to check
    } else if (isTypedArray(config) && target === 'property' && Array.isArray(body.value)) {
      // An array value replaces the whole array (see StandardModel.updateByPath), so each element is an item.
      const items = body.value;
      checks = items.map((item, idx) => checkArrayItem(config, item, `${fullPath}.${idx}`));
      body.value = checks.map((check) => check.value);
    } else if (isTypedArray(config)) {
      // A push of one item to the array, or a `path.N` set of one item.
      checks = [checkArrayItem(config, body.value, fullPath)];
      body.value = checks[0].value;
    } else if (config.__type === 'array') {
      // An array with no item type takes any value: one to append, or an array to replace it with.
    } else {
      const issue = Helpers.Schema.checkProp(body, config, fullPath);
      if (issue) {
        res.invalidValue = `${fullPath} failed schema test`;
        res.issues.push(issue);
        return res;
      }
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
      res.issues = checks.flatMap((check) => check.issues ?? []);
      return res;
    }

    res.isValueValid = true;
    res.isValid = true;
    return res;
  };
};

/**
 * Checks a request's updates against the schema.
 * @param {Object} schema
 * @param {Object} [schemaFlat] - the schema flattened, as the model keeps it
 * @return {Function} - takes one update or an array of them, giving the first refused update's validation with every
 * refused update's issues, and the updates as an array, their values converted
 */
export const validateUpdate = function (
  schema: Schema,
  schemaFlat: FlattenedSchema = Helpers.getFlattenedSchema(schema),
) {
  return function (body: unknown) {
    const updates = (Array.isArray(body) ? body : [body]) as UpdatePathBody[];
    const validation = updates.map(doValidateUpdate(schemaFlat)).filter((v) => v.isValid === false);

    return {
      validation:
        validation.length >= 1
          ? { ...validation[0], issues: validation.flatMap((v) => v.issues) }
          : ({ isValid: true } as const),
      body: updates,
    };
  };
};
