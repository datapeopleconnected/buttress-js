'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

import {ObjectId} from 'bson';
import * as Helpers from '../helpers';

import Model from '../model';
import e from 'express';

class PolicyEnv {
	private _globalQueryEnv: {[index: string]: string} = {};

	queryOperator: {[index: string]: string};

	constructor() {
		this.queryOperator = {
			'@eq': '$eq',
			'@not': '$not',
			'@gt': '$gt',
			'@lt': '$lt',
			'@gte': '$gte',
			'@lte': '$lte',
			'@gtDate': '$gtDate',
			'@gteDate': '$gteDate',
			'@ltDate': '$ltDate',
			'@lteDate': '$lteDate',
			'@rex': '$rex',
			'@rexi': '$rexi',
			'@in': '$in',
			'@nin': '$nin',
			'@exists': '$exists',
			'@inProp': '$inProp',
			'@elMatch': '$elMatch',
		};
	}

	async getQueryEnvironmentVar(environmentKey, envVars, appId, authUser, conditionFlag = false) {
		if ((!environmentKey || !environmentKey.includes('env')) && !conditionFlag) return environmentKey;

		const path = environmentKey.replace('env', '').split('.').filter((v) => v);
		const queryValue = path.reduce((obj, str) => obj?.[str], envVars);

		let root: string | null = null;
		if (typeof queryValue === 'string') {
			[root] = queryValue.split('.');
		} else if (typeof queryValue === 'object') {
			root = queryValue.collection;
		}

		const isUserSchema = await this.__isUserSchema(root);
		const isAppSchema = await this.__isAppSchema(root, appId);
		if (isUserSchema) {
			return this.__getUserSchemaEnvValue(root, authUser, queryValue);
		}

		if (isAppSchema) {
			return this.__getAppSchemaEnvValue(appId, authUser, envVars, queryValue);
		}

		return this._globalQueryEnv?.[queryValue];
	}

	async __isUserSchema(schema) {
		if (!schema) return false;
		return Model.coreSchema.some((s) => s.toUpperCase() === schema.toUpperCase()) && schema.toUpperCase() === 'USER';
	}

	async __isAppSchema(schema, appId) {
		if (!schema) return false;
		const appShortId = Helpers.shortId(appId);
		return (Model[`${appShortId}-${schema}`]) ? true : false;
	}

	async __getUserSchemaEnvValue(schema, authUser, path) {
		path = path.replace(schema, '');
		return this.__getObjValueByPath(authUser, path);
	}

	async __getAppSchemaEnvValue(appId, user, envVars, envObj) {
		const schema = envObj.collection;
		const query = this.__replaceOperatorKey(envObj.query);
		const output = envObj.output;
		const outputType = envObj.type;
		const lookUpObject = {
			user,
		};

		const appShortId = Helpers.shortId(appId);
		for await (const key of Object.keys(query)) {
			if (typeof query[key] !== 'object') throw new Error(`env query needs to be a query object ${query[key]}`);
			const operator = Object.values(this.queryOperator).find((op) => Object.keys(query[key]).every((key) => key === op));
			if (!operator) throw new Error(`Can not find an operator for ${query[key]}`);

			const dbQuery = query[key][operator];
			if (typeof dbQuery !== 'string') continue;

			const queryValue = dbQuery.split('.');
			const [queryCollection] = queryValue;
			if (lookUpObject[queryCollection]) {
				query[key][operator] = await this.__getObjValueByPath(lookUpObject[queryCollection], dbQuery.replace(queryCollection, ''));
			} else if (queryCollection === 'env') {
				const envVariable = dbQuery.replace(`${queryCollection}.`, '');
				const envRes = await this.__getAppSchemaEnvValue(appId, user, envVars, envVars[envVariable]);
				query[key][operator] = envRes;
			}
		}

		const res = await (Model[`${appShortId}-${schema}`]).find(query);
		const result = await Helpers.streamAll(res);
		if (!result) return false;

		if (outputType === 'string' || outputType === 'id') {
			return result.reduce((item, obj) => {
				item = obj[output.key];
				if (output.type === 'id') {
					item = new ObjectId(item);
				}

				return item;
			}, '');
		}

		if (outputType === 'array' && result.length > 0) {
			return result.reduce((arr, obj) => {
				if (output.type === 'id' && Array.isArray(obj[output.key])) {
					obj[output.key] = obj[output.key].map((id) => new ObjectId(id));
				} else if (output.type === 'id') {
					obj[output.key] = new ObjectId(obj[output.key]);
				}

				arr = arr.concat(obj[output.key]);
				return arr;
			}, []);
		}
		if (outputType === 'boolean' && result.length > 0) {
			return result.every((obj) => obj[output.key]);
		}

		return (result.length > 0 && result[output]) ? result[output] : (outputType === 'array') ? [] : '';
	}

	__getObjValueByPath(obj, path) {
		const keys = path.split('.').filter((v) => v);
		let value = obj;
		for (const key of keys) {
			value = value[key];
			path = path.replace(key, '');

			if (typeof value === 'object' && !Array.isArray(value)) {
				return this.__getObjValueByPath(value, path);
			}

			if (Array.isArray(value)) {
				return this.__getArrObjValue(value, path);
			}
		}

		return value;
	}

	__getArrObjValue(arr, path) {
		return arr.reduce((arr, value) => {
			arr.push(this.__getObjValueByPath(value, path));

			return arr;
		}, []);
	}

	__replaceOperatorKey(obj) {
		if (!obj || typeof obj !== 'object') {
			return obj; // Return the input if it's not an object
		}

		const newObj = {};
		for (const key of Object.keys(obj)) {
			const value = obj[key];
			const updatedKey = this.queryOperator[key] || key;
			newObj[updatedKey] = this.__replaceOperatorKey(value); // Recursively update nested objects
		}
		return newObj;
	}
}
export default new PolicyEnv();
