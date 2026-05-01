/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

export async function find<T extends StandardModel>(
  model: T,
  query: QueryParams<object>,
  ac: { policyConfigs: parsedPolicyConfig[] },
) {
  if (ac.policyConfigs.length > 1) {
    const resStream = new Stream.PassThrough({ objectMode: true });

    let openStreams = 0;
    // Using forEach here because we don't want to wait for each function to finish before calling the next.
    ac.policyConfigs.forEach(async (policyConfig) => {
      const combined = await combineQueriesWithAc(query, policyConfig);
      const result = model.find(
        model.parseQuery(combined.query, {}, model.flatSchemaData),
        {},
        combined.limit,
        combined.skip,
        combined.sort,
        combined.project,
      );

      result.pipe(resStream, { end: false });
      result.on('end', () => {
        openStreams--;
        if (openStreams === 0) resStream.end();
      });

      openStreams++;
    });

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

export async function count<T extends StandardModel>(
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

  if (policyConfig.projection !== null) {
    // TODO: We may need to do more in making sure the user isn't projection to something they don't have.
    if (query.project === null) query.project = {};
    query.project = { ...query.project, ...policyConfig.projection };
  }

  return query;
}
