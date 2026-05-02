/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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

import AccessControlHelpers, { CombineEnvGroups } from './helpers.js';
import Filter from './filter.js';
import Env, { ACPolicyEnvCombined } from './env.js';
import * as Helpers from '../helpers/index.js';
import Model from '../model/index.js';

import { ApplicablePolicyConfig } from './index.js';
import { PolicyCondition, PolicyConfig, PolicyEnv } from '../model/core/policy.js';

/**
 * @class Conditoins
 */
export class Conditions {
  static queryOperator = [
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
  static conditionKeys = ['@location', '@date', '@time'];
  static logicalOperator = ['@and', '@or'];
  static conditionEndRange = ['@gt', '@gte', '@gtDate', '@gteDate'];

  static envStr: string = 'env.';
  static conditionQueryRegex = new RegExp('query.');

  async filterPoliciesByPolicyConditions(userPolicies: ApplicablePolicyConfig[], reqEnv?) {
    const output: ApplicablePolicyConfig[] = [];

    for await (const policy of userPolicies) {
      if (policy.config.condition === null || (await this.__checkPolicyConditions(policy, reqEnv))) {
        output.push(policy);
      }
    }

    return output;
  }

  async __checkPolicyConditions(policy: ApplicablePolicyConfig, reqEnv) {
    if (policy.config.condition === null) return false;

    const env = CombineEnvGroups(policy, reqEnv);
    return await this.__checkCondition(policy.config.condition, env);
  }

  async __checkCondition(condition: PolicyCondition, envVariables: ACPolicyEnvCombined, partialPass: boolean = false) {
    const results: Array<boolean> = [];

    for await (const key of Object.keys(condition)) {
      if (Conditions.logicalOperator.includes(key)) {
        const innerPartialPass = key === '@or' || key === '$or' ? true : false;

        const innerResults: Array<boolean> = [];
        // TODO: Add check as this is expected to be an array.
        for await (const conditionObj of condition[key]) {
          innerResults.push(await this.__checkCondition(conditionObj, envVariables, innerPartialPass));
        }

        if (innerPartialPass) {
          results.push(innerResults.some((r) => r));
        } else {
          results.push(innerResults.length > 0 ? innerResults.every((r) => r) : false);
        }

        continue;
      }

      for await (const key of Object.keys(condition)) {
        results.push(await this.__checkInnerConditions(condition, envVariables, key, partialPass));
      }
    }

    if (partialPass) return results.some((r) => r);

    return results.length > 0 ? results.every((r) => r) : false;
  }

  async __checkInnerConditions(
    conditionObj,
    envVariables: ACPolicyEnvCombined | null,
    key,
    partialPass: boolean = false,
  ): Promise<boolean> {
    const results: boolean[] = [];
    for await (const operator of Object.keys(conditionObj[key])) {
      results.push(await this.__checkConditionQuery(envVariables, operator, conditionObj, key));
    }

    if (partialPass) return results.some((r) => r);

    // The condition defaults are treated as AND by default.
    return results.every((r) => r);
  }

  // __buildDbConditionQuery(envVariables, conditions, varSchemaKey, query = {}) {
  // 	Object.keys(conditions).forEach((key) => {
  // 		const value = conditions[key];
  // 		const queryKey = key.replace(`${varSchemaKey}.`, '');
  // 		if (query[queryKey]) {
  // 			query[queryKey] = value;
  // 		}

  // 		if (!Array.isArray(value) && typeof value === 'object') {
  // 			this.__buildDbConditionQuery(envVariables, value, varSchemaKey, query);
  // 		} else {
  // 			const envQueryKeys = value.replace(Conditions.envStr, '').split('.');
  // 			envQueryKeys.reduce((res, key) => {
  // 				res = res[key];
  // 				if (query[key]) {
  // 					// TODO FIX THE KEY IN THE QUERY
  // 					query[key]['@eq'] = res;
  // 				}

  // 				return res;
  // 			}, envVariables);
  // 		}
  // 	});
  // }

  // async __getDbConditionQueryResult(query: any, schemaName: string, shortId?: string) {
  // 	const collection = (shortId) ? `${shortId}-${schemaName}` : schemaName;
  // 	let model = Model.getModel(collection);

  // 	// If we're unable to find the model on the app then check if we're targeting a core schema.
  // 	if (model === undefined) model = Model.getCoreModel(schemaName);

  // 	// If model is still not defined then there is no hope.
  // 	if (model === undefined) throw new Error(`Unable to find model for schema: ${schemaName}`);

  // 	const convertedQuery: any = await Filter.buildPolicyQuery(query, {});
  // 	query = model.parseQuery(convertedQuery, {}, model.flatSchemaData);
  // 	return await model.count(query) > 0;
  // }

  async __checkConditionQuery(envVariables, operator, conditionObj, key) {
    let evaluationRes = false;

    if (!Conditions.queryOperator.includes(operator)) {
      throw new Error(`Invalid policy condition operator: ${operator}`);
    }

    const lhs = await Env.getEnvValue(conditionObj[key][operator], envVariables);
    const rhs = await Env.getEnvValue(key, envVariables);

    if (lhs === undefined || rhs === undefined) {
      // TODO throw an error for incomplete operation sides
      return evaluationRes;
    }

    evaluationRes = AccessControlHelpers.evaluateOperation(lhs, rhs, operator);

    return evaluationRes;
  }

  async isPolicyDateTimeBased(conditions, pass = false): Promise<string | boolean | undefined> {
    let res: boolean | string = false;
    for await (const key of Object.keys(conditions)) {
      if (Array.isArray(conditions[key])) {
        if (Conditions.logicalOperator.includes(key)) {
          for await (const item of conditions[key]) {
            return await this.isPolicyDateTimeBased(item, pass);
          }
        } else {
          // TODO throw an error
        }
      }

      if ((key === 'date' || pass || key === 'time' || pass) && typeof conditions[key] === 'object') {
        const isDateTimeCondition = Object.keys(conditions[key]).some((cKey) =>
          Conditions.conditionEndRange.includes(cKey),
        );
        if (isDateTimeCondition) {
          res = key.replace(`${Conditions.envStr}`, '');
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
        if (Conditions.logicalOperator.includes(key)) {
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
