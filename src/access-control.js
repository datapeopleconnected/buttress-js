const Sugar = require('sugar');
class AccessControl {
	constructor() {
		this.conditionKeys = [
			'@location',
			'@date',
			'@time',
		];
		this.logicalOperator = [
			'@and',
			'@or',
			'$and',
			'$or',
		];
		this.queryOperator = [
			'@eq',
			'@not',
			'@gt',
			'@lt',
			'@gte',
			'@lte',
			'@gtDate',
			'@gteDate',
			'@ltDate',
			'@lteDate',
			'@rex',
			'@rexi',
			'@in',
			'@nin',
			'@exists',
			'@inProp',
			'@elMatch',
		];

		this.readMethods = ['SEARCH', 'GET'];
		this.writeMethods = ['POST', 'PUT'];
	}

	async accessControlDisposition(req, userSchemaAttributes) {
		const verb = req.originalMethod;
		const disposition = userSchemaAttributes[userSchemaAttributes.length - 1].disposition;
		return (disposition[verb] === 'allow')? true : false;
	}

	async applyAccessControlPolicyConditions(userSchemaAttributes) {
		const accessControlPolicy = {
			authorised: true,
			query: null,
		};

		return userSchemaAttributes.reduce((prev, attr) => {
			return prev.then(() => {
				if (!accessControlPolicy.authorised) return;

				accessControlPolicy.authorised = this.__checkAttributeConditions(attr);
			});
		}, Promise.resolve())
			.then(() => accessControlPolicy.authorised);
	}

	__checkAttributeConditions(attr) {
		const conditions = attr.conditions;
		if (!conditions || !Object.keys(conditions).length) return true;

		let isConditionFullFilled = false;
		Object.keys(conditions).forEach((key) => {
			if (this.logicalOperator.includes(key)) {
				isConditionFullFilled = this.__checkLogicalOperatorCondition(attr, conditions[key], key, isConditionFullFilled);
			}
		});

		return isConditionFullFilled;
	}

	__checkLogicalOperatorCondition(attr, operation, operator) {
		let result = false;

		if (operator === '@and') {
			operation.forEach((conditionObj) => {
				result = this.__checkCondition(attr, conditionObj, false);
			});
		}

		if (operator === '@or') {
			operation.forEach((conditionObj) => {
				result = this.__checkCondition(attr, conditionObj);
			});
		}

		return result;
	}

	__checkCondition(attr, conditionObj, partialPass = true) {
		let passed = false;

		Object.keys(conditionObj).forEach((key) => {
			if (typeof conditionObj[key] === 'object' && !this.conditionKeys.includes(key)) {
				passed = this.__checkCondition(attr, conditionObj[key], partialPass);
				return;
			}

			Object.keys(conditionObj[key]).forEach((operator) => {
				if (!this.queryOperator.includes(operator)) {
					// TODO throw an error bad operator
					return;
				}

				let lhs = conditionObj[key][operator];
				let rhs = null;

				if (key === '@location') {
					rhs = '217.114.52.106';
				}

				if (key === '@date' || key === '@time') {
					if (!Sugar.Date.isValid(Sugar.Date.create(lhs))) {
						lhs = this.__getEnvironmentVar(attr, lhs);
					}

					rhs = Sugar.Date.create('now');
					lhs = Sugar.Date.create(lhs);
				}

				if (!lhs || !rhs) {
					// TODO throw an error for incomplete operation sides
					return;
				}

				passed = this.__evaluateOperation(lhs, rhs, operator);

				if (partialPass && passed) {
					return;
				}

				if (!partialPass && !passed) {
					return;
				}
			});
		});

		return passed;
	}

	__evaluateOperation(lhs, rhs, operator) {
		let passed = false;

		switch (operator) {
		case '@eq': {
			passed = lhs === rhs;
		}
			break;
		case '@not': {
			passed = lhs !== rhs;
		}
			break;
		case '@gt': {
			passed = lhs > rhs;
		}
			break;
		case '@lt': {
			passed = lhs < rhs;
		}
			break;
		case '@gte': {
			passed = lhs >= rhs;
		}
			break;
		case '@lte': {
			passed = lhs <= rhs;
		}
			break;
		case '@gtDate': {
			passed = Sugar.Date.isAfter(rhs, lhs);
		}
			break;
		case '@gteDate': {
			passed = Sugar.Date.isAfter(rhs, lhs) || Sugar.Date.is(rhs, lhs);
		}
			break;
		case '@ltDate': {
			passed = Sugar.Date.isBefore(rhs, lhs);
		}
			break;
		case '@lteDate': {
			passed = Sugar.Date.isBefore(rhs, lhs) || Sugar.Date.is(rhs, lhs);
		}
			break;
		case '@rex': {
			const regex = new RegExp(rhs);
			passed = regex.test(lhs);
		}
			break;
		case '@rexi': {
			const regex = new RegExp(rhs, 'i');
			passed = regex.test(lhs);
		}
			break;
		case '@in': {
			passed = lhs.some((i) => i === rhs);
		}
			break;
		case '@nin': {
			passed = lhs.every((i) => i !== lhs);
		}
			break;
		case '@exists': {
			passed = lhs.includes(rhs);
		}
			break;
		default:
		}

		return passed;
	}

	async addAccessControlPolicyQuery(req, userSchemaAttributes) {
		let allowedUpdates = false;

		return userSchemaAttributes.reduce((prev, attr) => {
			return prev.then(() => {
				return this.__addAccessControlPolicyAttributeQuery(req, attr.query)
					.then(() => allowedUpdates = this.__addAccessControlPolicyQueryProjection(req, attr.properties));
			});
		}, Promise.resolve())
			.then(() => allowedUpdates);
	}

	__addAccessControlPolicyAttributeQuery(req, attributeQuery) {
		return this.__convertPrefixToQueryPrefix(attributeQuery)
			.then((translatedQuery) => {
				if (!req.accessControlQuery) {
					req.accessControlQuery = {};
				}

				Object.keys(translatedQuery).forEach((key) => {
					if (!Object.keys(translatedQuery[key]).length) return;

					if (req.accessControlQuery[key] && Array.isArray(req.accessControlQuery[key]) && Array.isArray(translatedQuery[key])) {
						translatedQuery[key].forEach((elem) => {
							const elementExist = req.accessControlQuery[key].findIndex((el) => JSON.stringify(el) === JSON.stringify(elem));
							if (elementExist !== -1) return;

							req.accessControlQuery[key].push(elem);
						});
						return;
					}

					req.accessControlQuery[key] = translatedQuery[key];
				});
			});
	}

	__addAccessControlPolicyQueryProjection(req, props) {
		const requestBody = req.body;
		const isUpdate = Array.isArray(requestBody);
		const requestMethod = req.originalMethod;
		const method = (this.readMethods.includes(requestMethod))? 'READ' : (this.writeMethods.includes(req.originalMethod))? 'WRITE' : 'DEL';
		const projectionUpdateKeys = Object.keys(props).map((key) => {
			if (props[key].includes('WRITE')) {
				return key;
			}
		})
			.filter((v) => v);
		const projection = {};
		let allowedUpdates = false;

		Object.keys(props).forEach((key) => {
			if (props[key].includes(method)) {
				projection[key] = 1;
			}
		});

		req.body.project = projection;

		if (isUpdate && (method === 'WRITE' || method === 'DEL')) {
			const updatePaths = requestBody.map((elem) => elem.path);
			const allowedPathUpdates = projectionUpdateKeys.filter((key) => updatePaths.some((updateKey) => updateKey === key));
			if (allowedPathUpdates.length === updatePaths.length) {
				allowedUpdates = true;
			}
		} else {
			allowedUpdates = true;
		}


		return allowedUpdates;
	}

	__convertPrefixToQueryPrefix(obj, baseKey = null, newObj = {}) {
		return Object.keys(obj).reduce((prev, key) => {
			return prev.then(() => {
				if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
					return this.__convertPrefixToQueryPrefix(obj[key], key, newObj);
				}

				if (Array.isArray(obj[key])) {
					return this.__convertPrefixQueryArray(obj[key], key, newObj);
				}

				if (!newObj[baseKey]) {
					newObj[baseKey] = {};
				}

				const newKey = this.__replacePrefix(key);
				newObj[baseKey][newKey] = obj[key];
			});
		}, Promise.resolve())
			.then(() => newObj);
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

	async applyAccessControlPolicyQuery(req) {
		const accessControlPrompt = req.authApp.accessControlPrompt;
		const accessControlQuery = req.accessControlQuery;
		let queryModified = false;

		if (!accessControlQuery) return;

		const reqQuery = (req.body.query)? req.body.query : null;

		if (!reqQuery) {
			req.body.query = accessControlQuery;
			return;
		}

		if (reqQuery === accessControlQuery) return;

		Object.keys(accessControlQuery).forEach((key) => {
			if (Array.isArray(accessControlQuery[key]) && this.logicalOperator.includes(key)) {
				queryModified = this.__crossCheckAccessControlMatchLogicalOperation(reqQuery, accessControlQuery, key);
				return;
			}

			if (Array.isArray(accessControlQuery[key]) && !this.logicalOperator.includes(key)) {
				// TODO throw an error for invalid logical operation
				return;
			}

			queryModified = this.__addAccessControlQueryPropertyToOriginalQuery(reqQuery, accessControlQuery, key);
		});

		if (!accessControlPrompt && queryModified) {
			// return zero results as the query is modified
			reqQuery['zeroResults'] = true;
		}
	}

	__crossCheckAccessControlMatchLogicalOperation(originalQuery, accessControlQuery, key) {
		let modifiedQuery = false;
		const accessControlQueryLogicalArr = accessControlQuery[key];
		if (!accessControlQueryLogicalArr) return modifiedQuery;

		const originalQueryLogicalArr = originalQuery[key];
		if (!originalQueryLogicalArr) {
			return this.__prioritiseAccessControlQuery(accessControlQueryLogicalArr, originalQuery, key);
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

				// TODO prompt the user that one of the property does not match their access control policies or return different results that expected
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
				// 	[acKey]: accessControlQuery[acKey],
				// };

				// TODO prompt the user that one of the property does not match their access control policies or return different results that expected
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
				// TODO prompt the user that one of the property does not match their access control policies or return different results that expected
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
		}, []);

		originalQueryKeys.forEach((key) => {
			if (accessControlQueryKeys.includes(key)) {
				// TODO prompt the user that one of the property does not match their access control policies or return different results that expected
				const keyIndex = accessControlLogicalArr.findIndex((obj) => Object.keys(obj).some((i) => i === key));
				if (JSON.stringify(accessControlLogicalArr[keyIndex][key]) !== JSON.stringify(originalQuery[key])) {
					modifiedQuery = true;
					delete originalQuery[key];
				}
			}
		});

		return modifiedQuery;
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

	__getEnvironmentVar(attr, environmentVar) {
		const path = environmentVar.split('.');
		let val = null;
		let obj = attr;

		path.forEach((key) => {
			if (val && !Array.isArray(val) && typeof val === 'object') {
				obj = val;
			}
			val = this.__getObjectValByPathKey(obj, key);
			if (!val) return;
		});

		return val;
	}

	__getObjectValByPathKey(obj, key) {
		let value = null;

		if (obj && obj[key]) {
			value = obj[key];
		}

		return value;
	}
}
module.exports = new AccessControl();
