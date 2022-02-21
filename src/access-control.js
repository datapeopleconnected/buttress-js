const Sugar = require('sugar');

const Helpers = require('./helpers');
const Shared = require('./model/shared');
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

		this.IPv4Regex = /((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.|$)){4}/g;
		this.IPv6Regex = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/g;
	}

	async accessControlDisposition(req, userSchemaAttributes) {
		const verb = req.originalMethod;
		const disposition = userSchemaAttributes[userSchemaAttributes.length - 1].disposition;
		return (disposition[verb] === 'allow')? true : false;
	}

	__requestIPAddress(req) {
		const requestIPAddress = {};
		const proxyIPAddress = {};

		if (req['x-client-ip']) {
			requestIPAddress['x-client-ip'] = req['x-client-ip'];
		}

		if (req['x-forwarded-for']) {
			proxyIPAddress['x-forwarded-for'] = req['x-forwarded-for'];
		}

		if (req['cf-connecting-ip']) {
			requestIPAddress['cf-connecting-ip'] = req['cf-connecting-ip'];
		}

		if (req['fastly-client-ip']) {
			requestIPAddress['fastly-client-ip'] = req['fastly-client-ip'];
		}

		if (req['true-client-ip']) {
			requestIPAddress['true-client-ip'] = req['true-client-ip'];
		}

		if (req['x-real-ip']) {
			requestIPAddress['x-real-ip'] = req['x-real-ip'];
		}

		if (req['x-cluster-client-ip']) {
			requestIPAddress['x-cluster-client-ip'] = req['x-cluster-client-ip'];
		}

		if (req['x-forwarded'] || req['forwarded-for'] || req['forwarded']) {
			proxyIPAddress['x-forwarded'] = req['x-forwarded'] || req['forwarded-for'] || req['forwarded'];
		}

		if (req.connection && req.connection.remoteAddress) {
			requestIPAddress.connectionRemoteAddress = req.connection.remoteAddress;
		}

		if (req.socket && req.socket.remoteAddress) {
			requestIPAddress.socketRemoteAddress = req.socket.remoteAddress;
		}

		if (req.connection && req.connection.socket && req.connection.socket.remoteAddress) {
			requestIPAddress.connectionSocketRemoteAddress = req.connection.socket.remoteAddress;
		}

		if (req.info && req.info.remoteAddress) {
			requestIPAddress.infoRemoteAddress = req.info.remoteAddress;
		}

		const proxyClientIP = Object.keys(proxyIPAddress).reduce((arr, key) => {
			const ipAddress = this.__getClientIpFromXForwardedFor(key);
			if (ipAddress) {
				arr.push(ipAddress);
			}

			return arr;
		}, []);

		if (proxyClientIP.length > 0) {
			return proxyClientIP.shift();
		}

		const clientIP = Object.keys(requestIPAddress).reduce((arr, key) => {
			const IPv4 = requestIPAddress[key].match(this.IPv4Regex).pop();
			const IPv6 = requestIPAddress[key].match(this.IPv6Regex).pop();
			arr.push((IPv4)? IPv4 : IPv6);

			return arr;
		}, []);

		const firstClientIP = clientIP.slice().pop();
		const isDiffIPs = clientIP.every((ipAddress) => ipAddress === firstClientIP);
		if (isDiffIPs) {
			// should throw an error?
		}

		return firstClientIP;
	}

	__getClientIpFromXForwardedFor(str) {
		const forwardedIPs = str.split(',').map((ip) => {
			ip = ip.trim();
			if (ip.includes(':')) {
				const splitted = ip.split(':');
				// make sure we only use this if it's ipv4 (ip:port)
				if (splitted.length === 2) {
					return splitted[0];
				}
			}

			return ip;
		});

		return forwardedIPs.find((ip) => {
			return ip.match(this.IPv4Regex) || ip.match(this.IPv6Regex);
		});
	}

	async applyAccessControlPolicyConditions(req, userSchemaAttributes) {
		const accessControlPolicy = {
			authorised: true,
			query: null,
		};

		return userSchemaAttributes.reduce((prev, attr) => {
			return prev.then(() => {
				if (!accessControlPolicy.authorised) return;

				accessControlPolicy.authorised = this.__checkAttributeConditions(req, attr);
			});
		}, Promise.resolve())
			.then(() => accessControlPolicy.authorised);
	}

	__checkAttributeConditions(req, attr) {
		const conditions = attr.conditions;
		if (!conditions || !Object.keys(conditions).length) return true;

		let isConditionFullFilled = false;
		Object.keys(conditions).forEach((key) => {
			if (this.logicalOperator.includes(key)) {
				isConditionFullFilled = this.__checkLogicalOperatorCondition(req, attr, conditions[key], key);
			}
		});

		return isConditionFullFilled;
	}

	__checkLogicalOperatorCondition(req, attr, operation, operator) {
		let result = false;

		if (operator === '@and') {
			operation.forEach((conditionObj) => {
				result = this.__checkCondition(req, attr, conditionObj, false);
			});
		}

		if (operator === '@or') {
			operation.forEach((conditionObj) => {
				result = this.__checkCondition(req, attr, conditionObj);
			});
		}

		return result;
	}

	__checkCondition(req, attr, conditionObj, partialPass = true) {
		let passed = false;

		Object.keys(conditionObj).forEach((key) => {
			const conditionKey = key.replace('env.', '');
			if (typeof conditionObj[key] === 'object' && !this.conditionKeys.includes(conditionKey)) {
				passed = this.__checkCondition(req, attr, conditionObj[key], partialPass);
				return;
			}

			Object.keys(conditionObj[key]).forEach((operator) => {
				if (!this.queryOperator.includes(operator)) {
					// TODO throw an error bad operator
					return;
				}

				let lhs = conditionObj[key][operator];
				let rhs = this.__getEnvironmentVar(attr, key);

				if (conditionKey === '@location') {
					if (!lhs.match(this.IPv4Regex) && !lhs.match(this.IPv6Regex)) {
						lhs = this.__getEnvironmentVar(attr, lhs);
					}

					rhs = this.__requestIPAddress(req);
				}

				if (conditionKey === '@date' || conditionKey === '@time') {
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

	async addAccessControlPolicyQuery(req, userSchemaAttributes, schema) {
		let allowedUpdates = false;

		return userSchemaAttributes.reduce((prev, attr) => {
			return prev.then(() => {
				return this.__addAccessControlPolicyAttributeQuery(req, attr.query)
					.then(() => allowedUpdates = this.__addAccessControlPolicyQueryProjection(req, attr.properties, schema));
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

	__addAccessControlPolicyQueryProjection(req, props, schema) {
		const requestBody = req.body;
		const requestMethod = (req.originalMethod === 'SEARCH')? 'GET' : req.originalMethod;
		const flattenedSchema = Helpers.getFlattenedSchema(schema);
		const projectionUpdateKeys = [];
		const projection = {};
		let allowedUpdates = false;

		Object.keys(props).forEach((key) => {
			console.log('requestMethod', requestMethod);
			console.log('props[key]', props[key]);
			if (props[key].includes(requestMethod)) {
				projectionUpdateKeys.push(key);
				projection[key] = 1;
			}
		});

		if (requestMethod === 'POST') {
			const updatePaths = Object.keys(requestBody).map((key) => key);
			const removedPaths = updatePaths
				.filter((key) => projectionUpdateKeys.every((updateKey) => updateKey !== key))
				.filter((path) => flattenedSchema[path]);

			removedPaths.forEach((i) => {
				// TODO think about required fields that users do not have write access to
				const config = flattenedSchema[i];
				requestBody[i] = Shared.getPropDefault(config);
			});

			allowedUpdates = true;
		} else if (requestMethod === 'PUT') {
			const updatePaths = requestBody.map((elem) => elem.path);
			const allowedPathUpdates = projectionUpdateKeys.filter((key) => updatePaths.some((updateKey) => updateKey === key));
			if (allowedPathUpdates.length === updatePaths.length) {
				allowedUpdates = true;
			}
		} else {
			allowedUpdates = true;
		}

		req.body.project = projection;
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
		const path = environmentVar.replace('@', '').split('.');
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
