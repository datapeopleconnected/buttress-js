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

import * as Helpers from '../helpers/index.js';
import { PolicyProjection } from '../model/core/policy.js';
import { BjsRequest } from '../types/bjs-express.js';

import { ApplicablePolicyConfig, PolicyError } from './index.js';

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

  async filterPoliciesByPolicyProjection(req: BjsRequest, applicablePolicies: ApplicablePolicyConfig[], schema) {
    const output: ApplicablePolicyConfig[] = [];

    for await (const policy of applicablePolicies) {
      if (policy.config.projection === null) {
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
    req: BjsRequest,
    projections: PolicyProjection | null,
    schema,
  ): Promise<{ [key: string]: number } | false> {
    const requestMethod = req.method;
    const flattenedSchema = Helpers.getFlattenedSchema(schema);
    let requestBody = req.body ?? {};

    const projectionKeys = projections?.keys;
    const projection = {};

    if (projectionKeys && projectionKeys.length > 0) {
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
