/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import { ObjectId } from 'bson';
import * as Helpers from '../helpers/index.js';

import { PolicyEnvQuery } from '../model/core/policy.js';

import Model from '../model/index.js';
import { Filter } from './filter.js';

export interface ACBaseEnv {
	date: {
		now: string;
	};
}

export interface ACEnv extends ACBaseEnv {
	ipAddress: string | null;
	user: any | null;
	appId: string | null;
}

export interface ACPolicyEnvCombined extends ACEnv {
	[custom: string]: string | PolicyEnvQuery | { now: string } | null;
}

export class PolicyEnv {

	static IPv4Regex = /((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.|$)){4}/g;
	static IPv6Regex = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/g;

	static strPrefix = '#env.';

	private _globalQueryEnv: { [index: string]: string } = {};

	generateBaseGlobalEnvs(): ACBaseEnv {
		return {
			date: {
				now: new Date().toISOString(),
			}
		};
	}

	generateRequestGlobalEnvs(req, appId, authUser): ACEnv {
		return {
			...this.generateBaseGlobalEnvs(),
			ipAddress: null,
			user: authUser,
			appId: appId
		};
	}

	/**
	 * Get the value of an environment variable.
	 * @param key The key of the environment variable.
	 * @param envVars The environment variables object - **Important:** This object will be modified to include the resolved environment variables.
	 * @returns The value of the environment variable or the key itself if not found.
	 */
	async getEnvValue(key: string, envVars) {
		if (!key || !key.startsWith(PolicyEnv.strPrefix)) return key;

		const path = key.replace(PolicyEnv.strPrefix, '');
		const value = Helpers.get(path, envVars);

		if (typeof value === 'object' && 'collection' in value) {
			return this.getQueryEnvironmentVar(key, envVars);
		}

		if (typeof value === 'string' && value.startsWith(PolicyEnv.strPrefix)) {
			return this.getEnvValue(value, envVars);
		}

		return value;
	}

	async getQueryEnvironmentVar(environmentKey, envVars, conditionFlag = false) {
		if ((!environmentKey || !environmentKey.startsWith(PolicyEnv.strPrefix)) && !conditionFlag) return environmentKey;

		const path = environmentKey.replace(PolicyEnv.strPrefix, '').split('.').filter((v) => v);
		const queryValue = path.reduce((obj, str) => obj?.[str], envVars);

		let root: string | null = null;
		if (typeof queryValue === 'string') {
			[root] = queryValue.split('.');
		} else if (typeof queryValue === 'object') {
			root = queryValue.collection;
		}

		if (root) {
			const isAppSchema = await this.__isAppSchema(root, envVars.appId);
			if (isAppSchema) {
				return this.__queryAppSchemaEnvValue(queryValue, environmentKey, envVars);
			}
		}

		return this._globalQueryEnv[queryValue];
	}

	async __isAppSchema(schema: string, appId: string) {
		if (!schema || !appId) return false;
		const model = await Model.getAppModel(appId, schema);
		return (model) ? true : false;
	}

	async __findAndReplaceValues(query, envVars) {
		if (typeof query !== 'object' || query === null) {
			return;
		}

		const paths = this.__findPaths(query);
		for await (const path of paths) {
			const dbQuery = path.reduce((current, key) => current && current[key], query);
			const realValue = await this.getEnvValue(dbQuery, envVars);

			this.__setObjectValueByPath(query, path, realValue);
		}

		return query;
	}

	__setObjectValueByPath(obj, path, value) {
		const lastKey = path.pop();
		const parent = path.reduce((current, key) => current[key], obj);
		if (parent && lastKey) {
			parent[lastKey] = value;
		}
	}

	__findPaths(data, currentPath: any[] = [], paths: any[] = []) {
		if (typeof data === 'object' && data !== null) {
			if (Array.isArray(data)) {
			data.forEach((item, index) => {
				this.__findPaths(item, [...currentPath, index], paths);
			});
			} else {
			for (const key in data) {
				if (Object.prototype.hasOwnProperty.call(data, key)) {
				this.__findPaths(data[key], [...currentPath, key], paths);
				}
			}
			}
		} else {
			// This is an "end value," so we store its full path.
			paths.push(currentPath);
		}
		return paths;
	}

	async __queryAppSchemaEnvValue(envObj, envKey, envVars) {
		const schema = envObj.collection;
		const query = Filter.convertQueryPrefixOperators(envObj.query);
		const output = envObj.output;
		const outputType = envObj.type;

		// Check the envVar to see if
		if (envVars[envKey]) return envVars[envKey];
		await this.__findAndReplaceValues(query, envVars);

		const model = await Model.getAppModel(envVars.appId, schema);
		const res = await model.find(query);
		const result = await Helpers.streamAll(res);
		if (!result) return false;

		if (outputType === 'string' || outputType === 'id') {
			return result.reduce((item, obj) => {
				item = obj[output.key];
				if (output.type === 'id') {
					// TODO: Shouldn't be directly accessing ObjectId, this should go through an adapter.
					item = (ObjectId.isValid(item)) ? new ObjectId(item) : item;
				}

				return item;
			}, '');
		}

		if (outputType === 'array' && result.length > 0) {
			return result.reduce((arr, obj) => {
				if (output.type === 'id' && Array.isArray(obj[output.key])) {
					obj[output.key] = obj[output.key].filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
				} else if (output.type === 'id' && ObjectId.isValid(obj[output.key])) {
					// TODO: Shouldn't be directly accessing ObjectId, this should go through an adapter.
					obj[output.key] = (ObjectId.isValid(obj[output.key])) ? new ObjectId(obj[output.key]) : obj[output.key];
				}

				arr = arr.concat(obj[output.key]);
				return arr;
			}, []);
		}
		if (outputType === 'boolean' && result.length > 0) {
			return result.every((obj) => obj[output.key]);
		}

		const outputValue = (result.length > 0 && result[output]) ? result[output] : (outputType === 'array') ? [] : ''

		envVars[envKey] = outputValue;

		return outputValue;
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
			let IPv4 = requestIPAddress[key].match(PolicyEnv.IPv4Regex);
			IPv4 = (IPv4) ? IPv4.pop() : null;
			let IPv6 = requestIPAddress[key].match(PolicyEnv.IPv6Regex);
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
			return ip.match(PolicyEnv.IPv4Regex) || ip.match(PolicyEnv.IPv6Regex);
		});
	}
}
export default new PolicyEnv();
