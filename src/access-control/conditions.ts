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

import Sugar from '../helpers/sugar';

import accessControlHelpers from './helpers';
import Filter from './filter';
import PolicyEnv from './env';
import * as Helpers from '../helpers';
import Model from '../model';

/**
 * @class Conditoins
 */
class Conditions {
	queryOperator: string[];
	conditionKeys: string[];
	logicalOperator: string[];
	conditionEndRange: string[];

	IPv4Regex: RegExp;
	IPv6Regex: RegExp;
	conditionQueryRegex: RegExp;

	envStr: string;

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
		this.IPv6Regex = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/g;

		this.conditionQueryRegex = new RegExp('query.');
		this.envStr = 'env.';
	}

	async applyPolicyConditions(req, userPolicies) {
		for await (const policyKey of Object.keys(userPolicies)) {
			await this.__checkPolicyConditions(req, userPolicies, policyKey);
		}
	}

	async __checkPolicyConditions(req, userPolicies, key) {
		const conditions = userPolicies[key].conditions;
		if (!conditions || !conditions.length) return;

		let isConditionFullFilled = false;
		for await (const condition of conditions) {
			isConditionFullFilled = await this.__checkLogicalCondition(req, condition, userPolicies[key].env);

			// If we hit a condition that is not fullfilled, we can break out of the loop.
			if (isConditionFullFilled === false) break;
		}

		// TODO: Refactor to return a result instead of modifying the object.
		if (!isConditionFullFilled) {
			delete userPolicies[key];
		}
	}

	async __checkLogicalCondition(req, condition, envVariables) {
		const results: Array<boolean> = [];

		for await (const key of Object.keys(condition)) {
			if (this.logicalOperator.includes(key)) {
				const partialPass = (key === '@or') ? true : false;

				const innerResults: Array<boolean> = [];
				// TODO: Add check as this is expected to be an array.
				for await (const conditionObj of condition[key]) {
					innerResults.push(await this.__checkCondition(req, envVariables, conditionObj, partialPass));
				}

				if (partialPass) {
					results.push(innerResults.some((r) => r));
				} else {
					results.push((innerResults.length > 0) ? innerResults.every((r) => r) : false);
				}

				continue;
			}
			
			results.push(await this.__checkCondition(req, envVariables, condition, false));
		}

		return (results.length > 0) ? results.every((r) => r) : false;
	}

	async __checkCondition(req, envVar, conditionObj, partialPass): Promise<boolean> {
		const results: Array<boolean> = [];
		for await (const key of Object.keys(conditionObj)) {
			const innerCondResult = await this.__checkInnerConditions(req, envVar, conditionObj, key, partialPass);
			// if (this.conditionKeys.includes(`@${key}`)) continue;

			results.push(innerCondResult);
		}

		if (partialPass) return results.some((r) => r);

		return (results.length > 0) ? results.every((r) => r) : false;
	}

	async __checkInnerConditions(req, envVar, conditionObj, key, partialPass): Promise<boolean> {
		const environmentKeys = Object.keys(envVar);
		const conditionKey = key.replace(this.envStr, '');
		const isSchemaQuery = this.conditionQueryRegex.test(conditionKey);

		if (environmentKeys.includes(conditionKey)) {
			return this.__evaluateEnvCondition(req, conditionObj, envVar, conditionKey, req.authApp.id, req.authUser);
		}
		if (typeof conditionObj[key] === 'object' && !this.conditionKeys.includes(conditionKey) && !isSchemaQuery) {
			return await this.__checkCondition(req, envVar, conditionObj[key], partialPass);
		}

		if (isSchemaQuery) {
			const varSchemaKey = key.replace('query.', '');
			const dbConditionQuery = Object.assign({}, envVar[varSchemaKey]);
			this.__buildDbConditionQuery(envVar, conditionObj[key], varSchemaKey, dbConditionQuery);

			const appShortId = (req.authApp.id) ? Helpers.shortId(req.authApp.id) : undefined;
			return await this.__getDbConditionQueryResult(dbConditionQuery, varSchemaKey, appShortId);
		}

		let evaluationRes = false;
		// TODO: ?? What if theres more than one operator?
		for await (const operator of Object.keys(conditionObj[key])) {
			evaluationRes = await this.__checkConditionQuery(req, envVar, operator, conditionObj, key, conditionKey);
		}
		return evaluationRes;
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

	async __getDbConditionQueryResult(query: any, schemaName: string, shortId?: string) {
		const collection = (shortId) ? `${shortId}-${schemaName}` : schemaName;
		let model = Model.getModel(collection);

		// If we're unable to find the model on the app then check if we're targeting a core schema.
		if (model === undefined) model = Model.getCoreModel(schemaName);

		// If model is still not defined then there is no hope.
		if (model === undefined) throw new Error(`Unable to find model for schema: ${schemaName}`);

		const convertedQuery: any = {};
		await Filter.addAccessControlPolicyRuleQuery(convertedQuery, query, 'conditionQuery');
		query = model.parseQuery(convertedQuery.conditionQuery, {}, model.flatSchemaData);
		return await model.count(query) > 0;
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
			requestIPAddress['connectionRemoteAddress'] = req.connection.remoteAddress;
		}

		if (req.socket && req.socket.remoteAddress) {
			requestIPAddress['socketRemoteAddress'] = req.socket.remoteAddress;
		}

		if (req.connection && req.connection.socket && req.connection.socket.remoteAddress) {
			requestIPAddress['connectionSocketRemoteAddress'] = req.connection.socket.remoteAddress;
		}

		if (req.info && req.info.remoteAddress) {
			requestIPAddress['infoRemoteAddress'] = req.info.remoteAddress;
		}

		const proxyClientIP = Object.keys(proxyIPAddress).reduce((arr: string[], key) => {
			const ipAddress = this.__getClientIpFromXForwardedFor(key);
			if (ipAddress) {
				arr.push(ipAddress);
			}

			return arr;
		}, []);

		if (proxyClientIP.length > 0) {
			return proxyClientIP.shift();
		}

		const clientIP = Object.keys(requestIPAddress).reduce((arr: string[], key) => {
			let IPv4 = requestIPAddress[key].match(this.IPv4Regex);
			IPv4 = (IPv4) ? IPv4.pop() : null;
			let IPv6 = requestIPAddress[key].match(this.IPv6Regex);
			IPv6 = (IPv6) ? IPv6.pop() : null;
			arr.push((IPv4) ? IPv4 : IPv6);

			return arr;
		}, []);

		const firstClientIP = clientIP.slice().pop();
		const isDiffIPs = clientIP.every((ipAddress) => ipAddress === firstClientIP);
		if (isDiffIPs) {
			// should throw an error?
		}

		return firstClientIP;
	}

	__getClientIpFromXForwardedFor(str: string) {
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

	async __evaluateEnvCondition(req, condition, envVars, conditionKey, appId, authUser) {
		const output = await PolicyEnv.getQueryEnvironmentVar(conditionKey, envVars, appId, authUser, true);
		const modifiedCondition = {...condition};

		if (output !== undefined) {
			modifiedCondition[output] = modifiedCondition[`env.${conditionKey}`];
			delete modifiedCondition[`env.${conditionKey}`];
		}

		let passed = false;
		for await (const key of Object.keys(modifiedCondition)) {
			if (typeof modifiedCondition[key] === 'object') {
				for await (const operator of Object.keys(modifiedCondition[key])) {
					passed = await this.__checkConditionQuery(req, envVars, operator, modifiedCondition, key, conditionKey);
				}
			}
		}

		return passed;
	}
	__getObjectValByPathKey(obj, key) {
		let value = null;

		if (obj && obj[key]) {
			value = obj[key];
		}

		return value;
	}

	async isPolicyDateTimeBased(conditions, pass = false): Promise<string | boolean | undefined> {
		let res: boolean | string = false;
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

export default new Conditions();