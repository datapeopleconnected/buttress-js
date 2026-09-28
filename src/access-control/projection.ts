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

import { Request } from 'express';

import * as Helpers from '../helpers/index.js';
import { PolicyProjection } from '../model/core/policy.js';

import { ApplicablePolicyConfig, PolicyError } from './index.js';

type Projectable = Record<string, unknown>;

const isProjectable = (value: unknown): value is Projectable => typeof value === 'object' && value !== null;

// Copies what one dotted projection key names from `source` into `target`, as a Mongo projection such as
// {'address.street': 1} would, including into each element of an array.
function projectPath(source: unknown, target: Projectable, [head, ...rest]: string[]) {
  if (!isProjectable(source) || !(head in source)) return;

  const value = source[head];
  if (rest.length === 0) {
    target[head] = value;
  } else if (Array.isArray(value)) {
    const projected = Array.isArray(target[head]) ? (target[head] as unknown[]) : [];
    target[head] = value.map((item, idx) => {
      const element = isProjectable(projected[idx]) ? (projected[idx] as Projectable) : {};
      projectPath(item, element, rest);
      return element;
    });
  } else if (isProjectable(value)) {
    if (!isProjectable(target[head])) target[head] = {};
    projectPath(value, target[head] as Projectable, rest);
  }
}

const projectValue = (value: unknown, keys: string[]): unknown => {
  if (Array.isArray(value)) return value.map((item) => projectValue(item, keys));
  if (!isProjectable(value)) return value;

  const projected: Projectable = {};
  keys.forEach((key) => projectPath(value, projected, key.split('.')));
  return projected;
};

/**
 * @class Projection
 */
class Projection {
  private logicalOperator: string[];
  private _ignoredQueryKeys: string[];

  constructor() {
    this.logicalOperator = ['$and', '$or'];

    this._ignoredQueryKeys = ['__crPath', 'project', 'id'];
  }

  async filterPoliciesByPolicyProjection(req: Request, applicablePolicies: ApplicablePolicyConfig[], schema) {
    const output: ApplicablePolicyConfig[] = [];

    for await (const policy of applicablePolicies) {
      if (!policy.config.projection) {
        output.push(policy);
      } else {
        const result = await this.__applyPolicyProjection(req, policy.config.projection, schema);
        if (result !== false) {
          policy.config.projection = result;
          output.push(policy);
        }
      }
    }

    return output;
  }

  async __applyPolicyProjection(
    req: Request,
    projections: PolicyProjection | null,
    schema,
  ): Promise<{ [key: string]: number } | false> {
    const requestMethod = req.method;
    const flattenedSchema = Helpers.getFlattenedSchema(schema);
    let requestBody = req.body ?? {};

    const projectionKeys = Array.isArray(projections?.keys)
      ? projections.keys.filter((key): key is string => typeof key === 'string')
      : [];
    const projection = {};

    if (projectionKeys.length > 0) {
      projectionKeys.forEach((key) => {
        projection[key] = 1;
      });
    }

    if (requestMethod === 'POST') {
      const updatePaths = Object.keys(requestBody).map((key) => key);

      if (projectionKeys.length > 0) {
        const removedPaths = updatePaths
          .filter((key) => projectionKeys.every((updateKey) => updateKey !== key))
          .filter((path) => flattenedSchema[path]);

        removedPaths.forEach((i) => {
          // ? There maybe a required field here but the user does not have access to it.
          const config = flattenedSchema[i];
          requestBody[i] = Helpers.Schema.getPropDefault(config);
        });
      }
    } else if (requestMethod === 'PUT') {
      if (!Array.isArray(requestBody) && typeof requestBody === 'object') {
        requestBody = [requestBody];
      }

      // Check to see if the any of the update paths don't exists within the projection keys,
      // if they don't then we want to throw as the user doesn't have access.
      const invalidPaths = requestBody
        .map((elem) => elem.path)
        .filter((updateKey) => projectionKeys.find((key) => new RegExp(`^${key}`).test(updateKey)) === undefined);

      if (invalidPaths.length > 0) {
        throw new PolicyError(
          401,
          `Can not access/edit properties (${invalidPaths.join(', ')}) of ${schema.name} without privileged access`,
        );
      }
    } else {
      if (projectionKeys.length > 0 && !this.__checkProjectionPath(requestBody, projectionKeys)) {
        return false;
      }
    }

    return projection;
  }

  // The properties a policy config's projection lets through. None means it doesn't restrict properties.
  getProjectionKeys(projection: PolicyProjection | null | undefined): string[] {
    return Array.isArray(projection?.keys)
      ? projection.keys.filter((key): key is string => typeof key === 'string')
      : [];
  }

  /**
   * Trims a realtime activity's response to what a token may read through the projection keys, as REST does for reads.
   * An entity keeps its id and sourceId and the projected properties. Update results keep the projected paths, and an
   * update of a parent object keeps only its projected properties. Returns null when none of an update can be seen.
   */
  projectActivityResponse(verb: string, response: unknown, keys: string[]): unknown {
    if (verb === 'put' && Array.isArray(response)) {
      const results = response.flatMap((result) => this.__projectUpdateResult(result, keys));
      return results.length > 0 ? results : null;
    }

    if (Array.isArray(response)) return response.map((entity) => this.__projectEntity(entity, keys));
    return this.__projectEntity(response, keys);
  }

  __projectEntity(entity: unknown, keys: string[]) {
    if (!isProjectable(entity)) return entity;

    const projected = projectValue(entity, keys) as Projectable;
    ['id', 'sourceId'].forEach((key) => {
      if (key in entity) projected[key] = entity[key];
    });
    return projected;
  }

  __projectUpdateResult(result: unknown, keys: string[]): unknown[] {
    if (!isProjectable(result) || typeof result.path !== 'string') return [];

    // Array indexes and the increment suffix aren't part of the property's name.
    const path = result.path.replace(/\.__increment__$/, '').replace(/\.\d+(?=\.|$)/g, '');
    if (keys.some((key) => path === key || path.startsWith(`${key}.`))) return [result];

    const childKeys = keys.filter((key) => key.startsWith(`${path}.`)).map((key) => key.slice(path.length + 1));
    if (childKeys.length < 1) return [];

    // A removal from the array carries no values to hide.
    if (result.type === 'vector-rm') return [result];
    return [{ ...result, value: projectValue(result.value, childKeys) }];
  }

  __checkProjectionPath(requestBody, projectionKeys) {
    const query = requestBody.query ? requestBody.query : requestBody;
    const paths = Object.keys(query).filter((key) => key && !this._ignoredQueryKeys.includes(key));
    let queryKeys: string[] = [];

    paths.forEach((path) => {
      if (this.logicalOperator.includes(path)) {
        query[path].forEach((p) => {
          queryKeys = queryKeys.concat(Object.keys(p));
        });
        return;
      }

      if (typeof path === 'object' && !Array.isArray(path)) {
        queryKeys = queryKeys.concat(Object.keys(path));
      } else {
        queryKeys = queryKeys.concat(path);
      }
    });

    return queryKeys.every(
      (key) => projectionKeys.includes(key) || projectionKeys.some((k) => key.startsWith(k) && key[k.length] === '.'),
    );
  }
}
export default new Projection();
