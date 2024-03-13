const {ObjectId} = require('mongodb');
const Helpers = require('../helpers');

const Model = require('../model');
const shortId = require('../helpers').shortId;

/**
 * @class PolicyEnv
 */
class PolicyEnv {
	constructor() {
		this.queryOperator = [
			'$eq',
			'$not',
			'$gt',
			'$lt',
			'$gte',
			'$lte',
			'$gtDate',
			'$gteDate',
			'$ltDate',
			'$lteDate',
			'$rex',
			'$rexi',
			'$in',
			'$nin',
			'$exists',
			'$inProp',
			'$elMatch',
		];
	}

	async getQueryEnvironmentVar(environmentKey, envVars, appId, authUser, conditionFlag = false) {
		if ((!environmentKey || !environmentKey.includes('env')) && !conditionFlag) return environmentKey;

		const path = environmentKey.replace('env', '').split('.').filter((v) => v);
		const queryValue = path.reduce((obj, str) => obj?.[str], envVars);

		let root = null;
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
		return Model.coreSchema.some((s) => s.toUpperCase() === schema.toUpperCase()) && schema.toUpperCase() === 'USER';
	}

	async __isAppSchema(schema, appId) {
		const appShortId = shortId(appId);
		return (Model[`${appShortId}-${schema}`]) ? true : false;
	}

	async __getUserSchemaEnvValue(schema, authUser, path) {
		path = path.replace(schema, '');
		return this.__getObjValueByPath(authUser, path);
	}

	async __getAppSchemaEnvValue(appId, user, envVars, envObj) {
		const schema = envObj.collection;
		const query = envObj.query;
		const output = envObj.output;
		const outputType = envObj.type;
		const lookUpObject = {
			user,
		};

		const appShortId = shortId(appId);
		for await (const key of Object.keys(query)) {
			if (typeof query[key] !== 'object') throw new Error(`env query needs to be a query object ${query[key]}`);
			const operator = this.queryOperator.find((op) => Object.keys(query[key]).every((key) => key === op));
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

		return (result.length > 0 && result[output]) ? result[output] : false;
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
}
module.exports = new PolicyEnv();
