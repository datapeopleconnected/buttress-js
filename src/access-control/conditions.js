const Sugar = require('sugar');

const accessControlHelpers = require('./helpers');
const Filter = require('./filter');
const Helpers = require('../helpers');
const Model = require('../model');

/**
 * @class Conditoins
 */
class Conditions {
	constructor() {
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

		this.conditionKeys = [
			'@location',
			'@date',
			'@time',
		];

		this.logicalOperator = [
			'@and',
			'@or',
		];

		this.conditionEndRange = [
			'@gt',
			'@gte',
			'@gtDate',
			'@gteDate',
		];

		this.IPv4Regex = /((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.|$)){4}/g;
		// eslint-disable-next-line max-len
		this.IPv6Regex = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/g;

		this.conditionQueryRegex = new RegExp('query.');
		this.envStr = 'env.';
		this.appShortId = null;
		this.passedCondition = {
			partial: false,
			full: true,
		};
	}

	async applyPolicyConditions(req, userPolicies) {
		if (!this.appShortId) {
			this.appShortId = Helpers.shortId(req.authApp._id);
		}
		return await Object.keys(userPolicies).reduce(async (prev, policyKey) => {
			await prev;
			await this.__checkPolicyConditions(req, userPolicies, policyKey);
		}, Promise.resolve());
	}

	async __checkPolicyConditions(req, userPolicies, key) {
		const conditions = userPolicies[key].conditions;
		if (!conditions || !conditions.length) return;

		let isConditionFullFilled = null;
		await conditions.reduce(async (prev, condition) => {
			await prev;

			if (!isConditionFullFilled && isConditionFullFilled !== null) {
				return;
			}

			isConditionFullFilled = await this.__checkLogicalCondition(req, condition, userPolicies[key].env);
		}, Promise.resolve());

		if (!isConditionFullFilled) {
			delete userPolicies[key];
		}
	}

	async __checkLogicalCondition(req, condition, envVariables) {
		this.passedCondition.partial = false;
		let result = false;

		await Object.keys(condition).reduce(async (prev, key) => {
			await prev;

			const obj = condition[key];
			const partialPass = (key === '@or') ? true : false;
			this.passedCondition.full = (!partialPass) ? true : false;
			if (this.logicalOperator.includes(key)) {
				await obj.reduce(async (prev, conditionObj) => {
					await prev;
					result = await this.__checkCondition(req, envVariables, conditionObj, false, partialPass);
				}, Promise.resolve());
			} else {
				result = await this.__checkCondition(req, envVariables, condition, false, false);
			}
		}, Promise.resolve());

		return result;
	}

	async __checkCondition(req, envVar, conditionObj, passed, partialPass) {
		const objectKeys = Object.keys(conditionObj);

		for await (const key of objectKeys) {
			passed = await this.__checkInnerConditions(req, envVar, conditionObj, key, passed, partialPass);
			if (this.conditionKeys.includes(`@${key}`)) continue;

			if (partialPass && passed) {
				this.passedCondition.partial = true;
			}

			if (!passed) {
				this.passedCondition.full = false;
			}
		}

		return (partialPass)? this.passedCondition.partial : this.passedCondition.full;
	}

	async __checkInnerConditions(req, envVar, conditionObj, key, passed, partialPass) {
		const conditionKey = key.replace(this.envStr, '');
		const isSchemaQuery = this.conditionQueryRegex.test(conditionKey);

		if (this.passedCondition.partial) {
			return true;
		}

		if (typeof conditionObj[key] === 'object' && !this.conditionKeys.includes(conditionKey) && !isSchemaQuery) {
			return await this.__checkCondition(req, envVar, conditionObj[key], passed, partialPass);
		}

		if (isSchemaQuery) {
			const varSchemaKey = key.replace('query.', '');
			const dbConditionQuery = Object.assign({}, envVar[varSchemaKey]);
			this.__buildDbConditionQuery(envVar, conditionObj[key], varSchemaKey, dbConditionQuery);

			return await this.__getDbConditionQueryResult(dbConditionQuery, varSchemaKey);
		}

		return await Object.keys(conditionObj[key]).reduce(async (innerPrev, operator) => {
			await innerPrev;
			return await this.__checkConditionQuery(req, envVar, operator, conditionObj, key, conditionKey);
		}, Promise.resolve());
	}

	__buildDbConditionQuery(envVariables, conditions, varSchemaKey, query = {}) {
		Object.keys(conditions).forEach((key) => {
			const value = conditions[key];
			const queryKey = key.replace(`${varSchemaKey}.`, '');
			if (query[queryKey]) {
				query[queryKey] = value;
			}

			if (!Array.isArray(value) && typeof value === 'object') {
				this.__buildDbConditionQuery(envVariables, value, varSchemaKey, query);
			} else {
				const envQueryKeys = value.replace(this.envStr, '').split('.');
				envQueryKeys.reduce((res, key) => {
					res = res[key];
					if (query[key]) {
						// TODO FIX THE KEY IN THE QUERY
						query[key]['@eq'] = res;
					}

					return res;
				}, envVariables);
			}
		});
	}

	async __getDbConditionQueryResult(query, varSchemaKey) {
		const collection = `${this.appShortId}-${varSchemaKey}`;
		const convertedQuery = {};
		await Filter.addAccessControlPolicyRuleQuery(convertedQuery, query, 'conditionQuery');
		query = Model[collection].parseQuery(convertedQuery.conditionQuery, {}, Model[collection].flatSchemaData);
		return await Model[collection].count(query) > 0;
	}

	async __checkConditionQuery(req, envVar, operator, conditionObj, key, conditionKey) {
		let evaluationRes = false;

		if (!this.queryOperator.includes(operator)) {
			// TODO throw an error bad operator
			return evaluationRes;
		}

		let lhs = conditionObj[key][operator];
		let rhs = this.getEnvironmentVar(envVar, key);

		if (conditionKey === '@location') {
			if (!lhs.match(this.IPv4Regex) && !lhs.match(this.IPv6Regex)) {
				lhs = this.getEnvironmentVar(envVar, lhs);
			}

			rhs = this.__requestIPAddress(req);
		}

		if (conditionKey === '@date' || conditionKey === '@time') {
			if (!Sugar.Date.isValid(Sugar.Date.create(lhs))) {
				lhs = this.getEnvironmentVar(envVar, lhs);
			}

			rhs = Sugar.Date.create('now');
			lhs = Sugar.Date.create(lhs);
		}

		if (!lhs || !rhs) {
			// TODO throw an error for incomplete operation sides
			return evaluationRes;
		}

		evaluationRes = accessControlHelpers.evaluateOperation(lhs, rhs, operator);

		return evaluationRes;
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
			let IPv4 = requestIPAddress[key].match(this.IPv4Regex);
			IPv4 = (IPv4)? IPv4.pop() : null;
			let IPv6 = requestIPAddress[key].match(this.IPv6Regex);
			IPv6 = (IPv6)? IPv6.pop() : null;
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

	getEnvironmentVar(envVars, environmentVar) {
		if (!environmentVar.includes('env')) return environmentVar;

		const path = environmentVar.replace('@', '').split('.');
		let val = null;
		let obj = envVars;

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

	async isPolicyDateTimeBased(conditions, pass = false) {
		let res = false;
		for await (const key of Object.keys(conditions)) {
			if (Array.isArray(conditions[key])) {
				if (this.logicalOperator.includes(key)) {
					for await (const item of conditions[key]) {
						return await this.isPolicyDateTimeBased(item, pass);
					}
				} else {
					// TODO throw an error
				}
			}

			if (((key === 'date' || pass) || (key === 'time' || pass)) && typeof conditions[key] === 'object') {
				const isDateTimeCondition = Object.keys(conditions[key]).some((cKey) => this.conditionEndRange.includes(cKey));
				if (isDateTimeCondition) {
					res = key.replace(`@${this.envStr}`, '');
					return res;
				}

				return await this.isPolicyDateTimeBased(conditions[key], true);
			}

			return res;
		}
	}

	async isPolicyQueryBasedCondition(condition, schemaNames) {
		for await (const key of Object.keys(condition)) {
			if (Array.isArray(condition[key])) {
				if (this.logicalOperator.includes(key)) {
					for await (const item of condition[key]) {
						return await this.isPolicyQueryBasedCondition(item, schemaNames);
					}
				} else {
					// TODO throw an error
				}
			}

			const schemaQuery = schemaNames.find((n) => key.includes(n));

			if (schemaQuery) {
				const [identifier] = Object.keys(condition[key]['@identifier']);
				return {
					name: schemaQuery,
					[identifier]: Object.values(condition[key]['@identifier'][identifier]).pop(),
				};
			}
		}
	}
}
module.exports = new Conditions();
