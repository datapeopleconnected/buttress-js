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
import { CombineEnvGroups } from './helpers.js';
import { matchCriterion } from './criteria.js';
import { ALIASES, LOGICAL_ALIASES } from './operators.js';
import Logging from '../helpers/logging.js';
import Env, { ACEnv, ACPolicyEnvCombined } from './env.js';

import { ApplicablePolicyConfig } from './index.js';
import { PolicyCondition } from '../model/core/policy.js';

/**
 * @class Conditoins
 */
export class Conditions {
  async filterPoliciesByPolicyConditions(userPolicies: ApplicablePolicyConfig[], reqEnv: ACEnv) {
    const output: ApplicablePolicyConfig[] = [];

    for await (const policy of userPolicies) {
      // A config without a condition applies, as one whose condition is null does
      const condition = policy.config.condition;
      if (condition === null || condition === undefined || (await this.__checkPolicyConditions(policy, reqEnv))) {
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
      // @and and @or (or $and and $or) take a list of conditions, which all, or any one, must hold
      const logical = LOGICAL_ALIASES[key];
      if (logical === '$and' || logical === '$or') {
        const innerPartialPass = logical === '$or';

        const innerResults: Array<boolean> = [];
        // TODO: Add check as this is expected to be an array.
        const nestedConditions = conditionRecord[key];
        if (!Array.isArray(nestedConditions)) continue;
        for await (const conditionObj of nestedConditions as unknown[]) {
          if (typeof conditionObj !== 'object' || conditionObj === null) continue;
          // Each branch is a whole condition, its parts AND'd; the OR is across branches
          innerResults.push(await this.__checkCondition(conditionObj as PolicyCondition, envVariables, false));
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

    // A criterion with no operator holds for nothing, as a selection's selects nothing
    const operators = Object.keys(conditionEntry);
    if (operators.length < 1) return false;

    for await (const operator of operators) {
      results.push(await this.__checkConditionQuery(envVariables, operator, conditionObj, key));
    }

    if (partialPass) return results.some((r) => r);

    // The condition defaults are treated as AND by default.
    return results.every((r) => r);
  }

  /**
   * Whether one criterion of a condition, `{<key>: {<operator>: <value>}}`, holds. It reads `value OP key` (D-33):
   * `{'#env.date.now': {'@ltDate': '2025-01-01'}}` holds when 2025-01-01 is before now. Both sides are resolved
   * through the env, and compared as a query compares a field holding the value with the key's value as its operand
   * (D-32). A side that resolves to nothing fails.
   */
  async __checkConditionQuery(
    envVariables: ACPolicyEnvCombined | null,
    operator: string,
    conditionObj: Record<string, unknown>,
    key: string,
  ) {
    // An operator nothing knows fails the condition, so the config grants nothing, and the token's others still apply
    if (!Object.hasOwn(ALIASES, operator)) {
      Logging.logWarn(`A policy condition names an operator nothing knows, so it fails: ${operator}`);
      return false;
    }

    const conditionEntry = conditionObj[key] as Record<string, unknown>;
    const value = await Env.getEnvValue(conditionEntry[operator], envVariables);
    const keyValue = await Env.getEnvValue(key, envVariables);

    if (value === undefined || keyValue === undefined) return false;

    return matchCriterion(value, operator, keyValue);
  }
}

export default new Conditions();
