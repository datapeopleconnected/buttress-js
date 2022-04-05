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

const Logging = require('../logging');
const Sugar = require('sugar');

const Datastore = require('../datastore');

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
			Datastore.getInstance().ID.isValid(body[property])) {
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
module.exports.getFlattenedBody = __getFlattenedBody;

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
	case 'id':
		if (config.__default) {
			res = config.__default;
		} else if (config.__default === 'new') {
			res = Datastore.getInstance().ID.new();
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
module.exports.getPropDefault = __getPropDefault;

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
				prop.value = Datastore.getInstance().ID.new(prop.value); // eslint-disable-line new-cap
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
module.exports.validateProp = __validateProp;

const __validate = (schema, values, parentProperty, body = null) => {
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
			if (body && schema && schema[property] && schema[property].__type === 'object') {
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

				values.push(propVal);
				continue;
			}

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
module.exports.validate = __validate;

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
			if (Datastore.getInstance().ID.isValid(chunk)) {
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

const __inflateObject = (parent, path, value) => {
	if (path.length > 1) {
		const parentKey = path.shift();
		if (!parent[parentKey]) {
			parent[parentKey] = {};
		}
		__inflateObject(parent[parentKey], path, value);
		return;
	}

	parent[path.shift()] = value;
	return;
};

const __populateObject = (schema, values) => {
	const res = {};
	const objects = {};

	for (const property in schema) {
		if (!{}.hasOwnProperty.call(schema, property)) continue;
		let propVal = values.find((v) => v.path === property);
		const config = schema[property];

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
			value = value.map((v) => __populateObject(config.__schema, __getFlattenedBody(v)));
		}

		if (path.length > 0) {
			if (!objects[root]) {
				objects[root] = {};
			}
			__inflateObject(objects[root], path, value);
			value = objects[root];
		}

		res[root] = value;
	}
	return res;
};
module.exports.populateObject = __populateObject;
