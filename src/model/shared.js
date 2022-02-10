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
const Model = require('./index');
const ObjectId = require('mongodb').ObjectId;
const Sugar = require('sugar');

/* ********************************************************************************
 *
 * CONSTANTS
 *
 **********************************************************************************/

/* ********************************************************************************
*
* DB HELPERS
*
**********************************************************************************/

module.exports.add = (collection, __add) => {
	return (body) => {
		if (body instanceof Array === false) {
			body = [body];
		}

		return body.reduce((promise, item) => {
			return promise
				.then(__add(item))
				.catch(Logging.Promise.logError());
		}, Promise.resolve([]))
			.then((documents) => {
				return new Promise((resolve, reject) => {
					const ops = documents.map((c) => {
						return {
							insertOne: {
								document: c,
							},
						};
					});

					collection.bulkWrite(ops, (err, res) => {
						if (err) {
							reject(err);
							return;
						}

						const insertedIds = Sugar.Object.values(res.insertedIds).map((id) => new ObjectId(id));
						if (insertedIds.length < 1) {
							resolve([]);
							return;
						}

						resolve(collection.find({_id: {$in: insertedIds}}));
					});
				});
			});
	};
};

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
			ObjectId.isValid(body[property])) {
			flattened.push({
				path: path.join('.'),
				value: parent[property],
			});
			path.pop();
			return;
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

const __getPropDefault = (config) => {
	let res;
	switch (config.__type) {
	default:
	case 'boolean':
		res = config.__default === undefined ? false : config.__default;
		break;
	case 'string':
		res = config.__default === undefined ? '' : config.__default;
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
	case 'time':
		res = config.__default === undefined? null : config.__default;
		break;
	case 'id':
		if (config.__default) {
			res = config.__default;
		} else if (config.__default === 'new') {
			res = new ObjectId();
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

const __validateProp = (prop, config) => {
	let type = typeof prop.value;
	let valid = false;

	if (prop.value === null) {
		return true; // Pass if value is null value
	}

	switch (config.__type) {
	default:
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
				prop.value = new ObjectId(prop.value); // eslint-disable-line new-cap
			} catch (e) {
				valid = false;
				return;
			}
		}
		valid = type === 'string';
		break;
	case 'object':
		valid = type === config.__type;
		break;
	case 'string':
		if (type === 'number') {
			prop.value = String(prop.value);
			type = typeof prop.value;
		}

		valid = type === config.__type;
		if (config.__enum && Array.isArray(config.__enum)) {
			valid = !prop.value || config.__enum.indexOf(prop.value) !== -1;
		}
		break;
	case 'array':
		valid = Array.isArray(prop.value);
		break;
	case 'time':
		valid = (prop.value.match(/^(2[0-3]|[01][0-9]):([0-5][0-9])$/))? true : false;
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
	}

	return valid;
};

const __validate = (schema, values, parentProperty) => {
	const res = {
		isValid: true,
		missing: [],
		invalid: [],
	};

	for (const property in schema) {
		if (!{}.hasOwnProperty.call(schema, property)) continue;
		let propVal = values.find((v) => v.path === property);
		const config = schema[property];

		if (propVal === undefined) {
			if (config.__required) {
				res.isValid = false;
				Logging.logWarn(`Missing required ${property}`);
				res.missing.push(property);
				continue;
			}

			propVal = {
				path: property,
				value: __getPropDefault(config),
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
				const res = __validate(config.__schema, values, `${property}.${idx}.`);
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
				if (!__validateProp(prop, {__type: config.__itemtype})) {
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

const __prepareSchemaResult = (result, dataDisposition, filter, permissions, token = false) => {
	const _prepare = (chunk, path) => {
		if (!chunk) return chunk;

		if (chunk._id) {
			chunk.id = chunk._id;
			delete chunk._id;
		}
		if (chunk._app) {
			chunk.appId = chunk._app;
			delete chunk._app;
		}
		if (chunk._user) {
			chunk.userId = chunk._user;
			delete chunk._user;
		}

		if (typeof chunk === 'object') {
			if (ObjectId.isValid(chunk)) {
				return chunk;
			}
			if (chunk instanceof Date) {
				return chunk;
			}

			chunk = Object.assign({}, chunk);
			if (token && token.type === 'app') return chunk;

			// NOT GOOD
			if (token && token.type === 'dataSharing') {
				return chunk;
			}

			let filterChunk = false;
			if (token) {
				const tokenUser = token._user.toString();
				if (filter) {
					Object.keys(filter).forEach((key) => {
						const keyPath = key.split('.');
						keyPath.pop();
						if (keyPath.toString() === path.toString()) {
							if (chunk[key] && Array.isArray(chunk[key])) {
								if (chunk[key].indexOf(tokenUser) === -1) {
									filterChunk = true;
								}
							} else {
								if (chunk[key] !== tokenUser) {
									filterChunk = true;
								}
							}
						}
					});
				}
			}

			if (filterChunk) {
				return null;
			}

			Object.keys(chunk).forEach((key) => {
				path.push(key);
				let readDisposition = false;

				const property = path.join('.');
				if (permissions[property]) {
					readDisposition = permissions[property].READ === 'allow';
				} else {
					readDisposition = dataDisposition.READ === 'allow';
				}

				if (!readDisposition) {
					delete chunk[key];
					path.pop();
					return;
				}

				chunk[key] = (Array.isArray(chunk[key])) ? chunk[key].map((c) => _prepare(c, path)) : _prepare(chunk[key], path);
				path.pop();
			});
		}

		return chunk;
	};

	return (Array.isArray(result)) ? result.map((c) => _prepare(c, [])) : _prepare(result, []);
};
module.exports.prepareSchemaResult = __prepareSchemaResult;

/* ********************************************************************************
*
* APP-SPECIFIC SCHEMA
*
**********************************************************************************/
const _validateAppProperties = function(schema, body) {
	// const schema = __getCollectionSchema(collection);
	if (schema === false) return {isValid: true};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);
	const flattenedBody = __getFlattenedBody(body);

	return __validate(flattenedSchema, flattenedBody, '');
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
				value: __getPropDefault(config),
			};
		}

		if (propVal === undefined) continue;
		__validateProp(propVal, config);

		const path = propVal.path.split('.');
		const root = path.shift();
		let value = propVal.value;
		if (config.__type === 'array' && config.__schema) {
			value = value.map((v) => __populateObject(config.__schema, __getFlattenedBody(v), body));
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
	if (schema === false) return {isValid: true};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);
	const flattenedBody = __getFlattenedBody(body);

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
				const validation = __validate(config.__schema, __getFlattenedBody(body.value), `${pathStrippedSuffix}.`);
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
				if (!__validateProp(body, {__type: config.__itemtype})) {
					// Logging.logWarn(`Invalid ${property}.${idx}: ${prop.value} [${typeof prop.value}] expected [${config.__itemtype}]`);
					res.invalidValue = `${fullPath}:${body.value}[${typeof body.value}] [${config.__itemtype}]`;
					return res;
				}
			} else if (!config.__schema && !__validateProp(body, config)) {
				res.invalidValue = `${fullPath} failed schema test`;
				return res;
			}
		}

		res.isValueValid = true;
		res.isValid = true;
		return res;
	};
};

const _doUpdate = (entity, body, pathContext, config, collection, id) => {
	return (prev) => {
		const context = pathContext[body.contextPath];
		const updateType = context.type;
		let response = null;

		if (!id) id = entity._id;

		const ops = [];

		switch (updateType) {
		default: {
			throw new Error(`Invalid update type: ${updateType}`);
		}
		case 'vector-add': {
			let value = null;
			if (config && config.__schema) {
				const fb = __getFlattenedBody(body.value);
				value = __populateObject(config.__schema, fb, body);
			} else {
				value = body.value;
			}

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$push: {
							[body.path]: value,
						},
					},
				},
			});
			response = value;
		} break;
		case 'vector-rm': {
			const params = body.path.split('.');
			params.splice(-1, 1);
			const rmPath = params.join('.');
			const index = params.pop();
			body.path = params.join('.');

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$unset: {
							[rmPath]: null,
						},
					},
				},
			});
			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$pull: {
							[body.path]: null,
						},
					},
				},
			});

			response = {numRemoved: 1, index: index};
		} break;
		case 'scalar': {
			let value = null;
			if (config && config.__schema) {
				const fb = __getFlattenedBody(body.value);
				value = __populateObject(config.__schema, fb, body);
			} else {
				value = body.value;
			}

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$set: {
							[body.path]: value,
						},
					},
				},
			});

			response = value;
		} break;
		case 'scalar-increment': {
			const params = body.path.split('.');
			params.splice(-1, 1);
			const path = params.join('.');

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$inc: {
							[path]: body.value,
						},
					},
				},
			});

			response = body.value;
		} break;
		}

		return new Promise((resolve, reject) => {
			if (!ops.length) throw new Error('Aargh');
			if (ops.length) {
				collection.bulkWrite(ops, (err, res) => {
					if (err) {
						err.statusCode = 400;
						reject(err);
						return;
					}
					prev.push({
						type: updateType,
						path: body.path,
						value: response,
					});
					resolve(prev);
				});
				return;
			}
		});
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

module.exports.updateByPath = function(pathContext, schema, collection) {
	return function(body, id) {
		if (body instanceof Array === false) {
			body = [body];
		}
		// const schema = __getCollectionSchema(collectionName);
		const flattenedSchema = schema ? Helpers.getFlattenedSchema(schema) : false;
		const extendedPathContext = __extendPathContext(pathContext, flattenedSchema, '');

		return body.reduce((promise, update) => {
			const config = flattenedSchema === false ? false : flattenedSchema[update.path];
			return promise
				.then(_doUpdate(this, update, extendedPathContext, config, collection, id)); // eslint-disable-line no-invalid-this
		}, Promise.resolve([]));
	};
};

/* ********************************************************************************
 *
 * METADATA
 *
 **********************************************************************************/

/**
 * @param {string} key - index name of the metadata
 * @param {*} value - value of the meta data
 * @return {Promise} - resolves when save operation is completed, rejects if metadata already exists
 */
module.exports.addOrUpdateMetadata = function(key, value) {
	const exists = this.metadata.find((m) => m.key === key);
	if (exists) {
		exists.value = value;
	} else {
		this.metadata.push({key: key, value: value});
	}

	return this.save().then((u) => ({key: key, value: JSON.parse(value)}));
};

module.exports.getAllMetadata = function(collection) {
	return function() {
		collection.find({_app: new ObjectId(Model.authApp._id)}, {metadata: 1});
	};
};

module.exports.findMetadata = function(key) {
	const md = this.metadata.find((m) => m.key === key);
	return md ? {key: md.key, value: JSON.parse(md.value)} : false;
};

module.exports.rmMetadata = function(key) {
	return this
		.update({$pull: {metadata: {key: key}}})
		.then((res) => res.nModified !== 0);
};
