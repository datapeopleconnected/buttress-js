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
import AccessControlHelpers, { AccessControlValue, CombineEnvGroups } from './helpers.js';
import Env, { ACEnv, ACPolicyEnvCombined } from './env.js';

import { ApplicablePolicyConfig } from './index.js';
import { PolicyCondition } from '../model/core/policy.js';

// A condition against another schema: `{'@identifier': {<field>: {<operator>: <value>}}}`
type SchemaQueryCondition = { '@identifier': Record<string, Record<string, unknown>> };

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

  async filterPoliciesByPolicyConditions(userPolicies: ApplicablePolicyConfig[], reqEnv: ACEnv) {
    const output: ApplicablePolicyConfig[] = [];

    for await (const policy of userPolicies) {
      if (policy.config.condition === null || (await this.__checkPolicyConditions(policy, reqEnv))) {
        output.push(policy);
      }
    }

    return output;
  }

  async __checkPolicyConditions(policy: ApplicablePolicyConfig, reqEnv: ACEnv) {
    if (!policy.config.condition) return false;

    const env = CombineEnvGroups(policy, reqEnv);
    return await this.__checkCondition(policy.config.condition, env);
  }

  async __checkCondition(condition: PolicyCondition, envVariables: ACPolicyEnvCombined, partialPass: boolean = false) {
    const conditionRecord = condition as Record<string, unknown>;
    const results: Array<boolean> = [];

    for await (const key of Object.keys(conditionRecord)) {
      if (Conditions.logicalOperator.includes(key)) {
        const innerPartialPass = key === '@or' || key === '$or' ? true : false;

        const innerResults: Array<boolean> = [];
        // TODO: Add check as this is expected to be an array.
        const nestedConditions = conditionRecord[key];
        if (!Array.isArray(nestedConditions)) continue;
        for await (const conditionObj of nestedConditions as unknown[]) {
          if (typeof conditionObj !== 'object' || conditionObj === null) continue;
          innerResults.push(
            await this.__checkCondition(conditionObj as PolicyCondition, envVariables, innerPartialPass),
          );
        }

        if (innerPartialPass) {
          results.push(innerResults.some((r) => r));
        } else {
          results.push(innerResults.length > 0 ? innerResults.every((r) => r) : false);
        }

        continue;
      }

      results.push(await this.__checkInnerConditions(conditionRecord, envVariables, key, partialPass));
    }

    if (partialPass) return results.some((r) => r);

    return results.length > 0 ? results.every((r) => r) : false;
  }

  async __checkInnerConditions(
    conditionObj: Record<string, unknown>,
    envVariables: ACPolicyEnvCombined | null,
    key: string,
    partialPass: boolean = false,
  ): Promise<boolean> {
    const results: boolean[] = [];
    const conditionEntry = conditionObj[key];
    if (typeof conditionEntry !== 'object' || conditionEntry === null || Array.isArray(conditionEntry)) return false;

    for await (const operator of Object.keys(conditionEntry)) {
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

  async __checkConditionQuery(
    envVariables: ACPolicyEnvCombined | null,
    operator: string,
    conditionObj: Record<string, unknown>,
    key: string,
  ) {
    let evaluationRes = false;

    if (!Conditions.queryOperator.includes(operator)) {
      throw new Error(`Invalid policy condition operator: ${operator}`);
    }

    const conditionEntry = conditionObj[key] as Record<string, unknown>;
    const lhs = await Env.getEnvValue(conditionEntry[operator], envVariables);
    const rhs = await Env.getEnvValue(key, envVariables);

    if (lhs === undefined || rhs === undefined) {
      // TODO throw an error for incomplete operation sides
      return evaluationRes;
    }

    // Not narrowed as the query filter does, evaluateOperation gets whatever the env values resolved to
    evaluationRes = AccessControlHelpers.evaluateOperation(
      lhs as AccessControlValue,
      rhs as AccessControlValue,
      operator,
    );

    return evaluationRes;
  }

  async isPolicyDateTimeBased(conditions: PolicyCondition, pass = false): Promise<string | boolean | undefined> {
    let res: boolean | string = false;
    for await (const key of Object.keys(conditions)) {
      if (Array.isArray(conditions[key])) {
        if (Conditions.logicalOperator.includes(key)) {
          for await (const item of conditions[key] as PolicyCondition[]) {
            return await this.isPolicyDateTimeBased(item, pass);
          }
        } else {
          // TODO throw an error
        }
      }

      if ((key === 'date' || pass || key === 'time' || pass) && typeof conditions[key] === 'object') {
        const isDateTimeCondition = Object.keys(conditions[key] as object).some((cKey) =>
          Conditions.conditionEndRange.includes(cKey),
        );
        if (isDateTimeCondition) {
          res = key.replace(`${Conditions.envStr}`, '');
          return res;
        }

        return await this.isPolicyDateTimeBased(conditions[key] as PolicyCondition, true);
      }

      return res;
    }
  }

  async isPolicyQueryBasedCondition(
    condition: PolicyCondition,
    schemaNames: string[],
  ): Promise<Record<string, unknown> | undefined> {
    for await (const key of Object.keys(condition)) {
      if (Array.isArray(condition[key])) {
        if (Conditions.logicalOperator.includes(key)) {
          for await (const item of condition[key] as PolicyCondition[]) {
            return await this.isPolicyQueryBasedCondition(item, schemaNames);
          }
        } else {
          // TODO throw an error
        }
      }

      const schemaQuery = schemaNames.find((n) => key.includes(n));

      if (schemaQuery) {
        const [identifier] = Object.keys((condition[key] as SchemaQueryCondition)['@identifier']);
        return {
          name: schemaQuery,
          [identifier]: Object.values((condition[key] as SchemaQueryCondition)['@identifier'][identifier]).pop(),
        };
      }
    }
  }
}

export default new Conditions();
