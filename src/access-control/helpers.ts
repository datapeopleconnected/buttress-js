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
    // Lists, matched by their items. Text there, which an earlier release could store for a data sharing agreement,
    // grants nothing: it would match by its substrings
    if (!c.query || !Array.isArray(c.verbs) || !Array.isArray(c.schema)) return false;

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

/**
 * When a policy's limit runs out, or null if it has none, or one that isn't a date (which isPolicyExpired takes as run
 * out). A cached policy has been through JSON, so its limit can be a string.
 */
export const policyLimit = (policy: { limit?: unknown }): Date | null => {
  if (!policy.limit) return null;
  const limit = new Date(policy.limit as string | number | Date);
  return Number.isNaN(limit.getTime()) ? null : limit;
};

/**
 * Whether a policy's limit has run out, so it grants nothing. A limit that isn't a date, which saving a policy refuses,
 * has: it was read as no limit, so a policy stored with a mistyped date granted access for ever.
 */
export const isPolicyExpired = (policy: { limit?: unknown }, now: Date = new Date()) => {
  if (!policy.limit) return false;
  const limit = policyLimit(policy);
  return limit === null || limit.getTime() <= now.getTime();
};
