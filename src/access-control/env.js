const Model = require('../model');
const shortId = require('../helpers').shortId;

/**
 * @class PolicyEnv
 */
class PolicyEnv {
	constructor() {}

	async getQueryEnvironmentVar(environmentKey, envVars, appId, authUser) {
		if (!environmentKey || !environmentKey.includes('env')) return environmentKey;

		const path = environmentKey.replace('env', '').split('.').filter((v) => v);
		const queryValue = path.reduce((obj, str) => obj?.[str], envVars);

		const [root] = queryValue.split('.');
		const isUserSchema = await this.__isUserSchema(root);
		const isAppSchema = await this.__isAppSchema(root, appId);
		if (isUserSchema) {
			return this.__getUserSchemaEnvValue(root, authUser, queryValue);
		}

		if (isAppSchema) {
			return this.__getAppSchemaEnvValue(queryValue);
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

	async __getAppSchemaEnvValue() {
		return '';
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
