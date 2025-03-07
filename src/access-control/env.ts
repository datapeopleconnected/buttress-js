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
import * as Helpers from '../helpers';

import Model from '../model';
import { Filter } from './filter';

export class PolicyEnv {

	static IPv4Regex = /((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\.|$)){4}/g;
	static IPv6Regex = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/g;

	static strPrefix = '#env.';

	private _globalQueryEnv: { [index: string]: string } = {};

	generateBaseGlobalEnvs() {
		return {
			date: {
				now: new Date().toISOString(),
			}
		};
	}

	generateRequestGlobalEnvs(req, appId, authUser) {
		return {
			...this.generateBaseGlobalEnvs(),
			ipAddress: null,
			user: authUser,
			appId: appId
		};
	}

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

		const isAppSchema = await this.__isAppSchema(root, envVars.appId);
		if (isAppSchema) {
			return this.__getAppSchemaEnvValue(queryValue, envVars);
		}

		return this._globalQueryEnv[queryValue];
	}

	async __isAppSchema(schema, appId) {
		if (!schema || !appId) return false;
		const appShortId = Helpers.shortId(appId);
		return (Model[`${appShortId}-${schema}`]) ? true : false;
	}

	async __getAppSchemaEnvValue(envObj, envVars) {
		const schema = envObj.collection;
		const query = Filter.convertQueryPrefixOperators(envObj.query);
		const output = envObj.output;
		const outputType = envObj.type;

		const appShortId = Helpers.shortId(envVars.appId);
		for await (const key of Object.keys(query)) {
			if (typeof query[key] !== 'object') throw new Error(`env query needs to be a query object ${query[key]}`);
			const operator = Object.values(Filter.queryOperators).find((op) => Object.keys(query[key]).every((key) => key === op));
			if (!operator) throw new Error(`Can not find an operator for ${query[key]}`);

			const dbQuery = query[key][operator];
			if (typeof dbQuery !== 'string') continue;

			const queryValue = dbQuery.split('.');
			const [queryCollection] = queryValue;
			if (queryCollection === 'env') {
				const envVariable = dbQuery.replace(`${queryCollection}.`, '');
				const envRes = await this.__getAppSchemaEnvValue(envVars[envVariable], envVars);
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
					// TODO: Shouldn't be directly accessing ObjectId, this should go through an adapter.
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
