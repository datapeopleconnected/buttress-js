/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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
import crypto from 'node:crypto';

import Logging from './logging.js';
import Sugar from './sugar.js';

import Errors from './errors.js';

import Plugins from '../plugins/index.js';

import Datastore from '../datastore/index.js';

import { v4 as uuidv4 } from 'uuid';

type PropertyDefinition = {
  __type: 'string' | 'number' | 'object' | 'array' | 'boolean' | 'id' | 'date' | 'uuid';
  __default?: unknown;
  __required?: boolean;
	__enum?: unknown[];
	__itemtype?: string;
  __allowUpdate?: boolean;
};

type ArraySchema = {
  __type: 'array';
  __allowUpdate?: boolean;
  __schema: Properties;
};

type Remotes = {
	name: string;
	schema: string;
};

type Properties = {
  [key: string]: PropertyDefinition | ArraySchema | { [key: string]: PropertyDefinition | ArraySchema };
};

export interface Schema {
	name: string;
	core?: boolean;
	extends?: string[];
	remotes?: Remotes | Remotes[];
	type: 'collection' | 'template';
	properties: Properties;
}

/* ********************************************************************************
*
* SCHEMA HELPERS
*
**********************************************************************************/
const __getFlattenedBody = (body) => {
	const __buildFlattenedBody = (property, parent, path, flattened) => {
		if (/^_/.test(property)) return; // ignore internals
		path.push(property);

		if (typeof parent[property] !== 'object' || parent[property] instanceof Date ||
			Array.isArray(parent[property]) || parent[property] === null ||
			Datastore.getInstance('core').ID.instanceOf(body[property])) {
			flattened.push({
				path: path.join('.'),
				value: parent[property],
			});
			path.pop();
			return;
		}

		// Treat an empty object as null
		if (typeof parent[property] === 'object') {
			const keys = Object.keys(parent[property]);
			if (keys.length < 1) {
				flattened.push({
					path: path.join('.'),
					value: null,
				});
			}
		}

		for (const childProp in parent[property]) {
			if (!{}.hasOwnProperty.call(parent[property], childProp)) continue;
			__buildFlattenedBody(childProp, parent[property], path, flattened);
		}

		path.pop();
		return;
	};

	const flattened = [];
	const path = [];
	for (const property in body) {
		if (!{}.hasOwnProperty.call(body, property)) continue;
		__buildFlattenedBody(property, body, path, flattened);
	}

	return flattened;
};
export const getFlattenedBody = __getFlattenedBody;

const __getPropDefault = (config) => {
	let res;
	switch (config.__type) {
		default:
		case 'boolean':
			res = config.__default === undefined ? false : config.__default;
			break;
		case 'string':
			if (config.__default !== null || config.__default !== undefined) {
				if (config.__default === 'randomString') {
					const length = 36;
					const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
					const mask = 0x3d;

					const bytes = crypto.randomBytes(length);
					res = '';
					for (let x = 0; x < bytes.length; x++) {
						const byte = bytes[x];
						res += chars[byte & mask];
					}
				} else {
					res = config.__default;
				}
			}
			break;
		case 'number':
			res = config.__default === undefined ? 0 : config.__default;
			break;
		case 'array':
			res = config.__default === undefined ? [] : config.__default;
			break;
		case 'object':
			res = config.__default === undefined ? {} : config.__default;
			break;
		case 'id':
			if (config.__default) {
				if (config.__default === 'new') {
					res = Datastore.getInstance('core').ID.new();
				} else {
					res = config.__default;
				}
			} else {
				res = null;
			}
			break;
		case 'uuid':
			if (config.__default) {
				if (config.__default === 'new') {
					res = uuidv4();
				} else {
					res = config.__default;
				}
			} else {
				res = null;
			}
			break;
		case 'date':
			if (config.__default === null) {
				res = null;
			} else if (config.__default) {
				res = Sugar.Date.create(config.__default);
			} else {
				res = new Date();
			}
	}
	return res;
};
export const getPropDefault = __getPropDefault;

const __validateProp = (prop, config) => {
	// TODO: This function needs a refactor, we shouldn't be modifying the prop ref.

	let type = typeof prop.value;
	let valid = false;

	if (prop.value === null) {
		return true; // Pass if value is null value
	}

	switch (config.__type) {
		case 'boolean':
			if (type === 'string') {
				const bool = prop.value === 'true' || prop.value === 'yes';
				prop.value = bool;
				type = typeof prop.value;
			}
			if (type === 'number') {
				const bool = prop.value === 1;
				prop.value = bool;
				type = typeof prop.value;
			}
			valid = type === config.__type;
			break;
		case 'number':
			if (type === 'string') {
				const number = Number(prop.value);
				if (Number.isNaN(number) === false) {
					prop.value = number;
					type = typeof prop.value;
				}
			}
			valid = type === config.__type;
			break;
		case 'id':
			if (type === 'string') {
				try {
					prop.value = Datastore.getInstance('core').ID.new(prop.value);
					valid = type === 'string';
				} catch (e) {
					valid = false;
				}
			} else if (type === 'object') {
				if (Datastore.getInstance('core').ID.isValid(prop.value)) {
					try {
						prop.value = Datastore.getInstance('core').ID.new(prop.value);
						valid = true;
					} catch (e) {
						valid = false;
					}
				} else {
					valid = false;
				}
			} else {
				valid = false;
			}
			break;
		case 'uuid':
			if (type === 'string') {
				try {
					// TODO: FIX THIS!
					// valid = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(prop.value);
					valid = true;
				} catch (e) {
					Logging.logDebug(e);
					valid = false;
				}
			} else {
				valid = false;
			}
			break;
		case 'object':
			valid = type === config.__type;
			break;
		case 'string':
			if (type === 'number') {
				prop.value = String(prop.value);
				type = typeof prop.value;
			}

			valid = type === 'string';
			if (config.__enum && Array.isArray(config.__enum)) {
				valid = !prop.value || config.__enum.indexOf(prop.value) !== -1;
			}
			break;
		case 'array':
			valid = Array.isArray(prop.value);
			break;
		case 'date':
			if (prop.value === null) {
				valid = true;
			} else {
				const date = new Date(prop.value);
				valid = Sugar.Date.isValid(date);
				if (valid) {
					prop.value = date;
				}
			}
			break;
		default:
			valid = false;
	}

	return valid;
};
export const validateProp = __validateProp;

const __validate = (schema, values, parentProperty, body?: any) => {
	const res: {
		isValid: boolean,
		missing: string[],
		invalid: string[],
	} = {
		isValid: true,
		missing: [],
		invalid: [],
	};

	for (const property in schema) {
		if (!{}.hasOwnProperty.call(schema, property)) continue;
		let propVal = values.find((v) => v.path === property);
		const config = schema[property];

		const path = property.split('.');
		let isSubPropOfArray = false;
		if (path.length > 1) {
			path.reduce((prev, next, idx, arr) => {
				const np = (idx !== 0) ? `${prev}.${next}` : next;
				if (idx !== arr.length - 1 && schema[np] && schema[np].__type === 'array') {
					isSubPropOfArray = true;
				}
				return np;
			}, '');
		}
		if (isSubPropOfArray) continue;

		if (propVal === undefined || (propVal && propVal.value === config.__default)) {
			// NOTE: This feels wrong
			if (body && body[property] && schema && schema[property] && schema[property].__type === 'object') {
				const definedObjectKeys = Object.keys(schema).filter((key) => key !== property).map((v) => v.replace(`${property}.`, ''));
				const blankObjectValues = Object.keys(body[property]).reduce((arr, key) => {
					if (!definedObjectKeys.includes(key) || property !== key) {
						arr[key] = body[property][key];
					}

					return arr;
				}, {});

				if (blankObjectValues) {
					values.push({
						path: property,
						value: blankObjectValues,
					});
				} else {
					values.push({
						path: property,
						value: __getPropDefault(config),
					});
				}
				continue;
			}

			if (config.__required && propVal === undefined && (config.__default === null || config.__default === undefined)) {
				res.isValid = false;
				Logging.logWarn(`Missing required ${property}`);
				res.missing.push(property);
				continue;
			}

			const defaultValue = __getPropDefault(config);
			if (body && propVal && propVal.value === config.__default) {
				body[property] = defaultValue;
			}

			propVal = {
				path: property,
				value: defaultValue,
			};
			values.push(propVal);
		}

		if (!__validateProp(propVal, config)) {
			Logging.logWarn(`Invalid ${property}: ${propVal.value} [${typeof propVal.value}]`);
			res.isValid = false;
			res.invalid.push(`${parentProperty}${property}:${propVal.value}[${typeof propVal.value}]`);
			continue;
		}

		if (config.__type === 'array' && config.__schema) {
			propVal.value.reduce((errors, v, idx) => {
				const values = __getFlattenedBody(v);
				const res = __validate(config.__schema, values, `${property}.${idx}.`, body);
				if (!res.invalid) return errors;
				if (res.missing.length) {
					errors.missing = errors.missing.concat(res.missing);
				}
				if (res.invalid.length) {
					errors.invalid = errors.invalid.concat(res.invalid);
				}

				return errors;
			}, res);
		} else if (config.__type === 'array' && config.__itemtype) {
			for (const idx in propVal.value) {
				if (!{}.hasOwnProperty.call(propVal.value, idx)) continue;
				const prop = {
					value: propVal.value[idx],
				};
				if (!__validateProp(prop, { __type: config.__itemtype })) {
					Logging.logWarn(`Invalid ${property}.${idx}: ${prop.value} [${typeof prop.value}] expected [${config.__itemtype}]`);
					res.isValid = false;
					res.invalid.push(`${parentProperty}.${idx}:${prop.value}[${typeof prop.value}] [${config.__itemtype}]`);
				}
				propVal.value[idx] = prop.value;
			}
		}
	}

	return res;
};
export const validate = __validate;

const __prepareSchemaResult = (result, sourceId = null, projection = false) => {
	const _prepare = (chunk, path) => {
		if (!chunk) return chunk;

		if (path) {
			if (path.indexOf('_') === 0) return undefined;
		}

		if (typeof chunk === 'object') {
			if (Datastore.getInstance('core').ID.isValid(chunk)) return chunk;
			if (chunk instanceof Date) return chunk;

			chunk = Object.assign({}, chunk);

			// If no path is provided then we're dealing with a root object.
			if (!path) {
				// If there's no sourceId, then it's an object from us.
				if (!chunk.sourceId && sourceId) chunk.sourceId = sourceId;
			}

			// NOT GOOD
			// if (token && token.type === 'app') return chunk;
			// if (token && token.type === 'dataSharing') return chunk;

			if (projection) {
				// TODO: Make a pass on the projections
			}

			for (const key in chunk) {
				if (!{}.hasOwnProperty.call(chunk, key)) continue;
				chunk[key] = (Array.isArray(chunk[key])) ? chunk[key].map((c) => _prepare(c, key)) : _prepare(chunk[key], key);

				// We've done some processing, if we're left with undefined, remove it.
				if (chunk[key] === undefined) delete chunk[key];
			}
		}

		return chunk;
	};

	return (Array.isArray(result)) ? result.map((c) => _prepare(c, null)) : _prepare(result, null);
};
export const prepareSchemaResult = __prepareSchemaResult;

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

function __unflattenObject(data) {
	const result = {};
	for (const i of Object.keys(data)) {
		const keys = i.split('.');
		keys.reduce(function (r, e, j) {
			return r[e] || (r[e] = isNaN(Number(keys[j + 1])) ? (keys.length - 1 == j ? data[i] : {}) : []);
		}, result);
	}
	return result;
}
export const unflattenObject = __unflattenObject;

// TODO: Need to handle flatterned array paths
// TODO: Shared has simliar code, this may be a duplicate
/**
 * @param {Object} schemaFlat - a flatterned schema
 * @param {Array} values - Array of values, path/value
 * @param {Object} body
 * @param {Integer} bodyIdx
 * @return {Object} - A fully populated object using schema defaults and values provided.
 */
export const sanitizeObject = (schemaFlat, values, body = null, bodyIdx?: number) => {
	const res = {};
	const objects = {};

	for (const property in schemaFlat) {
		if (!{}.hasOwnProperty.call(schemaFlat, property)) continue;
		let propVal = values.find((v) => v.path === property);
		const config = schemaFlat[property];

		if (property === 'source') {
			// Source is a special case, we don't actually want it in our objects that get saved
			// as Buttress adds this property to objects to give the client ha hit on whhere the
			// object came from.
			continue;
		}

		const path = property.split('.');
		let isSubPropOfArray = false;
		if (path.length > 1) {
			path.reduce((prev, next, idx, arr) => {
				const np = (idx !== 0) ? `${prev}.${next}` : next;
				if (idx !== arr.length - 1 && schemaFlat[np] && schemaFlat[np].__type === 'array') {
					isSubPropOfArray = true;
				}
				return np;
			}, '');
		}
		if (isSubPropOfArray) continue;

		const root = path.shift();

		if (body && propVal === undefined && schemaFlat[property].__type === 'object') {
			const value = property.split('.').reduce((obj, str) => obj?.[str], body);
			propVal = {};
			propVal.path = property.split('.').pop();
			propVal.value = (value) ? value : __getPropDefault(config);
			if (Array.isArray(body)) {
				// TODO: Error here
				if (bodyIdx === undefined) throw new Error('bodyIdx is required but condition wasn\'t set to handle it being undefined');
				const isSubProperty = property.split('.');
				propVal.path = property;
				propVal.value = (isSubProperty.length > 1) ? isSubProperty.reduce((obj, str) => obj?.[str], body[bodyIdx]) : body[bodyIdx][property];
			}
		}

		if (propVal === undefined) {
			propVal = {
				path: property,
				value: __getPropDefault(config),
			};
		}

		if (propVal === undefined) continue;
		__validateProp(propVal, config);

		let value = propVal.value;
		if (config.__type === 'array' && config.__schema) {
			if (!body || !body[property]) {
				value = [];
			} else {
				value = value.map((v, idx) => sanitizeObject(config.__schema, __getFlattenedBody(v), body[property], idx));
			}
		} else if (root && path.length > 0 || schemaFlat[property].__type === 'object') {
			if (!root) throw new Error('root is required but condition wasn\'t set to handle it being undefined');
			if (!objects[root]) {
				objects[root] = {};
			}
			objects[root] = __inflateObject(objects[root], path, value);
			value = objects[root];
		}

		if (root !== undefined) res[root] = value;
	}
	return res;
};

const __getSchemaKeys = (obj) => {
	return Object.keys(obj).reduce((arr: string[], key) => {
		if (obj[key].__type === 'object') {
			arr.push(key);
		}

		if (obj[key].__type === 'array' && obj[key].__itemtype === 'object') {
			arr.push(key);
		}

		if (obj[key].__type === 'array' && obj[key].__schema) {
			arr = arr.concat(__getSchemaKeys(obj[key].__schema));
		}

		return arr;
	}, []);
};
export const getSchemaKeys = __getSchemaKeys;


export const validTypes = [
	'collection',
	'template',
];

export const encode = (obj) => {
	return JSON.stringify(obj);
	// return JSON.parse(Schema.encodeKey(JSON.stringify(obj)));
}

export const decode = (obj) => {
	return JSON.parse(obj);
	// return JSON.parse(Schema.decodeKey(JSON.stringify(obj)));
}

export const encodeKey = (key) => {
	return key.replace(/\\/g, '\\\\').replace(/\$/g, '\\u0024').replace(/\./g, '\\u002e');
}

export const decodeKey = (key) => {
	return key.replace(/\\u002e/g, '.').replace(/\\u0024/g, '$').replace(/\\\\/g, '\\');
}

export const routeToModel = (name) => {
	if (!name) return;

	return name.split('/').map((part) => Sugar.String.camelize(part, false)).join('-');
}

export const modelToRoute = (name) => {
	if (!name) return;

	return name.split('-').map((part) => Sugar.String.dasherize(part)).join('/');
}

export const buildCollections = async (schemas): Promise<any[]> => {
	const builtSchemas = await build(schemas);
	return builtSchemas.filter((s) => s.type.indexOf('collection') === 0);
}

export const build = async (schemas) => {
	schemas = await Plugins.apply_filters('before_schema_build', schemas);
	schemas = schemas.map((schema) => {
		schema.properties = schema.properties || {};
		schema.properties.id = { __type: 'id', __default: 'new', __allowUpdate: false, __core: true };
		schema.properties.sourceId = { __type: 'id', __allowUpdate: false, __core: true };
		return extend(schemas, schema);
	});
	for await (const schema of schemas) {
		const res = await createTimeSeriesSchema(schema.name, schema.properties);
		if (!res) continue;
		Object.keys(res).forEach((key) => {
			schemas.push(res[key]);
		});
	}
	schemas = await Plugins.apply_filters('after_schema_build', schemas);
	return schemas;
}

export const merge = (schemasA, schemasB) => {
	schemasB.forEach((cS) => {
		const appSchemaIdx = schemasA.findIndex((s) => s.name === cS.name);
		const schema = schemasA[appSchemaIdx];
		if (!schema) {
			return schemasA.push(cS);
		}
		schema.properties = Object.assign(schema.properties, cS.properties);
		schemasA[appSchemaIdx] = schema;
	});

	return schemasA;
}

export const extend = (schemas, schema) => {
	if (schema.extends) {
		schema.extends
			// We'll filter out any schema that's prefix with a plugin name
			.filter((dependencyName) => dependencyName.indexOf(':') === -1)
			.forEach((dependencyName) => {
				const dependencyIdx = schemas.findIndex((s) => s.name === dependencyName);
				// This should be thrown when the user adds or updates the schema.
				if (dependencyIdx === -1) {
					throw new Errors.SchemaInvalid(`Schema dependency ${dependencyName} for ${schema.name} missing.`);
				}
				const dependency = extend(schemas, schemas[dependencyIdx]);
				if (!dependency.properties) return; // Skip if dependency has no properties
				if (!schema.properties) schema.properties = {};
				schema.properties = Object.assign(schema.properties, dependency.properties);
			});
	}

	return schema;
}

export const createTimeSeriesSchema = async (schemaName, schemaProps, timeSeries = {}) => {
	if (!schemaProps || Object.keys(schemaProps).length < 1) return false;

	for await (const prop of Object.keys(schemaProps)) {
		if (typeof schemaProps[prop] !== 'object') continue;
		if (schemaProps[prop].__type && schemaProps[prop].__type === 'array') continue;

		if (schemaProps[prop].__timeSeries) {
			if (!timeSeries[schemaProps[prop].__timeSeries]) {
				timeSeries[schemaProps[prop].__timeSeries] = {
					name: `${schemaName}-${schemaProps[prop].__timeSeries}`,
					type: 'collection',
					extends: [
						'timestamps',
					],
					properties: {
						entityId: {
							__type: 'string',
							__default: null,
							__required: true,
							__allowUpdate: false,
						},
					},
				};
			}
			const timesSeriesObj = Object.assign({}, schemaProps[prop]);
			delete timesSeriesObj.__timeSeries;
			timeSeries[schemaProps[prop].__timeSeries].properties[prop] = timesSeriesObj;
			continue;
		}

		if (!schemaProps[prop].__type) {
			await createTimeSeriesSchema(schemaName, schemaProps[prop], timeSeries);
		}
	}

	if (Object.keys(timeSeries).length < 1) return false;
	return timeSeries;
}