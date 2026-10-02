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
import { invalidUpdateError } from '../model/shared.js';
import ActivitySchemaModel from '../model/core/activity.js';
import { Services } from '../bootstrap.js';
import { BjsQuery, QueryParams } from '../types/bjs-query.js';
import { UpdatePathBody } from '../types/datastore.js';
import type { BulkUpdateItem, CountBody, RequestWithBody, SearchListBody } from '../types/routes.js';

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
  // The route param that names the row, for a route by id: `id` unless it says
  idParam?: string;
  // Whether a write's activity is broadcast, as it is unless it says
  activityBroadcast?: boolean;
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

  // The model, limited to the rows the route reaches for the caller
  protected rows(req: Request) {
    return this.config.scope === 'own-app'
      ? this.ownAppScoped(req, this.modelClass)
      : this.scoped(req, this.modelClass);
  }

  protected parse(req: Request, parts: DocumentQuery<M>[]): DocumentQuery<M> {
    const model = this.rows(req);
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
    return this.rows(req).find(validate.query, {}, validate.limit, validate.skip, validate.sort, validate.project);
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
    return this.rows(req).count(validate.query);
  }
}

// A row's updates, as a route has checked them
type CheckedUpdates = { id: string; body: UpdatePathBody[] };

/**
 * Writes updates by path to a core model's rows. Each row's updates are read through the schema, then a resource's
 * own rules (`updateProblem`), and the row has to be one the caller reaches, before any is written; `afterUpdates`
 * then has what was written.
 */
abstract class CoreUpdates<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = this.config.activityBroadcast ?? true;
  }

  // A resource's own rules for updates its schema takes: the error to refuse them with, or null
  protected updateProblem(_req: Request, _updates: UpdatePathBody[]): Promise<Error | null> | Error | null {
    return null;
  }

  // What a resource does once its rows are updated
  protected async afterUpdates(_req: Request, _updated: CheckedUpdates[]): Promise<void> {}

  protected async checkUpdates(req: Request, id: string, given: unknown): Promise<UpdatePathBody[]> {
    const model = this.rows(req);
    const { validation, body } = model.validateUpdate(given);
    if (!validation.isValid) {
      const err = invalidUpdateError(this.schemaName, validation);
      this.log(`ERROR: ${err.message}`, Route.LogLevel.ERR);
      throw err;
    }

    const problem = await this.updateProblem(req, body);
    if (problem) throw problem;

    await model.assertExists(id);
    return body;
  }
}

/**
 * Updates one core row by path: `PUT <path>/:id` with an update or a list of them.
 */
export class CoreUpdateByPath<M extends StandardModel<DocumentOf<M>>> extends CoreUpdates<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.PUT;
  }

  override async _validate(req: RequestWithBody<unknown>, _res: Response) {
    const param = req.params[this.config.idParam ?? 'id'];
    const id = Array.isArray(param) ? param[0] : param;
    // The updates as they're checked
    req.body = await this.checkUpdates(req, id, req.body);
    return { id };
  }

  override async _exec(req: RequestWithBody<UpdatePathBody[]>, _res: Response, validate: { id: string }) {
    const updated = await this.rows(req).updateByPath(req.body, validate.id);
    await this.afterUpdates(req, [{ id: validate.id, body: req.body }]);
    return updated;
  }
}

/**
 * Updates core rows by path: `POST <path>/bulk/update` with `[{id, body}]`, every item checked before any is written.
 */
export class CoreBulkUpdate<M extends StandardModel<DocumentOf<M>>> extends CoreUpdates<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.POST;
  }

  override async _validate(req: RequestWithBody<BulkUpdateItem[]>, _res: Response) {
    if (!Array.isArray(req.body) || req.body.some((item) => !item || typeof item !== 'object')) {
      this.log(`[${this.name}] Expected an array of {id, body} updates`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('array_required');
    }

    // Each item's updates as they're checked, which the request's activity keeps too
    for (const item of req.body) item.body = await this.checkUpdates(req, item.id, item.body);
    return req.body as CheckedUpdates[];
  }

  override async _exec(req: Request, _res: Response, validate: CheckedUpdates[]) {
    const model = this.rows(req);
    for (const item of validate) await model.updateByPath(item.body, item.id);
    await this.afterUpdates(req, validate);
    return true;
  }
}
