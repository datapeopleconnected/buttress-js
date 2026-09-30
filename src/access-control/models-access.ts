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

import AccessControlFilter from './filter.js';

import { PolicyConfig } from '../model/core/policy.js';
import { parsedPolicyConfig } from './index.js';

import { BjsQuery, QueryParams } from '../types/bjs-query.js';
import StandardModel from '../model/type/standard.js';

export async function find<T extends StandardModel<unknown>>(
  model: T,
  query: QueryParams<object>,
  ac: { policyConfigs: parsedPolicyConfig[] },
) {
  if (ac.policyConfigs.length > 1) {
    // Resolve + parse every policy's query up front, awaited via Promise.all, before the stream is
    // ever created. A policy config that fails to parse (e.g. a query shape that doesn't match the
    // target schema) rejects this function's promise, so the caller's normal error handling responds
    // with a proper error. Previously this loop used `forEach(async ...)` so a rejection here became
    // an unhandled promise rejection: the returned stream would silently `end()` early, having only
    // ever included the OTHER policies' results, with a 200 response and no indication anything failed.
    const preparedQueries = await Promise.all(
      ac.policyConfigs.map(async (policyConfig) => {
        const combined = await combineQueriesWithAc(query, policyConfig);
        return { ...combined, query: model.parseQuery(combined.query, {}, model.flatSchemaData) };
      }),
    );

    const resStream = new Stream.PassThrough({ objectMode: true });

    let openStreams = 0;
    // Still not awaiting each find() before starting the next — this is the part worth running
    // concurrently (the actual per-document datastore stream), now that every policy's query is
    // already known to be valid.
    const results = preparedQueries.map((combined) => {
      // Not awaited, so this only works for models whose find is synchronous, a federated model's isn't
      const result = model.find(
        combined.query,
        {},
        combined.limit,
        combined.skip,
        combined.sort,
        combined.project,
      ) as Stream.Readable;

      result.pipe(resStream, { end: false });
      result.on('end', () => {
        openStreams--;
        if (openStreams === 0) resStream.end();
      });
      // pipe() doesn't pass errors on, so one policy's failed find fails the merged stream.
      result.on('error', (err) => resStream.destroy(err));

      openStreams++;
      return result;
    });

    // Once the merged stream is done with, failed or not, the finds still running aren't needed.
    resStream.once('close', () => results.forEach((result) => result.destroy()));

    return resStream;
  }

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

export async function count<T extends StandardModel<unknown>>(
  model: T,
  query: QueryParams<object>,
  ac: { policyConfigs: parsedPolicyConfig[] },
  actualCount: boolean = false,
) {
  if (ac.policyConfigs.length > 1) {
    if (actualCount) {
      let count = 0;

      for (const policyConfig of ac.policyConfigs) {
        const combined = await combineQueriesWithAc(query, policyConfig);
        count += await model.count(model.parseQuery(combined.query));
      }

      return count;
    } else {
      const queries: { $or: BjsQuery<object>[] } = { $or: [] };
      for (const policyConfig of ac.policyConfigs) {
        const combined = await combineQueriesWithAc(query, policyConfig);
        queries.$or.push(combined.query);
      }

      return model.count(model.parseQuery(queries));
    }
  }

  const policyConfig = ac.policyConfigs[0] || {};
  const combined = await combineQueriesWithAc(query, policyConfig);

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
export function canCreate(ac: { policyConfigs: parsedPolicyConfig[] }, entity: Record<string, unknown>) {
  if (reachesEveryEntity(ac)) return true;
  return ac.policyConfigs.some(
    (policyConfig) =>
      !policyConfig.query ||
      Object.keys(policyConfig.query).length < 1 ||
      AccessControlFilter.evaluateQueryAgainstEntity(policyConfig.query, entity),
  );
}

export async function combineQueriesWithAc(raw: QueryParams<object>, policyConfig: PolicyConfig & { appId: string }) {
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
