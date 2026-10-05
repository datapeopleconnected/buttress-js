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

import Model from '../model/index.js';
import Logging from '../helpers/logging.js';

import { ApplicablePolicyConfig } from './index.js';
import { ACEnv, ACPolicyEnvCombined } from './env.js';

import { Policy, PolicyConfig } from '../model/core/policy.js';
import { Schema } from '../helpers/schema.js';

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
}

export default new Helpers();

// QUERY and SEARCH, its name before RFC 10008, are one verb to a policy: either grants both
const QUERY_VERBS = ['QUERY', 'SEARCH'];

// The verbs that read a schema, so the policies granting one decide what a token sees of it
export const READ_POLICY_VERBS = ['GET', ...QUERY_VERBS];

/**
 * Whether a policy config's `verbs` grant `verb`.
 * @param {string[]} verbs - the config's verbs
 * @param {string} verb - a request's method
 * @return {boolean}
 */
export function grantsVerb(verbs: string[], verb: string): boolean {
  if (verbs.includes('%ALL%') || verbs.includes(verb)) return true;
  return QUERY_VERBS.includes(verb) && verbs.some((v) => QUERY_VERBS.includes(v));
}

export function filterPolicyConfigs(
  policy: Policy,
  schemaName: string,
  verb: string,
  isCoreSchema: boolean,
  verbCheckReadability: boolean = false,
): PolicyConfig[] {
  return policy.config.filter((c) => {
    if (!c.query || !c.verbs || !c.schema) return false;

    const verbCheck = verbCheckReadability
      ? READ_POLICY_VERBS.some((v) => grantsVerb(c.verbs, v))
      : grantsVerb(c.verbs, verb);

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
      currentObj.forEach((item: unknown, index: number) => {
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
      for (const item of currentObj as unknown[]) {
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

/**
 * When a policy's limit runs out, or null if it has none. A cached policy has been through JSON, so its limit can be
 * a string.
 */
export const policyLimit = (policy: { limit?: unknown }): Date | null => {
  if (!policy.limit) return null;
  const limit = new Date(policy.limit as string | number | Date);
  return Number.isNaN(limit.getTime()) ? null : limit;
};

/**
 * Whether a policy's limit has run out, so it grants nothing.
 */
export const isPolicyExpired = (policy: { limit?: unknown }, now: Date = new Date()) => {
  const limit = policyLimit(policy);
  return limit !== null && limit.getTime() <= now.getTime();
};
