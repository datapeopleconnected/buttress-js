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

import { Stream } from 'node:stream';

import AccessControlFilter, { QueryModel } from './filter.js';
import AccessControlProjection from './projection.js';
import { asQueried, matchQuery } from './operators.js';

import { PolicyConfig } from '../model/core/policy.js';
import { parsedPolicyConfig } from './index.js';

import { QueryParams } from '../types/bjs-query.js';
import StandardModel from '../model/type/standard.js';

// What a find or count needs of a model: a schema model, or a core model scoped to an app (TenantScopedModel)
export type QueryableModel = Pick<StandardModel<unknown>, 'parseQuery' | 'flatSchemaData' | 'find' | 'count'>;

export async function find<T extends QueryableModel>(
  model: T,
  query: QueryParams<object>,
  ac: { policyConfigs: parsedPolicyConfig[] },
) {
  if (ac.policyConfigs.length > 1) return findThroughGrants(model, query, ac.policyConfigs);

  const policyConfig = ac.policyConfigs[0] || {};
  const combined = await combineQueriesWithAc(query, policyConfig);
  return model.find(
    model.parseQuery(combined.query, {}, model.flatSchemaData),
    {},
    combined.limit,
    combined.skip,
    combined.sort,
    combined.project,
  );
}

// The entities any of several grants reads: their queries OR'd, {} if one reads every entity
const anyGrantQuery = (policyConfigs: parsedPolicyConfig[]) =>
  policyConfigs
    .map((policyConfig) => policyConfig.query ?? {})
    .reduce((reads, next) => AccessControlFilter.mergeQueryFilters(reads, next, '$or'));

// The properties a grant reads, or null for every one
const grantKeys = (policyConfig: parsedPolicyConfig) => {
  const keys = Object.entries(policyConfig.projection ?? {})
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
  return keys.length > 0 ? keys : null;
};

/**
 * The entities several grants read, in one find, so the request's skip, limit and sort hold across them and an entity
 * two of them read comes once (BUG-17). The find reads entities whole, for their grants' queries to be matched against
 * them as MongoDB matches them (D-31); each then keeps the properties of the grants that read it, within the request's
 * projection.
 */
async function findThroughGrants<T extends QueryableModel>(
  model: T,
  query: QueryParams<object>,
  policyConfigs: parsedPolicyConfig[],
) {
  // Every grant's query is read before anything is found, so one that can't be fails the request
  const grants = policyConfigs.map((policyConfig) => ({
    query: model.parseQuery(policyConfig.query ?? {}, {}, model.flatSchemaData) as Record<string, unknown>,
    keys: grantKeys(policyConfig),
  }));

  const combined = await combineQueriesWithAc(
    { ...query, project: undefined },
    { query: anyGrantQuery(policyConfigs) },
  );
  const found = (await model.find(
    model.parseQuery(combined.query, {}, model.flatSchemaData),
    {},
    combined.limit,
    combined.skip,
    combined.sort,
    fetchProjection(grants, query.project),
  )) as Stream.Readable;

  const projected = new Stream.Transform({
    objectMode: true,
    transform(entity: Record<string, unknown>, _enc, cb) {
      const asStored = asQueried(entity, model.flatSchemaData);
      const reading = grants.filter((grant) => matchQuery(grant.query, asStored));
      // Found by the OR of the grants, so one reads it; were none to, it isn't given
      if (reading.length < 1) return cb();

      const keys = reading.some((grant) => !grant.keys)
        ? null
        : [...new Set(reading.flatMap((grant) => grant.keys ?? []))];
      cb(
        null,
        projectEntity(entity, keys ? Object.keys(intersectProjection(query.project, keys)) : null, query.project),
      );
    },
  });

  // Fails the projected stream with the find's error, and stops the find if the projected stream is destroyed first
  return Stream.pipeline(found, projected, () => {});
}

// The properties a query tests, within its $and, $or and $nor too
const queryFields = (query: Record<string, unknown>): string[] =>
  Object.entries(query).flatMap(([key, value]) => {
    if (key === '$and' || key === '$or' || key === '$nor') {
      return Array.isArray(value)
        ? value.flatMap((part) =>
            part && typeof part === 'object' ? queryFields(part as Record<string, unknown>) : [],
          )
        : [];
    }
    return key.startsWith('$') ? [] : [key];
  });

/**
 * What the find for several grants reads of each entity: every property a grant reads, or, when one reads every
 * property, what the request projects (everything if it projects nothing); and the fields the grants' queries test,
 * for them to be matched. A path within another that's read isn't named too, as MongoDB refuses both.
 */
function fetchProjection(grants: { query: Record<string, unknown>; keys: string[] | null }[], requested: unknown) {
  const requestedKeys =
    requested && typeof requested === 'object'
      ? Object.entries(requested as Record<string, unknown>)
          .filter(([, value]) => value === 1 || value === true)
          .map(([key]) => key)
      : [];

  const readsEverything = grants.some((grant) => !grant.keys);
  if (readsEverything && requestedKeys.length < 1) return false;

  const read = readsEverything ? requestedKeys : grants.flatMap((grant) => grant.keys ?? []);
  const paths = [...new Set([...read, ...grants.flatMap((grant) => queryFields(grant.query))])];
  const outermost = paths.filter((path) => !paths.some((other) => other !== path && isWithin(path, other)));
  return Object.fromEntries(outermost.map((path) => [path, 1]));
}

/**
 * An entity with only the properties `keys` names, and its id and sourceId, as a MongoDB projection gives it; or, with
 * no keys, as the request's own projection gives it.
 */
function projectEntity(entity: Record<string, unknown>, keys: string[] | null, requested: unknown) {
  if (keys) return AccessControlProjection.__projectEntity(entity, keys);

  const entries =
    requested && typeof requested === 'object' ? Object.entries(requested as Record<string, unknown>) : [];
  const included = entries.filter(([, value]) => value === 1 || value === true).map(([key]) => key);
  if (included.length > 0) return AccessControlProjection.__projectEntity(entity, included);

  const excluded = entries.filter(([, value]) => value === 0 || value === false).map(([key]) => key);
  if (excluded.length < 1) return entity;
  const kept = structuredClone(entity);
  excluded.forEach((path) => removePath(kept, path.split('.')));
  return kept;
}

// Removes what a dotted path names, as an exclusion projection does, from each item of an array on the way too
function removePath(value: unknown, [head, ...rest]: string[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => removePath(item, [head, ...rest]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (rest.length < 1) delete record[head];
  else removePath(record[head], rest);
}

export async function count<T extends QueryableModel>(
  model: T,
  query: QueryParams<object>,
  ac: { policyConfigs: parsedPolicyConfig[] },
  // Counted per policy config before, an entity two of them read twice; now always the entities the request reaches
  _actualCount: boolean = false,
) {
  const reads = ac.policyConfigs.length > 0 ? { query: anyGrantQuery(ac.policyConfigs) } : {};
  const combined = await combineQueriesWithAc(query, reads);

  return model.count(model.parseQuery(combined.query));
}

/**
 * Whether the caller's policies let it reach every entity, so a query needs no access-control filter. A system token
 * has no policy configs, and a `%FULL_ACCESS%` query is built down to `{}`. The configs are alternatives, so one
 * without a query is enough. Projections only limit which fields can be read, not which entities.
 */
export function reachesEveryEntity(ac: { policyConfigs: parsedPolicyConfig[] }) {
  if (ac.policyConfigs.length < 1) return true;
  return ac.policyConfigs.some((policyConfig) => !policyConfig.query || Object.keys(policyConfig.query).length < 1);
}

/**
 * Whether the caller's policies let it create `entity`, given as it will be stored: a config's query must read it, as
 * it would have to for the caller to read or change it.
 */
export function canCreate(
  ac: { policyConfigs: parsedPolicyConfig[] },
  entity: Record<string, unknown>,
  model: QueryModel,
) {
  if (reachesEveryEntity(ac)) return true;
  return ac.policyConfigs.some(
    (policyConfig) =>
      !policyConfig.query ||
      Object.keys(policyConfig.query).length < 1 ||
      AccessControlFilter.evaluateQueryAgainstEntity(policyConfig.query, entity, model),
  );
}

export async function combineQueriesWithAc(
  raw: QueryParams<object>,
  policyConfig: Partial<Pick<PolicyConfig, 'query' | 'projection'>>,
) {
  const query: QueryParams<object> = {
    query: raw.query,
    skip: raw.skip,
    limit: raw.limit,
    sort: raw.sort,
    project: raw.project,
  };

  // Combine the user request query with the access control query we're trying to run.
  if (policyConfig.query) {
    query.query = await AccessControlFilter.mergeQueryFiltersWithAccessControl(query.query, policyConfig.query);
  }

  if (policyConfig.projection) {
    const policyKeys = Object.entries(policyConfig.projection)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key);
    if (policyKeys.length > 0) query.project = intersectProjection(query.project, policyKeys);
  }

  return query;
}

// `path` is `key` or a path beneath it
const isWithin = (path: string, key: string) => path === key || path.startsWith(`${key}.`);

/**
 * The properties both the request's projection and the policy's keys name: a requested property the policy allows, or
 * the parts of a requested property that the policy allows. A request that names none of them, or projects by
 * exclusion, gets the policy's properties.
 */
function intersectProjection(requested: unknown, policyKeys: string[]): Record<string, 1> {
  const requestedKeys =
    requested && typeof requested === 'object'
      ? Object.entries(requested as Record<string, unknown>)
          .filter(([, value]) => value === 1 || value === true)
          .map(([key]) => key)
      : [];

  const keys = new Set<string>();
  for (const key of requestedKeys) {
    if (policyKeys.some((policyKey) => isWithin(key, policyKey))) {
      keys.add(key);
    } else {
      policyKeys.filter((policyKey) => isWithin(policyKey, key)).forEach((policyKey) => keys.add(policyKey));
    }
  }

  const projected = keys.size > 0 ? [...keys] : policyKeys;
  return Object.fromEntries(projected.map((key) => [key, 1]));
}
