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

import { ObjectId } from 'bson';

import accessControlHelpers, { CombineEnvGroups } from './helpers';

import Env from './env'

import * as Helpers from '../helpers';
import Model from '../model';

import { ApplicablePolicies } from './index';

import { PolicyEnv, PolicyQuery } from '../model/core/policy';

/**
 * @class Filter
 */
class Filter {
	logicalOperator: string[];
	arrayOperators: string[];
	manipulationVerbs: string[];

	_queryAccess = [
		'%FULL_ACCESS%',
		'%APP_SCHEMA%',
		'%CORE_SCHEMA%',
	];

	constructor() {
		this.logicalOperator = [
			'@and',
			'@or',
			'$and',
			'$or',
		];

		this.arrayOperators = [
			'@in',
			'@nin',
			'$in',
			'$nin',
		];

		this.manipulationVerbs = [
			'PUT',
			// 'POST', // SKIPPING POST FOR NOW
			'DELETE',
		];
	}

	// This function will now take in policies, modifiy their queries and return back the list.
	async buildApplicablePoliciesQuery(req, policies: ApplicablePolicies[]) {
		const output: ApplicablePolicies[] = [];

		for await (const policy of policies) {
			const p = Object.assign({}, policy);
			const env = CombineEnvGroups(policy);
			p.config.query = await this.buildPolicyQuery(req, policy.config.query, env);
			output.push(p);
		}

		return output;
	}

	async buildPolicyQuery(req, policyQuery: PolicyQuery | null, env: PolicyEnv) {
		if (policyQuery === null) return null;

		const translatedQuery = await this.__convertPrefixToQueryPrefix(policyQuery);
		const output: PolicyQuery = {};

		for await (const key of Object.keys(translatedQuery)) {
			const val = translatedQuery[key];
			if (key === 'access' && this._queryAccess.includes(val)) continue;
			if (Object.keys(val).length < 1) continue;

			if (output[key]) {
				if (Array.isArray(output[key]) && Array.isArray(val)) {
					for await (const elem of val) {
						const elementExist = output[key].findIndex((el) => JSON.stringify(el) === JSON.stringify(elem));

						if (elementExist !== -1) continue;
						output[key].push(elem);
					}

					continue;
				} else if (!Array.isArray(output[key]) && !Array.isArray(val)) {
					Object.keys(output[key]).forEach((k) => {
						if (this.arrayOperators.includes(k)) {
							output[key][k] = output[key][k].concat(val[k]).filter((v, idx, arr) => arr.indexOf(v) === idx);
						} else {
							output[key][k] = val[k];
						}
					});

					continue;
				}
			}

			if (req.authApp && req.authApp.id && Object.keys(env).length > 0) {
				await this.__substituteEnvVariables(translatedQuery[key], env, req.authApp.id, req.authUser);
			}

			output[key] = translatedQuery[key];
		}

		return output;
	}

	async __substituteEnvVariables(obj, env, appId, authUser) {
		for await (const key of Object.keys(obj)) {
			const envKey = await this.__findEnvString(obj[key]);
			if (!envKey) continue;

			const output = await Env.getQueryEnvironmentVar(envKey, env, appId, authUser);
			obj[key] = await this.__substituteEnvString(obj[key], output);
		}
	}

	async __findEnvString(input) {
		if (input && typeof input === 'string' && input.includes('env.')) {
			return input;
		}

		if (input && typeof input === 'object') {
			for (const key of Object.keys(input)) {
				const result = await this.__findEnvString(input[key]);
				if (result !== false) {
					return result;
				}
			}
		}
		return false;
	}

	async __substituteEnvString(input, newValue) {
		if (input && typeof input === 'string') {
			if (input.startsWith('env.')) {
				return newValue;
			} else {
				return input;
			}
		}

		if (input && typeof input === 'object') {
			for (const key of Object.keys(input)) {
				input[key] = await this.__substituteEnvString(input[key], newValue);
			}
		}
		return input;
	}

	// TODO needs to be removed and added to the adapters - TEMPORARY HACK!!
	// TODO: This function needs a refactor, expecting the AC to be already applied to the queiries.
	async evaluateManipulationActions(req, collection) {
		const coreSchema = await accessControlHelpers.cacheCoreSchema();
		const coreSchemNames = coreSchema.map((c) => Sugar.String.singularize(c.name));
		const isCoreSchema = coreSchemNames.includes(collection);

		const verb = req.method;
		if (!this.manipulationVerbs.includes(verb)) return true;

		const appId = req.authApp.id;
		const appShortId = Helpers.shortId(appId);
		const body = (Array.isArray(req.body)) ? req.body : [req.body];
		let query = (req.body.query) ? req.body.query : {};
		const baseURL = req.url.replace(/\?.*/, '');
		const id = (baseURL) ? baseURL.split('/').pop() : undefined;
		let passed = true;

		if (isCoreSchema) {
			collection = Sugar.String.capitalize(collection);
		} else {
			collection = `${appShortId}-${collection}`;
		}

		for await (const update of body) {
			// TODO: Shouldn't be using object ID here, should be using the datstore's ID

			if (query._id && typeof query._id !== 'object') {
				query._id = await Model[collection].createId(query._id);
			}

			const parsedQuery = await Model[collection].parseQuery(query, {}, Model[collection].flatSchemaData);
			query = {...query, ...parsedQuery};
			const res = await Model[collection].count(query);
			if (!res) {
				passed = false;
				delete query._id;
				return passed;
			}
		}

		delete req.body.query; // Deleting it for manipulation verbs
		return passed;
	}

	__convertPrefixToQueryPrefix(obj) {
		if (typeof obj !== 'object' || obj === null || ObjectId.isValid(obj)) {
			return obj;
		}

		if (Array.isArray(obj)) {
			return obj.map(this.__convertPrefixToQueryPrefix.bind(this));
		}

		return Object.keys(obj).reduce((acc, key) => {
			const newKey = key.replace(/@/g, '$');
			acc[newKey] = this.__convertPrefixToQueryPrefix(obj[key]);
			return acc;
		}, {});
	}

	__getQueryKeys(query, baseKey?: string) {
		return Object.keys(query).reduce((arr: string[], key) => {
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

	async _getDeepQueryObj(queryObj, newObj = {}) {
		if (!queryObj) return newObj;

		for await (const key of Object.keys(queryObj)) {
			if ((Array.isArray(queryObj[key]) && queryObj[key].length < 1) || key.includes('crPath')) continue;

			if (Array.isArray(queryObj[key]) && queryObj[key].length > 0) {
				for await (const item of queryObj[key]) {
					newObj = await this._getDeepQueryObj(item, newObj);
				}
				continue;
			}

			newObj[key] = queryObj[key];
		}

		return newObj;
	}

	async _checkOriginalQueryIsEmpty(query) {
		let isEmpty = true;
		if (!query) return isEmpty;

		for await (const key of Object.keys(query)) {
			if (Array.isArray(query[key]) && query[key].length > 0) {
				isEmpty = await this._checkOriginalQueryIsEmpty(query[key]);
			}

			if (!Array.isArray(query[key]) && query[key]) {
				isEmpty = false;
			}
		}

		return isEmpty;
	}

	mergeQueryFilters(baseFilter, additionalFilter, operator = "$and") {
		if (!baseFilter || !additionalFilter) {
			throw new Error("Both baseFilter and additionalFilter must be provided.");
		}
		if (operator !== "$and" && operator !== "$or") {
			throw new Error("Operator must be either '$and' or '$or'.");
		}

		if (Object.keys(baseFilter).length < 1) return additionalFilter;
		if (Object.keys(additionalFilter).length < 1) return baseFilter;

		const newQuery: any = { [operator]: [] };

		// Check to see if the base filter already has the operator, if it does then spread it 
		if (baseFilter[operator]) {
			newQuery[operator] = [...baseFilter[operator]];
		} else {
			newQuery[operator].push(baseFilter);
		}

		// Check to see if the additional filter already has the operator, if it does then spread it
		if (additionalFilter[operator]) {
			newQuery[operator] = [...newQuery[operator], ...additionalFilter[operator]];
		} else {
			newQuery[operator].push(additionalFilter);
		}

		return newQuery;
	}

	// A function for merging a request query with an access control query. The Access control query will take priority.
	mergeQueryFiltersWithAccessControl(reqQuery, accessControlQuery) {
		return this.mergeQueryFilters(reqQuery, accessControlQuery, '$and');
	}
}
export default new Filter();
