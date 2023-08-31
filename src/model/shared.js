'use strict'; // eslint-disable-line max-lines

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

const Logging = require('../helpers/logging');
const Helpers = require('../helpers');
// const Model = require('./index');

/* ********************************************************************************
*
* APP-SPECIFIC SCHEMA
*
**********************************************************************************/
const _validateSchemaObject = function(schema, body) {
	// const schema = __getCollectionSchema(collection);
	if (schema === false) return {isValid: true};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);
	const flattenedBody = Helpers.Schema.getFlattenedBody(body);

	return Helpers.Schema.validate(flattenedSchema, flattenedBody, '', body);
};

/**
 * @param {Object} schema - schema object
 * @param {Object} body - object containing properties to be applied
 * @return {Object} - returns an object with only validated properties
 */
const _sanitizeSchemaObject = function(schema, body) {
	// const schema = __getCollectionSchema(collection);
	if (schema === false) return {};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);
	const flattenedBody = Helpers.Schema.getFlattenedBody(body);

	return Helpers.Schema.sanitizeObject(flattenedSchema, flattenedBody, body);
};

module.exports.validateSchemaObject = _validateSchemaObject;
module.exports.sanitizeSchemaObject = _sanitizeSchemaObject;

/* ********************************************************************************
 *
 * UPDATE BY PATH
 *
 **********************************************************************************/

/**
 * @param {Object} pathContext - object that defines path specification
 * @param {Object} flattenedSchema - schema object keyed on path
 * @return {Object} - returns an object with validation context
 */
const _doValidateUpdate = function(pathContext, flattenedSchema) {
	return (body) => {
		Logging.logDebug(`_doValidateUpdate: path: ${body.path}, value: ${body.value}`);
		const res = {
			isValid: false,
			isMissingRequired: false,
			missingRequired: '',
			isPathValid: false,
			invalidPath: '',
			isValueValid: false,
			invalidValid: '',
		};

		// Seperate between the full update path vs stripped suffix
		const suffix = [
			'.__increment__',
		];
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

		res.missingRequired = false;

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
			const matchObject = blankObjectKeys.reduce((match, key) => {
				const rexMatch = rex.exec(key);
				if (!rexMatch) return match;

				return rexMatch;
			}, null);

			if (!matchObject || !fullPath.includes(matchObject.input)) continue;

			const isRemoved = fullPath.includes('remove');
			matchObject.splice(0, 1);
			validPath = true;
			body.contextPath = (isRemoved) ? fullPath : pathSpec;
			body.contextParams = matchObject;
		}

		if (validPath === false) {
			res.invalidPath = `${fullPath} <> ${Object.getOwnPropertyNames(pathContext)}`;
			return res;
		}

		res.isPathValid = true;
		if (body.value !== null &&
				pathContext[body.contextPath].values.length > 0 &&
				pathContext[body.contextPath].values.indexOf(body.value) === -1) {
			res.invalidValue = `${body.value} <> ${pathContext[body.contextPath].values}`;
			return res;
		}

		const config = flattenedSchema[pathStrippedSuffix];
		if (config) {
			if (config.__type === 'array' && config.__schema) {
				const flattenedBody = Helpers.Schema.getFlattenedBody(body.value);
				const validation = Helpers.Schema.validate(config.__schema, flattenedBody, `${pathStrippedSuffix}.`, body.value);
				if (validation.isValid !== true) {
					if (validation.missing.length) {
						res.isMissingRequired = true;
						res.missingRequired = validation.missing[0];
					}
					if (validation.invalid.length) {
						res.invalidValue = validation.invalid[0];
					}
					return res;
				}
			} else if (config.__type === 'array' && config.__itemtype) {
				if (!Helpers.Schema.validateProp(body, {__type: config.__itemtype})) {
					// Logging.logWarn(`Invalid ${property}.${idx}: ${prop.value} [${typeof prop.value}] expected [${config.__itemtype}]`);
					res.invalidValue = `${fullPath}:${body.value}[${typeof body.value}] [${config.__itemtype}]`;
					return res;
				}
			} else if (!config.__schema && !Helpers.Schema.validateProp(body, config)) {
				res.invalidValue = `${fullPath} failed schema test`;
				return res;
			}
		}

		res.isValueValid = true;
		res.isValid = true;
		return res;
	};
};

const __extendPathContext = (pathContext, schema, prefix) => {
	if (!schema) return pathContext;
	let extended = {};
	for (const property in schema) {
		if (!{}.hasOwnProperty.call(schema, property)) continue;
		const config = schema[property];
		if (config.__allowUpdate === false) continue;
		switch (config.__type) {
		default:
		case 'number':
			extended[`^${prefix}${property}$`] = {type: 'scalar', values: []};
			extended[`^${prefix}${property}\.__increment__$`] = {type: 'scalar-increment', values: []}; // eslint-disable-line no-useless-escape
			break;
		case 'object':
		case 'date':
			extended[`^${prefix}${property}$`] = {type: 'scalar', values: []};
			break;
		case 'string':
		case 'text':
			if (config.__enum) {
				extended[`^${prefix}${property}$`] = {type: 'scalar', values: config.__enum};
			} else {
				extended[`^${prefix}${property}$`] = {type: 'scalar', values: []};
			}
			break;
		case 'array':
			extended[`^${prefix}${property}$`] = {type: 'vectoer-add', values: []};
			extended[`^${prefix}${property}\.([0-9]{1,11})\.__remove__$`] = {type: 'vector-rm', values: []}; // eslint-disable-line no-useless-escape
			extended[`^${prefix}${property}\.([0-9]{1,11})$`] = {type: 'scalar', values: []}; // eslint-disable-line no-useless-escape
			if (config.__schema) {
				// eslint-disable-next-line no-useless-escape
				extended = __extendPathContext(extended, config.__schema, `${prefix}${property}\.([0-9]{1,11})\.`);
			} else if (config.__itemtype) {
				extended[`^${prefix}${property}\.([0-9]{1,11})\.(.+)$`] = {type: 'scalar', values: []}; // eslint-disable-line no-useless-escape
			}
			break;
		}
	}
	return Object.assign(extended, pathContext);
};
module.exports.extendPathContext = __extendPathContext;

module.exports.validateUpdate = function(pathContext, schema) {
	return function(body) {
		Logging.logDebug(body instanceof Array);
		// const schema = __getCollectionSchema(collection);
		const flattenedSchema = schema ? Helpers.getFlattenedSchema(schema) : false;
		const extendedPathContext = __extendPathContext(pathContext, flattenedSchema, '');

		if (schema.core) {
			body = Helpers.updateCoreSchemaObject(body, extendedPathContext);
		}

		if (body instanceof Array === false) {
			body = [body];
		}

		const validation = body.map(_doValidateUpdate(extendedPathContext, flattenedSchema)).filter((v) => v.isValid === false);

		return {
			validation: validation.length >= 1 ? validation[0] : {isValid: true},
			body: body,
		};
	};
};
