const Sugar = require('sugar');

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

		this.conditionQueryRegex = new RegExp('query.', 'g');
		this.envStr = 'env.';
		this.appShortId = null;
		this.passedCondition = {
			partial: false,
			full: true,
		};
	}

	setAppShortId(app) {
		this.appShortId = Helpers.shortId(app);
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

	async __checkAttributeConditions(req, attr) {
		const conditions = attr.conditions;
		if (!conditions || !Object.keys(conditions).length) return true;

		this.passedCondition.partial = false;
		this.passedCondition.full = true;
		let isConditionFullFilled = false;

		const prioritisedCondition = await this.__prioritiseConditionOrder(conditions);
		await Object.keys(prioritisedCondition).reduce(async (prev, key) => {
			await prev;
			isConditionFullFilled = await this.__checkLogicalOperatorCondition(req, attr, conditions[key], key);
		}, Promise.resolve());

		return isConditionFullFilled;
	}

	async __prioritiseConditionOrder(conditions) {
		return conditions;
	}

	async __checkLogicalOperatorCondition(req, attr, operation, operator) {
		let result = false;

		if (operator === '@and') {
			await operation.reduce(async (prev, conditionObj) => {
				await prev;
				result = await this.__checkCondition(req, attr, conditionObj, false, false);
			}, Promise.resolve());
		} else if (operator === '@or') {
			await operation.reduce(async (prev, conditionObj) => {
				await prev;
				result = await this.__checkCondition(req, attr, conditionObj, false);
			}, Promise.resolve());
		} else {
			result = await this.__checkCondition(req, attr, operation, false, false);
		}

		return result;
	}

	async __checkCondition(req, attr, conditionObj, passed, partialPass = true) {
		const objectKeys = Object.keys(conditionObj);
		for await (const key of objectKeys) {
			passed = await this.__checkInnerConditions(req, attr, conditionObj, key, passed, partialPass);
			if (partialPass && passed) {
				this.passedCondition.partial = true;
			}

			if (!partialPass && !passed) {
				this.passedCondition.full = false;
			}
		}

		return (partialPass & this.passedCondition.partial)? this.passedCondition.partial : this.passedCondition.full;
	}

	async __checkInnerConditions(req, attr, conditionObj, key, passed, partialPass) {
		const conditionKey = key.replace(this.envStr, '');
		const isSchemaQuery = this.conditionQueryRegex.test(conditionKey);

		if (this.passedCondition.partial) {
			return true;
		}

		if (typeof conditionObj[key] === 'object' && !this.conditionKeys.includes(conditionKey) && !isSchemaQuery) {
			return await this.__checkCondition(req, attr, conditionObj[key], passed, partialPass);
		}

		if (isSchemaQuery) {
			const varSchemaKey = key.replace('query.', '');
			const dbConditionQuery = Object.assign({}, attr.env[varSchemaKey]);
			this.__buildDbConditionQuery(attr.env, conditionObj[key], varSchemaKey, dbConditionQuery);

			return await this.__getDbConditionQueryResult(dbConditionQuery, varSchemaKey);
		}

		return await Object.keys(conditionObj[key]).reduce(async (innerPrev, operator) => {
			await innerPrev;
			return await this.__checkConditionQuery(req, attr, operator, conditionObj, key, conditionKey);
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
		await Filter.addAccessControlPolicyAttributeQuery(convertedQuery, query, 'conditionQuery');
		query = Model[collection].parseQuery(convertedQuery.conditionQuery, {}, Model[collection].flatSchemaData);
		return await Model[collection].count(query) > 0;
	}

	async __checkConditionQuery(req, attr, operator, conditionObj, key, conditionKey) {
		let evaluationRes = false;

		if (!this.queryOperator.includes(operator)) {
			// TODO throw an error bad operator
			return evaluationRes;
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
			return evaluationRes;
		}

		evaluationRes = this.__evaluateOperation(lhs, rhs, operator);

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
module.exports = new Conditions();
