'use strict';

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

const Errors = require('./helpers/errors');

const stream = require('stream');
const Transform = stream.Transform;

const Datastore = require('./datastore');

module.exports.Errors = Errors;

module.exports.Schema = require('./helpers/schema');
module.exports.Stream = require('./helpers/stream');

class Timer {
	constructor() {
		this._start = 0;
	}

	start() {
		const hrTime = process.hrtime();
		this._last = this._start = (hrTime[0] * 1000000) + (hrTime[1] / 1000);
	}

	get lapTime() {
		const hrTime = process.hrtime();
		const time = (hrTime[0] * 1000000) + (hrTime[1] / 1000);
		const lapTime = time - this._last;
		this._last = time;
		return (lapTime / 1000000);
	}
	get interval() {
		const hrTime = process.hrtime();
		const time = (hrTime[0] * 1000000) + (hrTime[1] / 1000);
		return ((time - this._start) / 1000000);
	}
}

module.exports.Timer = Timer;

const __prepareResult = (result) => {
	const prepare = (chunk) => {
		if (!chunk) return chunk;

		if (chunk._id) {
			chunk.id = chunk._id;
			delete chunk._id;
		}

		if (typeof chunk === 'object') {
			Object.keys(chunk).forEach((key) => {
				if (key.indexOf('_') !== -1) {
					// return delete chunk[key];
				}

				chunk[key] = (Array.isArray(chunk[key])) ? chunk[key].map((c) => prepare(c)) : prepare(chunk[key]);
			});
		}

		return chunk;
	};

	return (Array.isArray(result)) ? result.map((c) => prepare(c)) : prepare(result);
};
module.exports.prepareResult = __prepareResult;
class JSONStringifyStream extends Transform {
	constructor(options, prepare) {
		super(Object.assign(options || {}, {objectMode: true}));

		this._first = true;
		this.prepare = prepare;
	}

	_transform(chunk, encoding, cb) {
		const nonReplacerKeys = [
			'_id', '_app', '__v', '_user', '_token',
		];

		const __replacer = (key, value) => {
			if (nonReplacerKeys.indexOf(key) !== -1) {
				return undefined;
			}
			if (Array.isArray(value)) {
				return value.map((c) => {
					if (c && c._id) c.id = c._id;
					return c;
				});
			}

			return value;
		};

		if (this.prepare) {
			chunk = this.prepare(chunk);
		} else {
			chunk = __prepareResult(chunk, this.schema, this.token);
		}

		// Dont return any blank objects
		if (chunk === null || typeof chunk === 'object' && Object.keys(chunk).length < 1) {
			return cb();
		}

		const str = JSON.stringify(chunk, __replacer);

		if (this._first) {
			this._first = false;
			this.push(`[`);
			this.push(`${str}`);
		} else {
			this.push(`,${str}`);
		}

		cb();
	}

	_flush(cb) {
		if (this._first) {
			this._first = false;
			this.push('[');
		}

		this.push(']');
		cb();
	}
}

module.exports.JSONStringifyStream = JSONStringifyStream;

module.exports.Promise = {
	prop: (prop) => ((val) => val[prop]),
	func: (func) => ((val) => val[func]()),
	nop: () => (() => null),
	inject: (value) => (() => value),
	arrayProp: (prop) => ((arr) => arr.map((a) => a[prop])),
};

module.exports.shortId = (id) => {
	const toBase = (num, base) => {
		const symbols = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-'.split('');
		let decimal = num;
		let temp;
		let output = '';

		if (base > symbols.length || base <= 1) {
			throw new RangeError(`Radix must be less than ${symbols.length} and greater than 1`);
		}

		while (decimal > 0) {
			temp = Math.floor(decimal / base);
			output = symbols[(decimal - (base * temp))] + output;
			decimal = temp;
		}

		return output;
	};

	let output = '';
	if (!id) return output;

	// HACK: need to make sure the id is in the correct format to extract the timestamp
	id = Datastore.getInstance('core').ID.new(id);

	const date = id.getTimestamp();
	let time = date.getTime();

	let counter = parseInt(id.toHexString().slice(-6), 16);
	counter = parseInt(counter.toString().slice(-3), 10);

	time = counter + time;
	output = toBase(time, 64);
	output = output.slice(3);

	return output;
};

const __flattenRoles = (data, path) => {
	if (!path) path = [];

	return data.reduce((_roles, role) => {
		const _path = path.concat(`${role.name}`);
		if (role.roles && role.roles.length > 0) {
			return _roles.concat(__flattenRoles(role.roles, _path));
		}

		const flatRole = Object.assign({}, role);
		flatRole.name = _path.join('.');
		_roles.push(flatRole);
		return _roles;
	}, []);
};
module.exports.flattenRoles = __flattenRoles;

const __flatternObject = (obj, output, paths) => {
	if (!output) output = {};
	if (!paths) paths = [];

	return Object.getOwnPropertyNames(obj).reduce(function(out, key) {
		paths.push(key);
		if (typeof obj[key] === 'object' && Datastore.getInstance('core').ID.isValid(obj[key])) {
			out[paths.join('.')] = obj[key];
		} else if (typeof obj[key] === 'object' && obj[key] !== null) {
			__flatternObject(obj[key], out, paths);
		} else {
			out[paths.join('.')] = obj[key];
		}
		paths.pop();
		return out;
	}, output);
};
module.exports.flatternObject = __flatternObject;

module.exports.mergeDeep = (...objects) => {
	const isObject = (obj) => obj && typeof obj === 'object';

	return objects.reduce((prev, obj) => {
		Object.keys(obj).forEach((key) => {
			const pVal = prev[key];
			const oVal = obj[key];

			if (Array.isArray(pVal) && Array.isArray(oVal)) {
				prev[key] = pVal.concat(...oVal);
			} else if (isObject(pVal) && isObject(oVal)) {
				prev[key] = module.exports.mergeDeep(pVal, oVal);
			} else {
				prev[key] = oVal;
			}
		});

		return prev;
	}, {});
};

const __getFlattenedSchema = (schema) => {
	const __buildFlattenedSchema = (property, parent, path, flattened) => {
		path.push(property);

		if (parent[property].__type === 'array' && parent[property].__schema) {
			// Handle Array
			for (const childProp in parent[property].__schema) {
				if (!{}.hasOwnProperty.call(parent[property].__schema, childProp)) continue;
				__buildFlattenedSchema(childProp, parent[property].__schema, path, flattened);
			}

			parent[property].__schema = __getFlattenedSchema({properties: parent[property].__schema});
			flattened[path.join('.')] = parent[property];
		} else if (typeof parent[property] === 'object' && !parent[property].__type) {
			// Handle Object
			for (const childProp in parent[property]) {
				if (!{}.hasOwnProperty.call(parent[property], childProp)) continue;
				if (childProp.indexOf('__') === 0) continue;
				__buildFlattenedSchema(childProp, parent[property], path, flattened);
			}
		} else {
			flattened[path.join('.')] = parent[property];
		}

		path.pop();
	};

	const flattened = {};
	const path = [];

	if (schema.properties) {
		for (const property in schema.properties) {
			if (!{}.hasOwnProperty.call(schema.properties, property)) continue;
			__buildFlattenedSchema(property, schema.properties, path, flattened);
		}
	}

	return flattened;
};
module.exports.getFlattenedSchema = __getFlattenedSchema;

module.exports.streamFirst = (stream) => {
	// TODO: Handle none stream being passed through

	if (!(stream !== null && typeof stream === 'object' && typeof stream.pipe === 'function')) {
		throw new Error(`Expected Stream but got '${stream}'`);
	}

	return new Promise((resolve, reject) => {
		stream.on('error', (err) => reject(err));
		stream.on('end', () => resolve(undefined));
		stream.on('data', (item) => {
			stream.destroy();
			resolve(item);
		});
	});
};
module.exports.streamAll = (stream) => {
	if (!(stream !== null && typeof stream === 'object' && typeof stream.pipe === 'function')) {
		throw new Error(`Expected Stream but got '${stream}'`);
	}

	return new Promise((resolve, reject) => {
		const arr = [];
		stream.on('error', (err) => reject(err));
		stream.on('end', () => resolve(arr));
		stream.on('data', (item) => {
			arr.push(item);
		});
	});
};

module.exports.trimSlashes = (str) => {
	return (str) ? str.replace(/^\/+|\/+$/g, '') : str;
};

module.exports.awaitAll = async (arr, handler) => await Promise.all(arr.map(async (item) => await handler(item)));
module.exports.awaitForEach = async (arr, handler) => {
	await arr.reduce(async (prev, item) => {
		await prev;
		await handler(item);
	}, Promise.resolve());
};

module.exports.checkAppPolicyProperty = async (appPolicyList, policyProperties) => {
	const res = {
		passed: true,
		errMessage: '',
	};

	if (!appPolicyList) {
		res.passed = false;
		res.errMessage = 'The app does not include a policy property list';
		return res;
	}

	const appPolicyPropertiesKeys = Object.keys(appPolicyList);
	for await (const key of Object.keys(policyProperties)) {
		if (!appPolicyPropertiesKeys.includes(key)) {
			res.passed = false;
			res.errMessage = 'Policy property key not listed';
			continue;
		}

		let operator = null;
		if (typeof policyProperties[key] === 'object') {
			[operator] = Object.keys(policyProperties[key]);
		}
		const appPolicyPropertiesValues = appPolicyList[key];
		const equalValue = (operator) ? policyProperties[key][operator] : policyProperties[key];
		if (!equalValue) {
			res.passed = false;
			res.errMessage = 'Policy property value not listed';
		}

		const appContainsProp = appPolicyPropertiesValues.every((val) => {
			if (typeof val === 'string') {
				return val.toUpperCase() !== equalValue.toUpperCase();
			}
			if (typeof val === 'boolean') {
				return val !== equalValue;
			}
			if (typeof val === 'number') {
				return val < equalValue;
			}
		});
		if (equalValue !== undefined && appContainsProp) {
			res.passed = false;
			res.errMessage = 'Policy property value not listed';
		}
	}

	return res;
};

module.exports.updateCoreSchemaObject = (body, extendedPathContext) => {
	const extendedPathContextKeys = Object.keys(extendedPathContext);
	const pattern = /\.\d+/g;
	const bodyPath = body.path.replace(pattern, '');
	if (!Array.isArray(body) && body.value && typeof body.value === 'object' && !Array.isArray(body.value)) {
		body = Object.keys(body.value).reduce((arr, key) => {
			const extendedPath = `${bodyPath}.${key}`;
			if (!extendedPathContextKeys.some((key) => key.includes(extendedPath))) return arr;

			arr.push({
				path: `${body.path}.${key}`,
				value: body.value[key],
			});

			return arr;
		}, []);
	}

	return body;
};
