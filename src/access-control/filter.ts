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

import Sugar from '../helpers/sugar.js';

import AccessControlHelpers from './helpers.js';

import Env, { ACPolicyEnvCombined, PolicyEnv } from './env.js';

import * as Helpers from '../helpers/index.js';
import Logging from '../helpers/logging.js';
import Model from '../model/index.js';

import { PolicyQuery } from '../model/core/policy.js';
import { asQueried, matchQuery } from './operators.js';
import { isObjectId } from '../datastore/adapters/object-id.js';
import type StandardModel from '../model/type/standard.js';

import type { RequestWithBody } from '../types/routes.js';

/**
 * @class Filter
 */
// A policy query referring to an #env value that isn't set, which can't be applied
export class UnresolvedEnvError extends Error {
  constructor(reference: string) {
    super(`unresolved_policy_env: ${reference}`);
    this.name = 'UnresolvedEnvError';
  }
}

// The value an #env reference in a policy query stands for. A reference to a value that isn't set is refused, rather
// than left undefined, which a datastore reads as matching every entity that lacks the field.
const resolveQueryValue = async (value: unknown, envVars: ACPolicyEnvCombined) => {
  const resolved = await Env.getEnvValue(value, envVars);
  if (resolved === undefined && typeof value === 'string' && value.startsWith(PolicyEnv.strPrefix)) {
    throw new UnresolvedEnvError(value);
  }
  return resolved;
};

// What reading a query against an entity takes of its model
export type QueryModel = Pick<StandardModel<unknown>, 'parseQuery' | 'flatSchemaData' | 'schemaData'>;

export class Filter {
  static queryOperators: { [index: string]: string } = {
    '@eq': '$eq',
    '@not': '$not',
    '@gt': '$gt',
    '@lt': '$lt',
    '@gte': '$gte',
    '@lte': '$lte',
    '@gtDate': '$gtDate',
    '@gteDate': '$gteDate',
    '@ltDate': '$ltDate',
    '@lteDate': '$lteDate',
    '@rex': '$rex',
    '@rexi': '$rexi',
    '@in': '$in',
    '@nin': '$nin',
    '@exists': '$exists',
    '@inProp': '$inProp',
    '@elMatch': '$elMatch',
  };
  static logicalOperator = ['@and', '@or', '$and', '$or'];
  arrayOperators: string[];
  manipulationVerbs: string[];

  _queryAccess = ['%FULL_ACCESS%', '%APP_SCHEMA%', '%CORE_SCHEMA%'];

  constructor() {
    this.arrayOperators = ['@in', '@nin', '$in', '$nin'];

    this.manipulationVerbs = [
      'PUT',
      // 'POST', // SKIPPING POST FOR NOW
      'DELETE',
    ];
  }

  /**
   * Walk over a query object and replace any env variables with their values.
   */
  async buildPolicyQuery(
    policyQuery: PolicyQuery | null | undefined,
    envVars: ACPolicyEnvCombined,
    stripAccessKeys = true,
  ) {
    if (!policyQuery) return null;

    // Change @ prefixes over to $ for mongo queries.
    // ? This should really be handled by the mongo adapter and internally we should use the @ prefix.
    const translatedQuery = Filter.convertQueryPrefixOperators(policyQuery);
    const output: PolicyQuery = {};
    const outputRecord = output as Record<string, unknown>;

    for await (const key of Object.keys(translatedQuery)) {
      const val = translatedQuery[key] as unknown;
      if (stripAccessKeys && key === 'access' && typeof val === 'string' && this._queryAccess.includes(val)) continue;

      if (typeof val === 'string') {
        outputRecord[key] = await resolveQueryValue(val, envVars);
        continue;
      }
      if (typeof val !== 'object' || val === null) {
        outputRecord[key] = val;
        continue;
      }
      if (Object.keys(val).length < 1) continue;

      if (Filter.logicalOperator.includes(key)) {
        if (!Array.isArray(val)) continue;
        for (const queryObj of val as unknown[]) {
          if (typeof queryObj !== 'object' || Array.isArray(queryObj)) {
            throw new Error(`Invalid query object for logical operator ${key}: ${JSON.stringify(queryObj)}`);
          }

          // Recursively build the query for each object in the logical operator array.
          const builtQuery = await this.buildPolicyQuery(queryObj as PolicyQuery | null, envVars, stripAccessKeys);
          if (builtQuery) {
            const existing = outputRecord[key];
            if (!Array.isArray(existing)) outputRecord[key] = [];
            (outputRecord[key] as unknown[]).push(builtQuery);
          }
        }
        continue;
      }

      if (outputRecord[key]) {
        if (Array.isArray(outputRecord[key]) && Array.isArray(val)) {
          for await (const elem of val as unknown[]) {
            const elementExist = (outputRecord[key] as unknown[]).findIndex(
              (el) => JSON.stringify(el) === JSON.stringify(elem),
            );

            if (elementExist !== -1) continue;
            (outputRecord[key] as unknown[]).push(elem);
          }

          continue;
        } else if (!Array.isArray(outputRecord[key]) && !Array.isArray(val)) {
          const outputByKey = outputRecord[key] as Record<string, unknown>;
          const valRecord = val as Record<string, unknown>;

          Object.keys(outputByKey).forEach((k) => {
            if (this.arrayOperators.includes(k)) {
              const existing = outputByKey[k];
              const next = valRecord[k];
              if (Array.isArray(existing) && Array.isArray(next)) {
                outputByKey[k] = existing.concat(next).filter((v: unknown, idx, arr) => arr.indexOf(v) === idx);
              }
            } else {
              outputByKey[k] = valRecord[k];
            }
          });

          continue;
        }
      }

      if (typeof val === 'string') {
        outputRecord[key] = await resolveQueryValue(val, envVars);
        continue;
      }

      const operator = Object.keys(val)[0];
      const value = (val as Record<string, unknown>)[operator];

      // if (!Filter.queryOperators[operator]) continue;

      outputRecord[key] = {};
      (outputRecord[key] as Record<string, unknown>)[operator] = await resolveQueryValue(value, envVars);
    }

    return output;
  }

  /**
   * Whether a policy's built query reads an entity, as a REST query would: parsed against the entity's model as REST
   * parses it, and matched as MongoDB matches it (D-31). A query whose values can't be read reads nothing.
   * @param {object} query - a policy query, as buildPolicyQuery gives it
   * @param {object} entity - the entity, as stored or as its JSON
   * @param {object} model - the entity's model, whose schema reads the query
   * @return {boolean}
   */
  evaluateQueryAgainstEntity(query: PolicyQuery, entity: Record<string, unknown>, model: QueryModel): boolean {
    const queryRecord = Filter.convertQueryPrefixOperators(query) as Record<string, unknown>;
    // The access keys are what a policy grants, not a field
    const fields = Object.fromEntries(
      Object.entries(queryRecord).filter(
        ([key, value]) => !(key === 'access' && this._queryAccess.includes(value as string)),
      ),
    );
    if (queryRecord.access === '%FULL_ACCESS%' && Object.keys(fields).length < 1) return true;

    let parsed: Record<string, unknown>;
    try {
      parsed = model.parseQuery(fields, {}, model.flatSchemaData) as Record<string, unknown>;
    } catch (err: unknown) {
      Logging.logWarn(
        `A policy query couldn't be read against ${model.schemaData?.name}: ${Helpers.getThrownErrorMessage(err)}`,
      );
      return false;
    }
    return matchQuery(parsed, asQueried(entity, model.flatSchemaData));
  }

  // TODO needs to be removed and added to the adapters - TEMPORARY HACK!!
  // TODO: This function needs a refactor, expecting the AC to be already applied to the queiries.
  async evaluateManipulationActions(req: RequestWithBody<{ query?: Record<string, unknown> }>, collection: string) {
    const coreSchema = await AccessControlHelpers.cacheCoreSchema();
    const coreSchemNames = coreSchema.map((c) => Sugar.String.singularize(c.name));
    const isCoreSchema = coreSchemNames.includes(collection);

    const verb = req.method;
    if (!this.manipulationVerbs.includes(verb)) return true;

    if (!req.context.authApp) {
      throw new Error('No auth app found in request context');
    }

    const appId = req.context.authApp.id;
    // const appShortId = Helpers.shortId(appId);
    const body: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    let query: Record<string, unknown> = req.body.query ? req.body.query : {};
    // const baseURL = req.url.replace(/\?.*/, '');
    // const id = (baseURL) ? baseURL.split('/').pop() : undefined;
    let passed = true;

    const model = isCoreSchema ? Model.getCoreModelByName(collection) : await Model.getAppModel(appId, collection);

    // ! This looks weird
    for await (const _update of body) {
      if (query._id && typeof query._id !== 'object') {
        query._id = await model.createId(query._id as string);
      }

      const parsedQuery = await model.parseQuery(query, {}, model.flatSchemaData);
      query = { ...query, ...parsedQuery };
      const res = await model.count(query);
      if (!res) {
        passed = false;
        delete query._id;
        return passed;
      }
    }

    delete req.body.query; // Deleting it for manipulation verbs
    return passed;
  }

  mergeQueryFilters(
    baseFilter: PolicyQuery | null | undefined,
    additionalFilter: PolicyQuery | null | undefined,
    operator = '$and',
  ): PolicyQuery {
    if (!baseFilter || !additionalFilter) {
      throw new Error('Both baseFilter and additionalFilter must be provided.');
    }
    if (operator !== '$and' && operator !== '$or') {
      throw new Error("Operator must be either '$and' or '$or'.");
    }

    if (operator === '$or') {
      if (Object.keys(baseFilter).length < 1 || Object.keys(additionalFilter).length < 1) {
        return {};
      }
    } else {
      if (Object.keys(baseFilter).length < 1) return additionalFilter;
      if (Object.keys(additionalFilter).length < 1) return baseFilter;
    }

    const newQuery: Record<string, unknown[]> = { [operator]: [] };

    // A filter of only the operator is spread into the new one. A filter with other keys too is kept whole, so they
    // still apply.
    if (baseFilter[operator] && Object.keys(baseFilter).length === 1) {
      newQuery[operator] = [...(baseFilter[operator] as unknown[])];
    } else {
      newQuery[operator].push(baseFilter);
    }

    if (additionalFilter[operator] && Object.keys(additionalFilter).length === 1) {
      newQuery[operator] = [...newQuery[operator], ...(additionalFilter[operator] as unknown[])];
    } else {
      newQuery[operator].push(additionalFilter);
    }

    return newQuery;
  }

  // A function for merging a request query with an access control query. The Access control query will take priority.
  mergeQueryFiltersWithAccessControl(
    reqQuery: PolicyQuery | null | undefined,
    accessControlQuery: PolicyQuery | null | undefined,
  ) {
    return this.mergeQueryFilters(reqQuery, accessControlQuery, '$and');
  }

  /**
   * Queries are prefixed with @ to avoid conflicts with mongo operators. This function will convert the @ to $.
   *
   * @todo This functionality should really happen in the mongo adpater. All queries within buttress should be
   * referenced using the @ prefix.
   */
  static convertQueryPrefixOperators(query: Record<string, unknown>): Record<string, unknown>;
  static convertQueryPrefixOperators(query: unknown): unknown;
  static convertQueryPrefixOperators(query: unknown): unknown {
    if (typeof query !== 'object' || query === null) {
      return query;
    }

    // Values, not queries
    if (isObjectId(query) || query instanceof Date) {
      return query;
    }

    if (Array.isArray(query)) {
      return query.map((item: unknown) => Filter.convertQueryPrefixOperators(item));
    }

    return Object.keys(query).reduce((acc: Record<string, unknown>, key) => {
      const newKey = key.replace(/@/g, '$');
      acc[newKey] = Filter.convertQueryPrefixOperators((query as Record<string, unknown>)[key]);
      return acc;
    }, {});
  }
}
export default new Filter();
