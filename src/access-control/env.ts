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
import { ObjectId } from 'bson';
import { Request } from 'express';

import * as Helpers from '../helpers/index.js';

import { PolicyEnvQuery } from '../model/core/policy.js';

import Model from '../model/index.js';
import { Filter } from './filter.js';
import { User } from '../model/core/user.js';
import { isObjectId } from '../datastore/adapters/object-id.js';

type DynamicRow = Record<string, unknown>;

// Ids are strings outside the datastore adapters; this gives a valid id in its canonical (hex) form
function toIdIfValid(value: unknown): unknown {
  if (isObjectId(value)) return value.toHexString();
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value).toHexString();
  return value;
}

const isId = (value: unknown) => typeof value === 'string' && ObjectId.isValid(value);

export interface ACBaseEnv {
  date: {
    now: string;
  };
}

export interface ACEnv extends ACBaseEnv {
  ipAddress: string | null;
  user: User | null;
  appId: string | null;
}

export interface ACPolicyEnvCombined extends ACEnv {
  // Policy env definitions, and the values they've been resolved to
  [custom: string]: unknown;
}

// How many #env values reading one can take, each referring to the next, before it's given up on
const MAX_ENV_DEPTH = 16;

// A policy's #env value that refers back to itself, directly or through other env values (or env lookups' queries), or
// that takes more than MAX_ENV_DEPTH of them to read, which can't be read
export class CircularEnvError extends Error {
  constructor(chain: string[]) {
    const [first] = chain;
    super(
      chain.length > MAX_ENV_DEPTH
        ? `circular_policy_env: ${first} takes more than ${MAX_ENV_DEPTH} env values to read`
        : `circular_policy_env: ${chain.join(' -> ')}`,
    );
    this.name = 'CircularEnvError';
  }
}

export class PolicyEnv {
  static strPrefix = '#env.';

  private _globalQueryEnv: { [index: string]: string } = {};

  generateBaseGlobalEnvs(): ACBaseEnv {
    return {
      date: {
        now: new Date().toISOString(),
      },
    };
  }

  generateRequestGlobalEnvs(req: Request | null, appId: string, authUser: User | null): ACEnv {
    return {
      ...this.generateBaseGlobalEnvs(),
      // SPR checks activity without a request, so there's no address there
      ipAddress: req ? this.__requestIPAddress(req) : null,
      user: authUser,
      appId: appId,
    };
  }

  /**
   * Get the value of an environment variable.
   * @param key The key of the environment variable.
   * @param envVars The environment variables object - **Important:** This object will be modified to include the resolved environment variables.
   * @param resolving The #env values being read that led to this one, so one referring back to them is refused.
   * @returns The value of the environment variable or the key itself if not found.
   * @throws {CircularEnvError} when the value refers back to itself, or takes more than MAX_ENV_DEPTH values to read
   */
  async getEnvValue(key: unknown, envVars: ACPolicyEnvCombined | null, resolving: string[] = []): Promise<unknown> {
    if (!key || typeof key !== 'string' || !key.startsWith(PolicyEnv.strPrefix)) return key;

    // Reading it again would read the same values for ever: the stack overflowed, or through a lookup, memory ran out
    const chain = [...resolving, key];
    if (resolving.includes(key) || chain.length > MAX_ENV_DEPTH) throw new CircularEnvError(chain);

    const path = key.replace(PolicyEnv.strPrefix, '');
    const value = Helpers.get(path, envVars);

    if (typeof value === 'object' && value !== null && 'collection' in value) {
      // The value was found in envVars, so they aren't null
      return this.getQueryEnvironmentVar(key, envVars as ACPolicyEnvCombined, false, chain);
    }

    if (typeof value === 'string' && value.startsWith(PolicyEnv.strPrefix)) {
      return this.getEnvValue(value, envVars, chain);
    }

    // if (value?.constructor?.name === 'ObjectId') return value.toString();
    return value;
  }

  async getQueryEnvironmentVar(
    environmentKey: string,
    envVars: ACPolicyEnvCombined,
    conditionFlag = false,
    resolving: string[] = [],
  ): Promise<unknown> {
    if ((!environmentKey || !environmentKey.startsWith(PolicyEnv.strPrefix)) && !conditionFlag) return environmentKey;

    const path = environmentKey
      .replace(PolicyEnv.strPrefix, '')
      .split('.')
      .filter((v) => v);
    const queryValue = path.reduce<unknown>((obj, str) => (obj as DynamicRow | undefined)?.[str], envVars);

    // getEnvValue only calls this for a PolicyEnvQuery
    let root: string | null = null;
    if (typeof queryValue === 'string') {
      [root] = queryValue.split('.');
    } else if (typeof queryValue === 'object') {
      root = (queryValue as PolicyEnvQuery).collection;
    }

    if (root) {
      const isAppSchema = await this.__isAppSchema(root, envVars.appId);
      if (isAppSchema) {
        return this.__queryAppSchemaEnvValue(queryValue as PolicyEnvQuery, environmentKey, envVars, resolving);
      }
    }

    // A value that isn't a string is converted to one for the lookup
    const value = this._globalQueryEnv[queryValue as string];
    // An array lookup that can't be made finds nothing, as an array, which $in and $nin need
    if (value === undefined && (queryValue as PolicyEnvQuery | null)?.type === 'array') return [];

    return value;
  }

  async __isAppSchema(schema: string, appId: string | null) {
    if (!schema || !appId) return false;
    const model = await Model.getAppModel(appId, schema);
    return model ? true : false;
  }

  async __findAndReplaceValues(query: unknown, envVars: ACPolicyEnvCombined, resolving: string[] = []) {
    if (typeof query !== 'object' || query === null) {
      return;
    }

    const paths = this.__findPaths(query);
    for await (const path of paths) {
      const dbQuery = path.reduce<unknown>((current, key) => current && (current as DynamicRow)[key], query);
      const realValue = await this.getEnvValue(dbQuery, envVars, resolving);

      this.__setObjectValueByPath(query, path, realValue);
    }

    return query;
  }

  __setObjectValueByPath(obj: object, path: (string | number)[], value: unknown) {
    const lastKey = path.pop();
    const parent = path.reduce<DynamicRow>((current, key) => current[key] as DynamicRow, obj as DynamicRow);
    // A list's first item is at 0, so the key is checked for being there rather than for being truthy
    if (parent && lastKey !== undefined) {
      parent[lastKey] = value;
    }
  }

  __findPaths(data: unknown, currentPath: (string | number)[] = [], paths: (string | number)[][] = []) {
    if (typeof data === 'object' && data !== null) {
      if (Array.isArray(data)) {
        data.forEach((item: unknown, index: number) => {
          this.__findPaths(item, [...currentPath, index], paths);
        });
      } else {
        for (const key in data) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            this.__findPaths((data as DynamicRow)[key], [...currentPath, key], paths);
          }
        }
      }
    } else {
      // This is an "end value," so we store its full path.
      paths.push(currentPath);
    }
    return paths;
  }

  async __queryAppSchemaEnvValue(
    envObj: PolicyEnvQuery,
    envKey: string,
    envVars: ACPolicyEnvCombined,
    resolving: string[] = [],
  ) {
    const schema = envObj.collection;
    const query = Filter.convertQueryPrefixOperators(envObj.query);
    const output = envObj.output;
    const outputType = envObj.type;

    // Check the envVar to see if
    if (envVars[envKey]) return envVars[envKey];
    // The lookup's query is read with the env values that led to it, so one referring back to the lookup is refused
    await this.__findAndReplaceValues(query, envVars, resolving);

    // __isAppSchema has checked the appId
    const model = await Model.getAppModel(envVars.appId as string, schema);
    const res = await model.find(query);
    const result = await Helpers.streamAll<DynamicRow>(res);

    if (outputType === 'string' || outputType === 'id') {
      return result.reduce<unknown>((item, obj) => {
        item = obj[output.key];
        if (output.type === 'id') {
          // TODO: Shouldn't be directly accessing ObjectId, this should go through an adapter.
          item = toIdIfValid(item);
        }

        return item;
      }, '');
    }

    if (outputType === 'array' && result.length > 0) {
      return result.reduce<unknown[]>((arr, obj) => {
        const outputValue = obj[output.key];

        // Only valid ids, whether an entity holds one or an array of them
        if (output.type === 'id') {
          const values: unknown[] = Array.isArray(outputValue) ? outputValue : [outputValue];
          arr = arr.concat(values.map(toIdIfValid).filter(isId));
          return arr;
        }

        arr = arr.concat(outputValue);
        return arr;
      }, []);
    }
    if (outputType === 'boolean' && result.length > 0) {
      return result.every((obj) => Boolean(obj[output.key]));
    }

    const outputValue = result.length > 0 ? result[0][output.key] : outputType === 'array' ? [] : '';

    envVars[envKey] = outputValue;

    return outputValue;
  }

  /**
   * The requester's address, as Express works it out through the trust proxy setting (BUTTRESS_TRUST_PROXY), or null
   * once the client has gone. An IPv4 client of a server listening on IPv6 shows as ::ffff:<address>, so it's given
   * as the IPv4 address a policy would name.
   */
  __requestIPAddress(req: Request): string | null {
    const ip = req.ip;
    if (!ip) return null;
    return ip.replace(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i, '$1');
  }
}
export default new PolicyEnv();
