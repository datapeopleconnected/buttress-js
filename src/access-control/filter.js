const shortId = require('../helpers').shortId;
const Model = require('../model');

/**
 * @class Filter
 */
class Filter {
	constructor() {
		this.logicalOperator = [
			'@and',
			'@or',
			'$and',
			'$or',
		];

		this._globalQueryEnv = {
			authUserId: null,
			personId: null,
		};
	}

	async addAccessControlPolicyQuery(req, userPolicies) {
		this._globalQueryEnv.authUserId = req.authUser?._id;

		await Object.keys(userPolicies).reduce(async (prev, key) => {
			await prev;
			await userPolicies[key].query.reduce(async (prev, q) => {
				await prev;
				await this.addAccessControlPolicyRuleQuery(req, q, 'accessControlQuery', userPolicies[key].env);
			}, Promise.resolve());
		}, Promise.resolve());
	}

	async addAccessControlPolicyRuleQuery(req, policyQuery, str, env = null) {
		const translatedQuery = await this.__convertPrefixToQueryPrefix(policyQuery);
		if (!req[str]) {
			req[str] = {};
		}

		if (translatedQuery === null) return req[str];

		await Object.keys(translatedQuery).reduce(async (prev, key) => {
			await prev;

			if (!Object.keys(translatedQuery[key]).length) return;
			if (req[str][key] && Array.isArray(req[str][key]) && Array.isArray(translatedQuery[key])) {
				await translatedQuery[key].reduce(async (prev, elem) => {
					await prev;

					const elementExist = req[str][key].findIndex((el) => {
						return JSON.stringify(el) === JSON.stringify(elem);
					});

					if (elementExist !== -1) return;
					req[str][key].push(elem);
				}, Promise.resolve());

				return;
			}

			if (req.authApp && req.authApp._id) {
				await this.__substituteEnvVariables(translatedQuery[key], env, req.authApp._id);
			}

			req[str][key] = translatedQuery[key];
		}, Promise.resolve());
	}

	async __substituteEnvVariables(obj, env, appId) {
		for await (const key of Object.keys(obj)) {
			obj[key] = await this.getQueryEnvironmentVar(obj[key], env, appId);
		}
	}

	async getQueryEnvironmentVar(environmentKey, envVars, appId) {
		if (!environmentKey.includes('env')) return environmentKey;

		const path = environmentKey.replace('env', '').split('.').filter((v) => v);
		const queryValue = path.reduce((obj, str) => obj?.[str], envVars);

		if (queryValue === 'personId') {
			const appShortId = shortId(appId);
			const person = await Model[`${appShortId}-people`].findOne({authId: this._globalQueryEnv.authUserId});
			this._globalQueryEnv.personId = person._id;
		}

		return this._globalQueryEnv?.[queryValue];
	}

	async applyAccessControlPolicyQuery(req) {
		const accessControlQuery = req.accessControlQuery;

		if (!accessControlQuery) return;

		const reqQuery = (req.body.query)? req.body.query : null;

		if (!reqQuery) {
			req.body.query = accessControlQuery;
			return;
		}

		if (reqQuery === accessControlQuery) return;

		Object.keys(accessControlQuery).forEach((key) => {
			if (Array.isArray(accessControlQuery[key]) && this.logicalOperator.includes(key)) {
				this.__crossCheckAccessControlMatchLogicalOperation(reqQuery, accessControlQuery, key);
				return;
			}

			if (Array.isArray(accessControlQuery[key]) && !this.logicalOperator.includes(key)) {
				// TODO throw an error for invalid logical operation
				return;
			}

			this.__addAccessControlQueryPropertyToOriginalQuery(reqQuery, accessControlQuery, key);
		});
	}

	__crossCheckAccessControlMatchLogicalOperation(originalQuery, accessControlQuery, key) {
		let modifiedQuery = false;
		const accessControlQueryLogicalArr = accessControlQuery[key];
		if (!accessControlQueryLogicalArr) return modifiedQuery;

		const originalQueryLogicalArr = originalQuery[key];
		if (!originalQueryLogicalArr) {
			modifiedQuery = this.__prioritiseAccessControlQuery(accessControlQueryLogicalArr, originalQuery, key);

			if (!modifiedQuery) {
				originalQuery[key] = accessControlQuery[key];
			}

			return modifiedQuery;
			// or modify query and return different results
			// originalQuery[key] = accessControlQueryLogicalArr;
		}

		const originalQueryKeys = originalQueryLogicalArr.reduce((arr, obj) => {
			Object.keys(obj).forEach((key) => arr.push(key));

			return arr;
		}, []);

		accessControlQueryLogicalArr.forEach((accessControlObj) => {
			Object.keys(accessControlObj).forEach((aKey) => {
				if (originalQueryKeys.includes(aKey)) {
					const keyIndex = originalQuery[key].findIndex((obj) => Object.keys(obj).some((i) => i === aKey));
					if (JSON.stringify(originalQuery[key][keyIndex][aKey]) !== JSON.stringify(accessControlObj[aKey])) {
						modifiedQuery = true;
					}

					// We can change the query to return the data that a user can access
					// originalQuery[key][keyIndex] = {
					// 	[aKey]: accessControlObj[aKey],
					// };

					// TODO should prompt the user to tell them that they do not have access to these property or send empty array
					return;
				}

				// TODO prompt the user that one of the property doesn't match their access control policies or return different results that expected
				originalQuery[key].push(accessControlObj);
			});
		});

		Object.keys(accessControlQuery).forEach((acKey) => {
			if (acKey === key) return;

			if (originalQueryKeys.includes(acKey)) {
				const keyIndex = originalQuery[key].findIndex((orgKeyObj) => Object.keys(orgKeyObj).some((orgKey) => orgKey == acKey));

				if (JSON.stringify(originalQuery[key][keyIndex]) !== accessControlQuery[acKey]) {
					modifiedQuery = true;
				}

				// We can change the query to return the data that a user can access
				// originalQuery[key][keyIndex] = {
				// [acKey]: accessControlQuery[acKey],
				// };

				// TODO prompt the user that one of the property doesn't match their access control policies or return different results that expected
			}
		});

		return modifiedQuery;
	}

	__addAccessControlQueryPropertyToOriginalQuery(originalQuery, accessControlQuery, key) {
		const originalQueryObj = originalQuery[key];
		const accessControlQueryObj = accessControlQuery[key];
		let operandKey = null;

		this.logicalOperator.forEach((operator) => {
			if (!originalQuery[operator]) return;

			originalQuery[operator].forEach((obj) => {
				Object.keys(obj).forEach((objKey) => {
					if (objKey === key) {
						operandKey = operator;
					}
				});
			});
		});

		if (!originalQueryObj && operandKey && accessControlQueryObj) {
			const originalKeyIndex = originalQuery[operandKey].findIndex((obj) => Object.keys(obj).some((i) => i === key));
			if (JSON.stringify(accessControlQueryObj) !== JSON.stringify(originalQuery[operandKey][originalKeyIndex])) {
				// TODO needs to give the option to return an error at the minute it returns zero results
				return true;
			} else {
				// TODO prompt the user that one of the property doesn't match their access control policies or return different results that expected
			}

			return false;
		}

		if ((!originalQueryObj && !operandKey)) {
			// TODO maybe prompt the user as well to tell them that access control policies modified their query
			originalQuery[key] = accessControlQueryObj;
			return false;
		}

		if (originalQueryObj && JSON.stringify(originalQueryObj) !== JSON.stringify(accessControlQueryObj)) {
			return true;
		}
	}

	__prioritiseAccessControlQuery(accessControlLogicalArr, originalQuery) {
		let modifiedQuery = false;
		const originalQueryKeys = this.__getQueryKeys(originalQuery);

		const accessControlQueryKeys = accessControlLogicalArr.reduce((arr, obj) => {
			Object.keys(obj).forEach((key) => {
				arr.push(key);
			});

			return arr;
		}, [])
			.filter((v, idx, arr) => arr.indexOf(v) === idx);

		originalQueryKeys.forEach((key) => {
			if (accessControlQueryKeys.includes(key)) {
				// TODO prompt the user that one of the property doesn't match their access control policies or return different results that expected
				const keyIndex = accessControlLogicalArr.findIndex((obj) => Object.keys(obj).some((i) => i === key));
				if (JSON.stringify(accessControlLogicalArr[keyIndex][key]) !== JSON.stringify(originalQuery[key])) {
					modifiedQuery = true;
					delete originalQuery[key];
				}
			}
		});

		return modifiedQuery;
	}

	async __convertPrefixToQueryPrefix(obj, baseKey = null, newObj = {}) {
		if (obj === null) return null;

		for await (const key of Object.keys(obj)) {
			if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
				await this.__convertPrefixToQueryPrefix(obj[key], key, newObj);
				continue;
			}

			if (Array.isArray(obj[key]) && this.logicalOperator.includes(key)) {
				await this.__convertPrefixQueryArray(obj[key], key, newObj);
				continue;
			}

			if (!newObj[baseKey]) {
				newObj[baseKey] = {};
			}

			const newKey = this.__replacePrefix(key);
			newObj[baseKey][newKey] = obj[key];
		}

		return newObj;
	}

	__convertPrefixQueryArray(arr, key, newObj) {
		let logicalKey = null;
		if (this.logicalOperator.includes(key)) {
			logicalKey = this.__replacePrefix(key);
			newObj[logicalKey] = [];
		}

		if (!logicalKey) {
			// TODO throw new error if logical operator is not supported
			return;
		}

		return arr.reduce((prev, obj) => {
			return prev.then(() => {
				return this.__convertPrefixToQueryPrefix(obj)
					.then((convertedObj) => {
						newObj[logicalKey].push(convertedObj);
					});
			});
		}, Promise.resolve());
	}

	__getQueryKeys(query, baseKey = null) {
		return Object.keys(query).reduce((arr, key) => {
			if (key === '__crPath') return arr;

			if (!baseKey) {
				arr.push(key);
			} else {
				arr.push(`${baseKey}-${key}`);
			}

			if (Array.isArray(query[key])) {
				query[key].forEach((elem) => {
					arr = arr.concat(this.__getQueryKeys(elem, key));
				});
			}

			return arr;
		}, []);
	}

	__replacePrefix(str) {
		return str.replace('@', '$');
	}
}
module.exports = new Filter();
