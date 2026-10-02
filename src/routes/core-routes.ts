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

import { Request, Response } from 'express';

import Route, { CoreModelClass } from './route.js';
import Model from '../model/index.js';
import * as Helpers from '../helpers/index.js';
import StandardModel from '../model/type/standard.js';
import { DocumentOf } from '../model/type/tenant-scoped.js';
import { Services } from '../bootstrap.js';
import { BjsQuery, QueryParams } from '../types/bjs-query.js';
import type { CountBody, RequestWithBody, SearchListBody } from '../types/routes.js';

/**
 * Which rows a core route reaches: the caller's app's, or every app's for a system token (`token`, as
 * `Route.scoped()` gives them), or the caller's app's whatever the token (`own-app`), for rows a system token
 * mustn't reach in other apps.
 */
export type CoreScope = 'token' | 'own-app';

// What a core route class says about itself, as its static `config`
export interface CoreRouteConfig {
  path: string;
  name: string;
  model: CoreModelClass<StandardModel<unknown>>;
  authType: string;
  permissions: string;
  scope?: CoreScope;
}

type CoreRouteClassWithConfig = { config: CoreRouteConfig };

type DocumentQuery<M> = BjsQuery<DocumentOf<M> & object>;

/**
 * A route over one core model's rows, which its class names in its static `config`. It reaches them through
 * `this.scoped()`, and parses each query against the model's schema, limited to the caller's app for an `own-app`
 * route.
 */
abstract class CoreModelRoute<M extends StandardModel<DocumentOf<M>>> extends Route {
  static config: CoreRouteConfig;

  constructor(services: Services) {
    const { config } = new.target as unknown as CoreRouteClassWithConfig;
    super(config.path, config.name, services, Model.getCoreModel(config.model).schemaData);
    this.authType = config.authType;
    this.permissions = config.permissions;
  }

  // Read off the class, so it's there however the route was made
  protected get config() {
    return (this.constructor as unknown as CoreRouteClassWithConfig).config;
  }

  protected get modelClass() {
    return this.config.model as CoreModelClass<M>;
  }

  protected get scope(): CoreScope {
    return this.config.scope ?? 'token';
  }

  protected parse(req: Request, parts: DocumentQuery<M>[]): DocumentQuery<M> {
    if (this.scope === 'own-app') {
      const appId = req.context.authApp?.id;
      if (!appId) {
        this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
        throw Helpers.Errors.internal('no_authenticated_app');
      }
      parts.push({ [this.modelClass.TenantKey]: appId } as DocumentQuery<M>);
    }

    const model = this.scoped(req, this.modelClass);
    return model.parseQuery({ $and: parts } as DocumentQuery<M>, {}, model.flatSchemaData) as DocumentQuery<M>;
  }
}

/**
 * Searches a core model's rows: `{query, skip, limit, sort, project}`, as an app's schema search takes.
 */
export class CoreSearch<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.SEARCH;
  }

  override async _validate(req: RequestWithBody<SearchListBody<DocumentOf<M> & object> | undefined>, _res: Response) {
    // The search options are read off the body, and an array has a sort method of its own
    if (Array.isArray(req.body)) throw Helpers.Errors.badRequest('invalid_body');

    const body = req.body ?? {};
    // parseInt takes numbers too, it converts them to a string first
    const skip = body.skip ? parseInt(body.skip as string) : 0;
    const limit = body.limit ? parseInt(body.limit as string) : 0;
    if (isNaN(skip)) throw Helpers.Errors.badRequest('invalid_value_skip');
    if (isNaN(limit)) throw Helpers.Errors.badRequest('invalid_value_limit');

    const result: QueryParams<DocumentOf<M> & object> = {
      query: this.parse(req, body.query ? [body.query] : []),
      skip,
      limit,
      sort: body.sort ? body.sort : {},
      project: body.project ? body.project : false,
    };
    return result;
  }

  override _exec(req: Request, _res: Response, validate: QueryParams<DocumentOf<M> & object>) {
    return this.scoped(req, this.modelClass).find(
      validate.query,
      {},
      validate.limit,
      validate.skip,
      validate.sort,
      validate.project,
    );
  }
}

/**
 * Counts a core model's rows: the body's `query`, or the body itself when it has none, apart from `actualCount`.
 */
export class CoreCount<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.SEARCH;

    this.activityDescription = this.config.name;
    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<CountBody<DocumentOf<M> & object> | undefined>, _res: Response) {
    const parts: DocumentQuery<M>[] = [];
    if (req.body && req.body.query) {
      parts.push(req.body.query);
    } else if (req.body) {
      // A body with no query is the query, apart from the count's own flag
      const { actualCount: _actualCount, ...bodyQuery } = req.body as Record<string, unknown>;
      parts.push(bodyQuery as DocumentQuery<M>);
    }

    const result: QueryParams<DocumentOf<M> & object> = { query: this.parse(req, parts) };
    return result;
  }

  override _exec(req: Request, _res: Response, validate: QueryParams<DocumentOf<M> & object>) {
    return this.scoped(req, this.modelClass).count(validate.query);
  }
}
