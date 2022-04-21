'use strict'; // eslint-disable-line max-lines

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file shared.js
 * @description Shared schema functions.
 * @module Model
 * @exports model, schema, constants
 * @author Chris Bates-Keegan
 *
 */

const Logging = require('../logging');
const Helpers = require('../helpers');
// const Model = require('./index');

/* ********************************************************************************
*
* APP-SPECIFIC SCHEMA
*
**********************************************************************************/
const _validateAppProperties = function(schema, body) {
	// const schema = __getCollectionSchema(collection);
	if (schema === false) return {isValid: true};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);
	const flattenedBody = Helpers.Schema.getFlattenedBody(body);

	return Helpers.Schema.validate(flattenedSchema, flattenedBody, '', body);
};

const __inflateObject = (parent, path, value) => {
	if (path.length === 0) {
		parent = value;
		return parent;
	}

	if (path.length > 1) {
		const parentKey = path.shift();
		if (!parent[parentKey]) {
			parent[parentKey] = {};
		}
		__inflateObject(parent[parentKey], path, value);
		return parent;
	}

	parent[path.shift()] = value;
	return parent;
};

const __populateObject = (schema, values, body = null) => {
	const res = {};
	const objects = {};

	for (const property in schema) {
		if (!{}.hasOwnProperty.call(schema, property)) continue;
		let propVal = values.find((v) => v.path === property);
		const config = schema[property];

		if (body && propVal === undefined && schema && schema[property] && schema[property].__type === 'object') {
			const definedObjectKeys = Object.keys(schema).filter((key) => key !== property).map((v) => v.replace(`${property}.`, ''));
			const blankObjectValues = Object.keys(body[property]).reduce((arr, key) => {
				if (!definedObjectKeys.includes(key) || property !== key) {
					arr[key] = body[property][key];
				}

				return arr;
			}, {});

			if (blankObjectValues) {
				propVal = {};
				propVal.path = property;
				propVal.value = blankObjectValues;
			}
		}

		if (propVal === undefined) {
			propVal = {
				path: property,
				value: Helpers.Schema.getPropDefault(config),
			};
		}

		if (propVal === undefined) continue;
		Helpers.Schema.validateProp(propVal, config);

		const path = propVal.path.split('.');
		const root = path.shift();
		let value = propVal.value;
		if (config.__type === 'array' && config.__schema) {
			value = value.map((v) => __populateObject(config.__schema, Helpers.Schema.getFlattenedBody(v)));
		}

		if (path.length > 0 || schema[property].__type === 'object') {
			if (!objects[root]) {
				objects[root] = {};
			}
			objects[root] = __inflateObject(objects[root], path, value);
			value = objects[root];
		}

		res[root] = value;
	}
	return res;
};

/**
 * @param {Object} schema - schema object
 * @param {Object} body - object containing properties to be applied
 * @return {Object} - returns an object with only validated properties
 */
const _applyAppProperties = function(schema, body) {
	// const schema = __getCollectionSchema(collection);
	if (schema === false) return {};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);

	// TODO: Strip body of fields that don't match schema

	const flattenedBody = Helpers.Schema.getFlattenedBody(body);

	return __populateObject(flattenedSchema, flattenedBody, body);
};

module.exports.validateAppProperties = _validateAppProperties;
module.exports.applyAppProperties = _applyAppProperties;

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
				const validation = Helpers.Schema.validate(config.__schema, Helpers.Schema.getFlattenedBody(body.value), `${pathStrippedSuffix}.`);
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
			extended[`^${prefix}${property}.__increment__$`] = {type: 'scalar-increment', values: []};
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
			extended[`^${prefix}${property}$`] = {type: 'vector-add', values: []};
			extended[`^${prefix}${property}.([0-9]{1,11}).__remove__$`] = {type: 'vector-rm', values: []};
			extended[`^${prefix}${property}.([0-9]{1,11})$`] = {type: 'scalar', values: []};
			if (config.__schema) {
				extended = __extendPathContext(extended, config.__schema, `${prefix}${property}.([0-9]{1,11}).`);
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
		if (body instanceof Array === false) {
			body = [body];
		}

		// const schema = __getCollectionSchema(collection);
		const flattenedSchema = schema ? Helpers.getFlattenedSchema(schema) : false;
		const extendedPathContext = __extendPathContext(pathContext, flattenedSchema, '');

		const validation = body.map(_doValidateUpdate(extendedPathContext, flattenedSchema)).filter((v) => v.isValid === false);

		return validation.length >= 1 ? validation[0] : {isValid: true};
	};
};
