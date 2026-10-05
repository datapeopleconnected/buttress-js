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

import AccessControlConditions from './conditions.js';
import AccessControlFilter, { InvalidPolicyQueryError, UnknownOperatorError, UnresolvedEnvError } from './filter.js';
import AccessControlProjection from './projection.js';
import { CombineEnvGroups, filterPolicyConfigs, isPolicyExpired } from './helpers.js';
import { ACEnv } from './env.js';
import { ApplicablePolicyConfig, PolicyError } from './index.js';

import Logging from '../helpers/logging.js';
import { Policy, PolicyConfig, PolicyQuery } from '../model/core/policy.js';
import { Schema } from '../types/schema.js';

/**
 * The policy engine: what a token's policies grant on one schema for one verb (R5). REST evaluates them for a request,
 * and applies the grants to its query and to what it reads and writes; realtime evaluates them for an activity, and
 * tells a token about the entity when a grant reads it.
 */

export interface EvaluationContext {
  schemaName: string;
  // The app's schema by that name, or null if it has none; left out when the caller knows it has (an activity comes
  // from a write to it)
  schema?: Schema | null;
  isCoreSchema: boolean;
  verb: string;
  // Configs that let the token read the schema, whatever the verb, as realtime tells a token what it can read
  reads?: boolean;
  appId: string;
  // The env a config's condition and query are read with, its policy's and its own env added
  env: ACEnv;
  now?: Date;
}

/**
 * Access a token has, from one or more policy configs: the entities its query reads, and their properties it reads.
 */
export interface Grant {
  // The configs it's from, as `<policy name>#<index>`
  policies: string[];
  appId: string;
  // The config it's from, as the policy has it; for a merged grant, the first's
  config: PolicyConfig;
  // The query with its env read and its access keys dropped; {} reads every entity
  query: PolicyQuery;
  // The properties it reads, or null for every one
  projection: string[] | null;
}

const deny = (message: string, logTimerMsg: string) => new PolicyError(403, 'access_denied', message, logTimerMsg);

/**
 * The grants a token's policies (as selected for it) give on `context.schemaName` for `context.verb`, one for each
 * config that applies: its policy hasn't reached its limit, it's for the verb and schema, its condition holds, and its
 * query's env values are set. Each check that leaves nothing refuses with the PolicyError for it, so a request is
 * told which; a schema the app hasn't got is refused once a config is for it.
 * @param {Policy[]} policies
 * @param {EvaluationContext} context
 * @return {Promise<Grant[]>}
 */
export async function evaluate(policies: Policy[], context: EvaluationContext): Promise<Grant[]> {
  const { schemaName, verb, appId } = context;
  const now = context.now ?? new Date();

  // A policy whose limit has run out grants nothing, whether or not it has been removed yet
  const live = policies.filter((policy) => !isPolicyExpired(policy, now)).sort((a, b) => a.priority - b.priority);
  if (live.length < 1) {
    throw deny(
      `Request does not have any policy associated to it`,
      '_accessControlPolicy:access-control-policy-not-allowed',
    );
  }

  let applicable: ApplicablePolicyConfig[] = live.flatMap((policy) =>
    filterPolicyConfigs(policy, schemaName, verb, context.isCoreSchema, context.reads === true).map((config, idx) => ({
      id: policy.id,
      name: `${policy.name}#${idx}`,
      env: policy.env,
      appId,
      config: JSON.parse(JSON.stringify(config)) as PolicyConfig,
    })),
  );
  if (applicable.length < 1) {
    throw deny(
      `Request does not have any policy rules matching the request verb ${verb} and schema ${schemaName}`,
      '_accessControlPolicy:access-control-policy-not-allowed',
    );
  }

  if (context.schema === null) {
    throw new PolicyError(
      404,
      'unknown_schema',
      `Request schema: ${schemaName} - does not exist in the app`,
      '_accessControlPolicy:access-control-policy-not-allowed',
      { schema: schemaName },
    );
  }

  applicable = await AccessControlConditions.filterPoliciesByPolicyConditions(applicable, context.env);
  if (applicable.length < 1) {
    throw deny(
      `Access control policy condition is not fulfilled to access ${schemaName}`,
      '_accessControlPolicy:conditions-not-fulfilled',
    );
  }

  const grants: Grant[] = [];
  for (const policy of applicable) {
    if (!policy.config.query) continue;

    let query: PolicyQuery | null;
    try {
      query = await AccessControlFilter.buildPolicyQuery(policy.config.query, CombineEnvGroups(policy, context.env));
    } catch (err: unknown) {
      // A config whose query can't be built grants nothing: an env value isn't set, it names an operator nothing knows,
      // or it gives a logical operator something other than a list of queries
      const unreadable =
        err instanceof UnresolvedEnvError ||
        err instanceof UnknownOperatorError ||
        err instanceof InvalidPolicyQueryError;
      if (!unreadable) throw err;
      Logging.logWarn(`Policy ${policy.name} not applied: ${err.message}`);
      continue;
    }

    const keys = AccessControlProjection.getProjectionKeys(policy.config.projection);
    grants.push({
      policies: [policy.name],
      appId: policy.appId,
      config: policy.config,
      query: query ?? {},
      projection: keys.length > 0 ? keys : null,
    });
  }
  if (grants.length < 1) {
    throw deny(
      `Access control policy query can not be applied to ${schemaName}`,
      '_accessControlPolicy:query-not-resolved',
    );
  }

  return grants;
}

const ENV_PREFIX = '#env.';

// The env references in a value: its strings, and its objects' keys, that start with #env.
const envReferences = (value: unknown): string[] => {
  if (typeof value === 'string') return value.startsWith(ENV_PREFIX) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(envReferences);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [...envReferences(key), ...envReferences(item)]);
  }
  return [];
};

/**
 * Whether a config is read differently for each token: its query or condition refers to the token's user, directly
 * or through the policy's or the config's env (the config's read over the policy's, as CombineEnvGroups reads them),
 * an env lookup's query included. Realtime evaluates such a config for each token, and the rest once.
 * @param {object} policy - its env
 * @param {PolicyConfig} config
 * @return {boolean}
 */
export function dependsOnToken(
  policy: Pick<Policy, 'env'>,
  config: Pick<PolicyConfig, 'query' | 'condition' | 'env'>,
): boolean {
  const env: Record<string, unknown> = { ...(policy.env ?? {}), ...(config.env ?? {}) };
  const followed = new Set<string>();

  const refersToUser = (reference: string): boolean => {
    const [root] = reference.slice(ENV_PREFIX.length).split('.');
    if (!Object.hasOwn(env, root)) return root === 'user';
    if (followed.has(root)) return false;

    followed.add(root);
    return envReferences(env[root]).some(refersToUser);
  };

  return [...envReferences(config.query), ...envReferences(config.condition)].some(refersToUser);
}

const sameQuery = (a: PolicyQuery, b: PolicyQuery) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Grants merged where they can be without changing what they give together. They're alternatives: an entity can be
 * read through any grant whose query reads it, with the properties of each such grant. So grants with the same query
 * become one with every property either reads (all of them if either reads all), and grants that read every property
 * become one whose query ORs theirs. Grants with other queries that restrict properties are kept apart.
 * @param {Grant[]} grants - all for the same schema and verb
 * @return {Grant[]}
 */
export function mergeGrants(grants: Grant[]): Grant[] {
  const byQuery: Grant[] = [];
  for (const grant of grants) {
    const same = byQuery.find((existing) => sameQuery(existing.query, grant.query));
    if (!same) {
      byQuery.push({ ...grant, policies: [...grant.policies] });
      continue;
    }

    same.policies.push(...grant.policies);
    same.projection =
      same.projection && grant.projection ? [...new Set([...same.projection, ...grant.projection])] : null;
  }

  const merged: Grant[] = [];
  let unrestricted: Grant | null = null;
  for (const grant of byQuery) {
    if (grant.projection !== null) {
      merged.push(grant);
    } else if (!unrestricted) {
      unrestricted = grant;
      merged.push(grant);
    } else {
      unrestricted.policies.push(...grant.policies);
      unrestricted.query = AccessControlFilter.mergeQueryFilters(unrestricted.query, grant.query, '$or');
    }
  }

  return merged;
}
