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

import Sugar from '../helpers/sugar.js';

import { ObjectId } from 'bson';

import AccessControlHelpers, { CombineEnvGroups } from './helpers.js';

import Env, { ACPolicyEnvCombined } from './env.js'

import * as Helpers from '../helpers/index.js';
import Model from '../model/index.js';

import { ApplicablePolicyConfig } from './index.js';

import { PolicyEnv, PolicyQuery } from '../model/core/policy.js';

/**
 * @class Filter
 */
export class Filter {
	static queryOperators: { [index: string]: string } = {
		'@eq': '$eq',
		'@not': '$not',
		'@gt': '$gt',
		'@lt': '$lt',
		'@gte': '$gte',
		'@lte': '$lte',
		'@gtDate': '$gtDate',
		'@gteDate': '$gteDate',
		'@ltDate': '$ltDate',
		'@lteDate': '$lteDate',
		'@rex': '$rex',
		'@rexi': '$rexi',
		'@in': '$in',
		'@nin': '$nin',
		'@exists': '$exists',
		'@inProp': '$inProp',
		'@elMatch': '$elMatch',
	};
	static logicalOperator = [
		'@and',
		'@or',
		'$and',
		'$or',
	];
	arrayOperators: string[];
	manipulationVerbs: string[];

	_queryAccess = [
		'%FULL_ACCESS%',
		'%APP_SCHEMA%',
		'%CORE_SCHEMA%',
	];

	constructor() {
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
	async buildApplicablePoliciesQuery(policies: ApplicablePolicyConfig[], reqEnv) {
		const output: ApplicablePolicyConfig[] = [];

		for await (const policy of policies) {
			const p = Object.assign({}, policy);
			const env = CombineEnvGroups(policy, reqEnv);
			p.config.query = await this.buildPolicyQuery(policy.config.query, env);
			output.push(p);
		}

		return output;
	}

	/**
	 * Walk over a query object and replace any env variables with their values.
	 */
	async buildPolicyQuery(policyQuery: PolicyQuery | null, envVars: ACPolicyEnvCombined, stripAccessKeys = true) {
		if (policyQuery === null) return null;

		// Change @ prefixes over to $ for mongo queries.
		// ? This should really be handled by the mongo adapter and internally we should use the @ prefix.
		const translatedQuery = Filter.convertQueryPrefixOperators(policyQuery);
		const output: PolicyQuery = {};

		for await (const key of Object.keys(translatedQuery)) {
			const val = translatedQuery[key];
			if (stripAccessKeys && key === 'access' && this._queryAccess.includes(val)) continue;
			if (Object.keys(val).length < 1) continue;

			if (Filter.logicalOperator.includes(key)) { 
				for (const queryObj of val) {
					if (typeof queryObj !== 'object' || Array.isArray(queryObj)) {
						throw new Error(`Invalid query object for logical operator ${key}: ${JSON.stringify(queryObj)}`);
					}

					// Recursively build the query for each object in the logical operator array.
					const builtQuery = await this.buildPolicyQuery(queryObj, envVars, stripAccessKeys);
					if (builtQuery) {
						output[key] = output[key] || [];
						output[key].push(builtQuery);
					}
				}
				continue;
			}

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

			if (typeof val === 'string') {
				output[key] = await Env.getEnvValue(val, envVars);
				continue;
			}

			const operator = Object.keys(val)[0];
			const value = val[operator];

			// if (!Filter.queryOperators[operator]) continue;

			output[key] = {};
			output[key][operator] = await Env.getEnvValue(value, envVars);
		}

		return output;
	}

	/**
	 * Function is used to evaluate a query against an entity, ensuring that the query isn't going to filter out this entity.
	 * The function will return true if it selects the entity, false if it doesn't.
	 */
	evaluateQueryAgainstEntity(query: PolicyQuery, entity: { [index: string]: any }, partialPass?: boolean): boolean {
		const flatterned = Helpers.flatternObject(entity);
		return this.__evaluateQueryAgainstEntity(query, flatterned, partialPass, entity);
	}

	__evaluateQueryAgainstEntity(query: PolicyQuery, flatEntity: { [index: string]: any }, partialPass?: boolean, testEntity?: any): boolean {
		if (!flatEntity) return false;

		// TODO: Object will need to be flatterned.
		if (query['access'] && query['access'] === '%FULL_ACCESS%') return true;

		const results: Array<boolean> = [];

		for (const key of Object.keys(query)) {
			if (Filter.logicalOperator.includes(key)) {
				const innerPartialPass = (key === '@or' || key === '$or') ? true : false;

				const innerResults: Array<boolean> = [];
				// TODO: Add check as this is expected to be an array.
				for (const queryObj of query[key]) {
					innerResults.push(this.__evaluateQueryAgainstEntity(queryObj, flatEntity, innerPartialPass, testEntity));
				}

				if (innerPartialPass) {
					results.push(innerResults.some((r) => r));
				} else {
					results.push((innerResults.length > 0) ? innerResults.every((r) => r) : false);
				}

				continue;
			}

			for (const field of Object.keys(query)) {
				const fieldResults: boolean[] = [];

				for (const operator of Object.keys(query[field])) {
					let evaluationRes = false;

					// if (!Filter.queryOperators[operator]) {
					// 	throw new Error(`Invalid policy condition operator: ${operator}`);
					// }

					// * We don't need to perform a env replacment here as the query should have already
					// * gone through the query builder which will have replaced the values.
					const lhs = flatEntity[field];
					const rhs = query[field][operator];

					if (lhs === undefined || rhs === undefined) {
						// ? Maybe throw an error for incomplete operation sides
						return evaluationRes;
					}

					evaluationRes = AccessControlHelpers.evaluateOperation(lhs, rhs, operator);

					fieldResults.push(evaluationRes);
				}

				if (partialPass) return fieldResults.some((r) => r);

				// The condition defaults are treated as AND by default.
				return fieldResults.every((r) => r);
			}
		}

		if (partialPass) return results.some((r) => r);

		return (results.length > 0) ? results.every((r) => r) : false;
	}

	// TODO needs to be removed and added to the adapters - TEMPORARY HACK!!
	// TODO: This function needs a refactor, expecting the AC to be already applied to the queiries.
	async evaluateManipulationActions(req, collection) {
		const coreSchema = await AccessControlHelpers.cacheCoreSchema();
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
			query = { ...query, ...parsedQuery };
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

	/**
	 * Queries are prefixed with @ to avoid conflicts with mongo operators. This function will convert the @ to $.
	 * 
	 * @todo This functionality should really happen in the mongo adpater. All queries within buttress should be
	 * referenced using the @ prefix.
	 */
	static convertQueryPrefixOperators(query: unknown) {
		if (typeof query !== 'object' || query === null) {
			return query;
		}

		// ! Shouldn't be referencing ObjectId's outside of the adapters.
		if (typeof query === 'object' && ObjectId.isValid(query as ObjectId)) {
			return query;
		}

		if (Array.isArray(query)) {
			return query.map((item) => Filter.convertQueryPrefixOperators(item));
		}

		return Object.keys(query).reduce((acc, key) => {
			const newKey = key.replace(/@/g, '$');
			acc[newKey] = Filter.convertQueryPrefixOperators(query[key]);
			return acc;
		}, {});
	}
}
export default new Filter();
