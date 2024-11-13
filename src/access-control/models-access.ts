/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

import AccessControlFilter from './filter';

import { PolicyConfig } from '../model/core/policy';
import { parsedPolicyConfig } from './index'

export async function find(model, query: QueryParams<object>, ac: {policyConfigs: parsedPolicyConfig[]}) {
  if (ac.policyConfigs.length > 1) {
    const resStream = new Stream.PassThrough({objectMode: true});

    let openStreams = 0;
    // Using forEach here because we don't want to wait for each function to finish before calling the next.
    ac.policyConfigs.forEach(async (policyConfig) => {
      const conbined = await combineQueriesWithAc(query, policyConfig);
      const result = model.find(model.parseQuery(conbined.query), {}, conbined.limit, conbined.skip, conbined.sort, conbined.project);

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
  const conbined = await combineQueriesWithAc(query, policyConfig);

  return model.find(model.parseQuery(conbined.query), {}, conbined.limit, conbined.skip, conbined.sort, conbined.project);
}

export async function count(model, query: QueryParams<object>, ac: {policyConfigs: parsedPolicyConfig[]}, actualCount: boolean = false) {
  if (ac.policyConfigs.length > 1) {
    if (actualCount) {
      let count = 0;

      for (const policyConfig of ac.policyConfigs) {
        const conbined = await combineQueriesWithAc(query, policyConfig);
        count += await model.count(model.parseQuery(conbined.query));
      }

      return count;
    } else {
      const queries: {$or: BjsQuery<object>[]} = {$or: []};
      for (const policyConfig of ac.policyConfigs) {
        const conbined = await combineQueriesWithAc(query, policyConfig);
        queries.$or.push(conbined.query);
      }

      return model.count(model.parseQuery(queries));
    }
  }

  const policyConfig = ac.policyConfigs[0] || {};
  const conbined = await combineQueriesWithAc(query, policyConfig);

  return model.count(model.parseQuery(conbined.query));
}

export async function combineQueriesWithAc(raw: QueryParams<object>, policyConfig: PolicyConfig & { appId: string }) {
  const query: QueryParams<object> = {
    query: raw.query,
    skip: raw.skip,
    limit: raw.limit,
    sort: raw.sort,
    project: raw.project
  };

  // TODO: Merge in PolicyConfig.query
  query.query = await AccessControlFilter.applyAccessControlPolicyQuery(query.query, policyConfig);

  if (policyConfig.projection !== null) {
    // TODO: We may need to do more in making sure the user isn't projection to something they don't have.
    if (query.project === null) query.project = {};
    query.project = {...query.project, ...policyConfig.projection};
  }

  return query;
}