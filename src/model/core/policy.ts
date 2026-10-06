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
import StandardModel from '../type/standard.js';
import { TenantKey } from '../type/tenant-scoped.js';
import { PolicyCache } from '../../services/policy-cache.js';

import * as Helpers from '../../helpers/index.js';
import { Schema } from '../../helpers/schema.js';
import { Services } from '../../bootstrap.js';
import { AdapterQuery, UpdatePathBody } from '../../types/datastore.js';

export interface PolicyEnvQuery {
  type: 'string' | 'id' | 'array' | 'boolean';
  collection: string;
  query: Record<string, unknown>;
  output: {
    key: string;
    type: 'string' | 'id';
  };
}
export interface PolicyEnv {
  [key: string]: string | PolicyEnvQuery;
}

export interface PolicySelection {
  [key: string]: { [key: string]: string };
}

export interface PolicyQuery {
  [key: string]: unknown;
}

export interface PolicyCondition {
  [key: string]: unknown;
}

export interface PolicyProjection {
  [key: string]: unknown;
}

export interface PolicyConfig {
  verbs: string[];
  endpoints: string[];
  schema: string[];
  env?: PolicyEnv | null;
  condition?: PolicyCondition | null;
  query?: PolicyQuery | null;
  projection?: PolicyProjection | null;
}
// A type rather than an interface, so it's assignable to AdapterDocument
export type Policy = {
  id: string;
  name: string;
  // add doesn't store it, so it's null unless set by an update
  version: string | null;
  priority: number;
  selection: PolicySelection | null;
  env: PolicyEnv | null;
  config: PolicyConfig[];
  limit: Date | null;
  _appId: string;
};

// A policy as passed to add
export type PolicyAddBody = {
  id?: string;
  name?: string | null;
  priority?: number;
  selection?: PolicySelection | null;
  env?: PolicyEnv | null;
  config?: Partial<PolicyConfig>[];
  limit?: string | number | Date | null;
  version?: string | null;
};

class PolicySchemaModel extends StandardModel<Policy> {
  static override name = 'Policy';
  // Each row names the app it belongs to
  static TenantKey: TenantKey = '_appId';

  __policyCache: PolicyCache;

  constructor(services: Services) {
    const schema = PolicySchemaModel.Schema;
    super(schema, null, services);

    this.__policyCache = this.__services.get('policyCache') as PolicyCache;
    if (!this.__policyCache) throw new Error('Unable to find policyCache in services');
  }

  static get Schema(): Schema {
    return {
      name: 'policy',
      type: 'collection',
      extends: [],
      core: true,
      properties: {
        name: {
          __type: 'string',
          __default: null,
          __required: true,
          __allowUpdate: true,
        },
        version: {
          __type: 'string',
          __default: null,
          __required: true,
          __allowUpdate: true,
        },
        priority: {
          __type: 'number',
          __default: 0,
          __required: false,
          __allowUpdate: true,
        },
        selection: {
          __type: 'object',
          __default: null,
          __required: true,
          __allowUpdate: true,
        },
        env: {
          __type: 'object',
          __default: {},
          __required: false,
          __allowUpdate: true,
        },
        config: {
          __type: 'array',
          __allowUpdate: true,
          __schema: {
            verbs: {
              __type: 'array',
              __itemtype: 'string',
              __required: true,
              __allowUpdate: true,
            },
            endpoints: {
              __type: 'array',
              __itemtype: 'string',
              __required: false,
              __allowUpdate: true,
            },
            schema: {
              __type: 'array',
              __itemtype: 'string',
              __required: true,
              __allowUpdate: true,
            },
            env: {
              __type: 'object',
              __default: null,
              __required: false,
              __allowUpdate: true,
            },
            condition: {
              __type: 'object',
              __default: null,
              __required: false,
              __allowUpdate: true,
            },
            projection: {
              __type: 'object',
              __default: null,
              __required: false,
              __allowUpdate: true,
            },
            query: {
              __type: 'object',
              __default: null,
              __required: true,
              __allowUpdate: true,
            },
          },
        },
        limit: {
          __type: 'date',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        _appId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
      },
    };
  }

  /**
   * Stores a policy as the schema reads it, with its defaults for what it leaves out.
   * @param {Object} body - policy object
   * @param {String} appId - app id
   * @return {Promise} - fulfilled with policy Object when the database request is completed
   */
  override async add(body: PolicyAddBody, internals: { _appId: string }) {
    const rxsPolicy = await super.add(body, {
      _appId: internals._appId,
    });
    const policy = (await Helpers.streamFirst(rxsPolicy)) as Policy;

    await this.__policyCache.invalidatePolicyAndTokensBySelection(policy.id.toString());

    return policy;
  }

  // update() {

  // }
  // updateOne() {

  // }
  override async updateById(id: string, query: AdapterQuery) {
    const result = await super.updateById(this.createId(id), query);

    await this.__policyCache.invalidatePolicyAndTokensBySelection(id.toString());

    return result;
  }
  override async updateByPath(body: UpdatePathBody | UpdatePathBody[], id: string, via: string | null = null) {
    const policy = await super.updateByPath(body, id, via);

    await this.__policyCache.invalidatePolicyAndTokensBySelection(id.toString());

    return policy;
  }

  override async rm(id: string) {
    await super.rm(id);
    await this.__policyCache.removePolicy(id);
  }

  override async rmBulk(ids: string[]) {
    const out = await super.rmBulk(ids);
    await Promise.all(ids.map((id) => this.__policyCache.removePolicy(id)));
    return out;
  }

  // Nuke from orbit.
  // rmAll() {

  // }
}

/**
 * Exports
 */
export default PolicySchemaModel;
