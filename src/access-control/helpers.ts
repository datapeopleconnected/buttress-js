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

import Model from '../model/index.js';
import Logging from '../helpers/logging.js';

import { ApplicablePolicyConfig } from './index.js';
import { ACEnv, ACPolicyEnvCombined } from './env.js';

import { Policy, PolicyConfig } from '../model/core/policy.js';

export function CombineEnvGroups(policy: ApplicablePolicyConfig, reqEnv: ACEnv): ACPolicyEnvCombined {
  let env: ACPolicyEnvCombined = { ...reqEnv };
  if (policy.env !== null) env = { ...env, ...policy.env };
  if (policy.config.env !== null) env = { ...env, ...policy.config.env };

  return env;
}

/**
 * @class Conditoins
 */
class Helpers {
  private __coreSchema?: any[];

  async cacheCoreSchema() {
    if (this.__coreSchema) return this.__coreSchema;

    // Accessing private..
    this.__coreSchema = Object.values(Model.CoreModels).map((model) => model.Schema);

    Logging.logSilly(`Refreshed core cache got ${this.__coreSchema.length} schema`);
    return this.__coreSchema;
  }

  evaluateOperation(lhs, rhs, operator): boolean {
    let passed = false;

    if (rhs === null || lhs === null) {
      // If either are null then we'll just fail the check, with the exeption being if we're checking for null.
      if (rhs === null && lhs === null && (operator === '$eq' || operator === '@eq')) return true;

      return false;
    }

    switch (operator) {
      case '$eq':
      case '@eq':
        {
          passed = lhs.toString().toUpperCase() === rhs.toString().toUpperCase();
        }
        break;
      case '$not':
      case '@not':
        {
          passed = lhs.toString().toUpperCase() !== rhs.toString().toUpperCase();
        }
        break;
      case '$gt':
      case '@gt':
        {
          passed = lhs > rhs;
        }
        break;
      case '$lt':
      case '@lt':
        {
          passed = lhs < rhs;
        }
        break;
      case '$gte':
      case '@gte':
        {
          passed = lhs >= rhs;
        }
        break;
      case '$lte':
      case '@lte':
        {
          passed = lhs <= rhs;
        }
        break;
      case '$gtDate':
      case '@gtDate':
        {
          const lhsDate = wrangleDateType(lhs);
          if (!lhsDate) return false;
          passed = Sugar.Date.isAfter(lhsDate, rhs);
        }
        break;
      case '$gteDate':
      case '@gteDate':
        {
          const lhsDate = wrangleDateType(lhs);
          if (!lhsDate) return false;
          passed = Sugar.Date.isAfter(lhsDate, lhs) || Sugar.Date.is(lhsDate, lhs);
        }
        break;
      case '$ltDate':
      case '@ltDate':
        {
          const lhsDate = wrangleDateType(lhs);
          if (!lhsDate) return false;
          passed = Sugar.Date.isBefore(lhsDate, rhs);
        }
        break;
      case '$lteDate':
      case '@lteDate':
        {
          const lhsDate = wrangleDateType(lhs);
          if (!lhsDate) return false;
          passed = Sugar.Date.isBefore(lhsDate, lhs) || Sugar.Date.is(lhsDate, lhs);
        }
        break;
      case '$rex':
      case '@rex':
        {
          const regex = new RegExp(rhs);
          passed = regex.test(lhs);
        }
        break;
      case '$rexi':
      case '@rexi':
        {
          const regex = new RegExp(rhs, 'i');
          passed = regex.test(lhs);
        }
        break;
      case '$in':
      case '@in':
        {
          if (Array.isArray(lhs)) {
            passed = lhs.every((i) => {
              return rhs.some((j) => j.toString() === i.toString());
            });
          } else {
            passed = lhs && rhs.some((i) => i.toString() === lhs.toString());
          }
        }
        break;
      case '$nin':
      case '@nin':
        {
          passed = lhs.every((i) => i !== lhs);
        }
        break;
      case '$exists':
      case '@exists':
        {
          passed = lhs.includes(rhs);
        }
        break;
      default:
    }

    return passed;
  }
}

// Wrangle the type over to a sugar date
function wrangleDateType(val: unknown): Date | null | undefined {
  if (val === null) return null;
  if (val === undefined) return undefined;
  if (typeof val === 'string') {
    return Sugar.Date.create(val);
  }

  return val as Date;
}

export default new Helpers();

export function filterPolicyConfigs(
  policy: Policy,
  schemaName: string,
  verb: string,
  isCoreSchema: boolean,
  verbCheckReadability: boolean = false,
): PolicyConfig[] {
  return policy.config.filter((c) => {
    if (!c.query || !c.verbs || !c.schema) return false;

    let verbCheck = c.verbs.includes('%ALL%') || c.verbs.includes(verb);

    if (verbCheckReadability) {
      verbCheck = c.verbs.includes('%ALL%') || c.verbs.includes('GET') || c.verbs.includes('SEARCH');
    }

    const schemaCheck =
      c.schema.includes('%ALL%') ||
      c.schema.includes(schemaName) ||
      c.schema.includes(isCoreSchema ? '%CORE_SCHEMA%' : '%APP_SCHEMA%');

    return verbCheck && schemaCheck;
  });
}

export function findPatternOccurrences(
  obj: any,
  pattern: string,
): { path: string[]; type: 'key' | 'value'; value: string }[] {
  const occurrences: { path: string[]; type: 'key' | 'value'; value: string }[] = [];
  const regex = new RegExp(pattern);

  function recurse(currentObj: any, path: string[] = []): void {
    for (const key in currentObj) {
      if (Object.prototype.hasOwnProperty.call(currentObj, key)) {
        const currentPath = [...path, key];
        const value = currentObj[key];

        if (typeof key === 'string' && regex.test(key)) {
          occurrences.push({ path: currentPath, type: 'key', value: key });
        }

        if (typeof value === 'string' && regex.test(value)) {
          occurrences.push({ path: currentPath, type: 'value', value: value });
        } else if (typeof value === 'object' && value !== null) {
          recurse(value, currentPath);
        } else if (Array.isArray(value)) {
          value.forEach((item, index) => {
            const arrayPath = [...currentPath, index.toString()]; // Convert index to string
            if (typeof item === 'string' && regex.test(item)) {
              occurrences.push({ path: arrayPath, type: 'value', value: item });
            } else if (typeof item === 'object' && item !== null) {
              recurse(item, arrayPath);
            }
          });
        }
      }
    }
  }

  recurse(obj);
  return occurrences;
}
export function patternExists(obj: any, pattern: string): boolean {
  const regex = new RegExp(pattern);

  function recurse(currentObj: any): boolean {
    for (const key in currentObj) {
      if (Object.prototype.hasOwnProperty.call(currentObj, key)) {
        const value = currentObj[key];

        if (typeof key === 'string' && regex.test(key)) {
          return true;
        }

        if (typeof value === 'string' && regex.test(value)) {
          return true;
        } else if (typeof value === 'object' && value !== null) {
          if (recurse(value)) {
            return true;
          }
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string' && regex.test(item)) {
              return true;
            } else if (typeof item === 'object' && item !== null) {
              if (recurse(item)) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  }

  return recurse(obj);
}

export function containsTokenLevelRef(applicablePolicy: ApplicablePolicyConfig) {
  const outcome = {
    env: false,
    configEnv: false,
    condition: false,
    query: false,
  };

  // eslint-disable-next-line no-useless-escape
  const pattern = '(#env\.user)';
  outcome.env = patternExists(applicablePolicy.env, pattern);
  outcome.configEnv = patternExists(applicablePolicy.config.env, pattern);
  outcome.query = patternExists(applicablePolicy.config.query, pattern);
  outcome.condition = patternExists(applicablePolicy.config.condition, pattern);

  return outcome;
}
