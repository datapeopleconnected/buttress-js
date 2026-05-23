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
import { Schema } from '../helpers/schema.js';

type AccessControlScalar = string | number | boolean | Date;
type AccessControlValue = AccessControlScalar | AccessControlScalar[] | null;

function toComparableValue(value: AccessControlScalar): number | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'boolean') return Number(value);
  return value;
}

function toDateComparableValue(value: AccessControlValue): string | number | Date | null {
  if (value === null || Array.isArray(value) || typeof value === 'boolean') return null;
  return value;
}

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
  private __coreSchema?: Schema[];

  async cacheCoreSchema() {
    if (this.__coreSchema) return this.__coreSchema;

    // Accessing private..
    this.__coreSchema = Object.values(Model.CoreModels).map((model) => model.Schema);

    Logging.logSilly(`Refreshed core cache got ${this.__coreSchema.length} schema`);
    return this.__coreSchema;
  }

  evaluateOperation(lhs: AccessControlValue, rhs: AccessControlValue, operator: string): boolean {
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
          if (Array.isArray(lhs) || Array.isArray(rhs)) return false;
          passed = toComparableValue(lhs) > toComparableValue(rhs);
        }
        break;
      case '$lt':
      case '@lt':
        {
          if (Array.isArray(lhs) || Array.isArray(rhs)) return false;
          passed = toComparableValue(lhs) < toComparableValue(rhs);
        }
        break;
      case '$gte':
      case '@gte':
        {
          if (Array.isArray(lhs) || Array.isArray(rhs)) return false;
          passed = toComparableValue(lhs) >= toComparableValue(rhs);
        }
        break;
      case '$lte':
      case '@lte':
        {
          if (Array.isArray(lhs) || Array.isArray(rhs)) return false;
          passed = toComparableValue(lhs) <= toComparableValue(rhs);
        }
        break;
      case '$gtDate':
      case '@gtDate':
        {
          const lhsDate = wrangleDateType(lhs);
          const rhsDate = toDateComparableValue(rhs);
          if (!lhsDate) return false;
          if (!rhsDate) return false;
          passed = Sugar.Date.isAfter(lhsDate, rhsDate);
        }
        break;
      case '$gteDate':
      case '@gteDate':
        {
          const lhsDate = wrangleDateType(lhs);
          const lhsDateInput = toDateComparableValue(lhs);
          if (!lhsDate) return false;
          if (!lhsDateInput) return false;
          passed = Sugar.Date.isAfter(lhsDate, lhsDateInput) || Sugar.Date.is(lhsDate, lhsDateInput);
        }
        break;
      case '$ltDate':
      case '@ltDate':
        {
          const lhsDate = wrangleDateType(lhs);
          const rhsDate = toDateComparableValue(rhs);
          if (!lhsDate) return false;
          if (!rhsDate) return false;
          passed = Sugar.Date.isBefore(lhsDate, rhsDate);
        }
        break;
      case '$lteDate':
      case '@lteDate':
        {
          const lhsDate = wrangleDateType(lhs);
          const lhsDateInput = toDateComparableValue(lhs);
          if (!lhsDate) return false;
          if (!lhsDateInput) return false;
          passed = Sugar.Date.isBefore(lhsDate, lhsDateInput) || Sugar.Date.is(lhsDate, lhsDateInput);
        }
        break;
      case '$rex':
      case '@rex':
        {
          const regex = new RegExp(rhs.toString());
          passed = regex.test(lhs.toString());
        }
        break;
      case '$rexi':
      case '@rexi':
        {
          const regex = new RegExp(rhs.toString(), 'i');
          passed = regex.test(lhs.toString());
        }
        break;
      case '$in':
      case '@in':
        {
          if (!Array.isArray(rhs)) return false;

          if (Array.isArray(lhs)) {
            passed = lhs.every((i) => {
              return rhs.some((j) => j.toString() === i.toString());
            });
          } else {
            passed = Boolean(lhs) && rhs.some((i) => i.toString() === lhs.toString());
          }
        }
        break;
      case '$nin':
      case '@nin':
        {
          if (!Array.isArray(lhs)) return false;
          passed = lhs.every((i) => i !== rhs);
        }
        break;
      case '$exists':
      case '@exists':
        {
          if (Array.isArray(lhs)) {
            passed = lhs.includes(rhs as AccessControlScalar);
          } else {
            passed = lhs.toString().includes(rhs.toString());
          }
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
  obj: unknown,
  pattern: string,
): { path: string[]; type: 'key' | 'value'; value: string }[] {
  const occurrences: { path: string[]; type: 'key' | 'value'; value: string }[] = [];
  const regex = new RegExp(pattern);

  function recurse(currentObj: unknown, path: string[] = []): void {
    if (currentObj === null || currentObj === undefined) return;

    if (Array.isArray(currentObj)) {
      currentObj.forEach((item, index) => {
        const arrayPath = [...path, index.toString()];
        if (typeof item === 'string' && regex.test(item)) {
          occurrences.push({ path: arrayPath, type: 'value', value: item });
          return;
        }

        if (typeof item === 'object' && item !== null) recurse(item, arrayPath);
      });
      return;
    }

    if (typeof currentObj !== 'object') return;

    for (const key in currentObj) {
      if (!Object.prototype.hasOwnProperty.call(currentObj, key)) continue;

      const currentPath = [...path, key];
      const value = (currentObj as Record<string, unknown>)[key];

      if (regex.test(key)) {
        occurrences.push({ path: currentPath, type: 'key', value: key });
      }

      if (typeof value === 'string' && regex.test(value)) {
        occurrences.push({ path: currentPath, type: 'value', value });
        continue;
      }

      if (typeof value === 'object' && value !== null) recurse(value, currentPath);
    }
  }

  recurse(obj);
  return occurrences;
}
export function patternExists(obj: unknown, pattern: string): boolean {
  const regex = new RegExp(pattern);

  function recurse(currentObj: unknown): boolean {
    if (currentObj === null || currentObj === undefined) return false;

    if (Array.isArray(currentObj)) {
      for (const item of currentObj) {
        if (typeof item === 'string' && regex.test(item)) return true;
        if (typeof item === 'object' && item !== null && recurse(item)) return true;
      }
      return false;
    }

    if (typeof currentObj !== 'object') return false;

    for (const key in currentObj) {
      if (!Object.prototype.hasOwnProperty.call(currentObj, key)) continue;

      const value = (currentObj as Record<string, unknown>)[key];

      if (regex.test(key)) return true;
      if (typeof value === 'string' && regex.test(value)) return true;
      if (typeof value === 'object' && value !== null && recurse(value)) return true;
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

  const pattern = '(#env\.user)';
  outcome.env = patternExists(applicablePolicy.env, pattern);
  outcome.configEnv = patternExists(applicablePolicy.config.env, pattern);
  outcome.query = patternExists(applicablePolicy.config.query, pattern);
  outcome.condition = patternExists(applicablePolicy.config.condition, pattern);

  return outcome;
}
