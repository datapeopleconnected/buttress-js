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
import { isPlainObject } from '../helpers/schema-definition.js';
import ActivitySchemaModel from '../model/core/activity.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';
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
  // Whether a list takes `?ids=a,b` to list only those rows
  takesIds?: boolean;
  // What a policy-property route does to the token's policy properties
  policyProperties?: PolicyPropertiesChange;
}

/**
 * A change to a token's policy properties: `set` replaces them, `update` merges the body into them, `remove` takes
 * away each the body gives with the same value, and `clear` empties them.
 */
export type PolicyPropertiesChange = 'set' | 'update' | 'remove' | 'clear';

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

  // The id the route's param gives
  protected idOf(req: Request) {
    const param = req.params[this.config.idParam ?? 'id'];
    return Array.isArray(param) ? param[0] : param;
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
    this.verb = Route.Constants.Verbs.QUERY;
  }

  override async _validate(req: RequestWithBody<SearchListBody<DocumentOf<M> & object> | undefined>, _res: Response) {
    // The search options are read off the body, and an array has a sort method of its own
    if (Array.isArray(req.body)) throw Helpers.Errors.badRequest('invalid_body');

    const body = req.body ?? {};
    const { skip, limit } = Helpers.searchPaging(body);

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
    this.verb = Route.Constants.Verbs.QUERY;

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

// Each row's updates, from every item that names it, in the order they're written
const updatesByRow = (items: CheckedUpdates[]) => {
  const rows = new Map<string, UpdatePathBody[]>();
  for (const item of items) rows.set(item.id, [...(rows.get(item.id) ?? []), ...item.body]);
  return rows;
};

/**
 * Writes updates by path to a core model's rows. Each row's updates are read through the schema, then a resource's
 * own rules (`updateProblem`), and the rows have to be ones the caller reaches, before any is written; `afterUpdates`
 * then has what was written.
 */
abstract class CoreUpdates<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = this.config.activityBroadcast ?? true;
  }

  // A resource's own rules for updates its schema takes, every one a request makes to the row `id` in the order they're
  // written: the error to refuse them with, or null
  protected updateProblem(
    _req: Request,
    _updates: UpdatePathBody[],
    _id: string,
  ): Promise<Error | null> | Error | null {
    return null;
  }

  // What a resource does once its rows are updated
  protected async afterUpdates(_req: Request, _updated: CheckedUpdates[]): Promise<void> {}

  // A row's updates as the schema reads them, refused if it can't take them
  protected readUpdateBody(req: Request, given: unknown): UpdatePathBody[] {
    const { validation, body } = this.rows(req).validateUpdate(given);
    if (!validation.isValid) {
      const err = invalidUpdateError(this.schemaName, validation);
      this.log(`ERROR: ${err.message}`, Route.LogLevel.ERR);
      throw err;
    }
    return body;
  }

  // Refuses a request's updates to a row, in the order they're written, that the route's rules can't take
  protected async checkUpdateRules(req: Request, id: string, updates: UpdatePathBody[]) {
    const problem = await this.updateProblem(req, updates, id);
    if (problem) throw problem;
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
    const id = this.idOf(req);
    const updates = this.readUpdateBody(req, req.body);
    // The updates as they're checked
    req.body = updates;
    await this.checkUpdateRules(req, id, updates);
    await this.rows(req).assertExists(id);
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

    // Each item's updates as they're checked, which the request's activity keeps too; then each row's, from every item
    // that names it, as they're written one after another; then every row, in one query
    for (const item of req.body) item.body = this.readUpdateBody(req, item.body);
    const checked = req.body as CheckedUpdates[];
    for (const [id, updates] of updatesByRow(checked)) await this.checkUpdateRules(req, id, updates);
    await this.rows(req).assertAllExist(checked.map((item) => item.id));
    return checked;
  }

  override async _exec(req: Request, _res: Response, validate: CheckedUpdates[]) {
    const model = this.rows(req);
    for (const item of validate) await model.updateByPath(item.body, item.id);
    await this.afterUpdates(req, validate);
    return true;
  }
}

/**
 * Gives one core row: `GET <path>/:id`, 404 `not_found` for an id naming no row the caller reaches.
 */
export class CoreGetOne<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.GET;
  }

  // What's given for the row, the row itself unless a route says
  protected present(row: DocumentOf<M>): unknown {
    return row;
  }

  override _validate(req: Request, _res: Response) {
    return this.rows(req).findByIdOrFail(this.idOf(req));
  }

  override _exec(_req: Request, _res: Response, row: DocumentOf<M>) {
    return this.present(row);
  }
}

/**
 * Lists the core rows the caller reaches: `GET <path>`, and `?ids=a,b` for only those, where the route takes them.
 */
export class CoreGetList<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.GET;
  }

  override _validate(req: Request, _res: Response) {
    if (!this.config.takesIds) return [];

    const given = req.query.ids;
    const ids = (Array.isArray(given) ? given : typeof given === 'string' ? given.split(',') : [])
      .map((id) => String(id))
      .filter(Boolean);
    const model = this.rows(req);
    if (ids.some((id) => !model.isValidId(id))) {
      this.log(`[${this.name}] Invalid id in ${ids.join(',')}`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('invalid_id', 'The id is not valid');
    }
    return ids;
  }

  override _exec(req: Request, _res: Response, ids: string[]) {
    const model = this.rows(req);
    return ids.length > 0 ? model.findByIds(ids) : model.findAll();
  }
}

/**
 * Removes every core row the caller reaches: `DELETE <path>`.
 */
export class CoreDeleteAll<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.DEL;
  }

  override _validate(_req: Request, _res: Response) {
    return true;
  }

  override async _exec(req: Request, _res: Response, _validate: boolean) {
    await this.rows(req).rmAll({});
    return true;
  }
}

/**
 * Changes the policy properties of a core row's token: `PUT <path>`, with the properties. The row (a lambda, a user)
 * has to be one the caller reaches, and its token is the route's to find; properties that are set or merged in have
 * to be ones the app lists. `afterChange` then has the row and its token.
 */
export abstract class CoreTokenPolicyProperties<M extends StandardModel<DocumentOf<M>>> extends CoreModelRoute<M> {
  constructor(services: Services) {
    super(services);
    this.verb = Route.Constants.Verbs.PUT;
    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  // The row's token, or the error to refuse the request with
  protected abstract findToken(req: Request, id: string): Promise<Token>;

  protected async afterChange(_req: Request, _id: string, _token: Token): Promise<void> {}

  private get change(): PolicyPropertiesChange {
    const change = this.config.policyProperties;
    if (!change) throw new Error(`[${this.name}] says no policyProperties change`);
    return change;
  }

  override async _validate(req: RequestWithBody<Record<string, unknown> | undefined>, _res: Response) {
    if (!req.body) {
      this.log('ERROR: No data has been posted', Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_field');
    }

    // Properties are named values, which a list isn't
    if (this.change !== 'clear' && !isPlainObject(req.body)) {
      this.log(`[${this.name}] The policy properties are not an object`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('invalid_body', 'The policy properties must be an object');
    }

    const id = this.idOf(req);
    await this.rows(req).assertExists(id);
    const token = await this.findToken(req, id);

    if (this.change === 'set' || this.change === 'update') {
      const policyCheck = await Helpers.checkAppPolicyProperty(req.context.authApp?.policyPropertiesList, req.body);
      if (!policyCheck.passed) {
        this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
        throw Helpers.Errors.badRequest('invalid_field');
      }
    }

    return token;
  }

  override async _exec(req: RequestWithBody<Record<string, unknown>>, _res: Response, token: Token) {
    const tokenId = String(token.id);
    const tokens = await this.scoped(req, TokenSchemaModel).owned(tokenId);
    switch (this.change) {
      case 'set':
        await tokens.setPolicyPropertiesById(tokenId, req.body);
        break;
      case 'update':
        await tokens.updatePolicyProperties(token, req.body);
        break;
      case 'remove': {
        // A token with none has none to take away
        const properties = token.policyProperties ?? {};
        for (const [key, value] of Object.entries(req.body)) {
          if (properties[key] && properties[key] === value) delete properties[key];
        }
        await tokens.updatePolicyProperties({ ...token, policyProperties: properties }, properties);
        break;
      }
      case 'clear':
        await tokens.clearPolicyPropertiesById(tokenId);
        break;
    }

    await this.afterChange(req, this.idOf(req), token);
    return true;
  }
}
