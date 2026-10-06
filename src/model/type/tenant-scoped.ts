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

import * as Helpers from '../../helpers/index.js';
import Sugar from '../../helpers/sugar.js';

import StandardModel from './standard.js';
import { AdapterQuery, UpdatePathBody } from '../../types/datastore.js';
import { FlattenedSchema } from '../../types/schema.js';

// The property of a core collection's rows that names the app they belong to. An app is its own row in `apps`.
export type TenantKey = '_appId' | 'id';

const invalidId = () => Helpers.Errors.badRequest('invalid_id', 'The id is not valid');

export type DocumentOf<M> = M extends StandardModel<infer TDocument> ? TDocument : never;

/**
 * A core model limited to one app's rows. Every query is ANDed with the app's clause as it goes to the model, after
 * the route has built and parsed it, so route code can't leave it out; a write by id is refused for a row outside the
 * app before anything is written. With no tenant (a system token) it passes everything through.
 */
export default class TenantScopedModel<M extends StandardModel<DocumentOf<M>>> {
  private readonly _model: M;

  // The app whose rows it reaches, or null for every app's
  readonly tenant: string | null;

  readonly tenantKey: TenantKey;

  constructor(model: M, tenant: string | null, tenantKey: TenantKey = '_appId') {
    this._model = model;
    this.tenant = tenant;
    this.tenantKey = tenantKey;
  }

  get schemaData() {
    return this._model.schemaData;
  }

  get flatSchemaData() {
    return this._model.flatSchemaData;
  }

  isValidId(id: unknown) {
    return this._model.isValidId(id);
  }

  // The clause that limits a query to the tenant's rows, empty for a system token
  get clause(): AdapterQuery {
    return this.tenant === null ? {} : { [this.tenantKey]: this.tenant };
  }

  /**
   * @param {object} query - the final query, after parseQuery and any policy merge
   * @return {object} the query limited to the tenant's rows
   */
  scope(query: AdapterQuery = {}): AdapterQuery {
    if (this.tenant === null) return query;
    if (Object.keys(query).length === 0) return this.clause;
    return { $and: [query, this.clause] };
  }

  parseQuery(
    query: Record<string, unknown>,
    envFlat?: Record<string, unknown>,
    schemaFlat?: FlattenedSchema,
    checkPaths?: boolean,
  ) {
    return this._model.parseQuery(query, envFlat, schemaFlat, checkPaths);
  }

  createId(id?: string) {
    return this._model.createId(id);
  }

  validateUpdate(body: unknown) {
    return this._model.validateUpdate(body);
  }

  find(
    query: AdapterQuery,
    excludes?: AdapterQuery | null,
    limit?: number,
    skip?: number,
    sort?: Record<string, unknown> | null,
    project?: Record<string, unknown> | null | false,
  ) {
    return this._model.find(this.scope(query), excludes, limit, skip, sort, project);
  }

  findAll() {
    return this.tenant === null ? this._model.findAll() : this.find({});
  }

  findByIds(ids: string[]) {
    return this.tenant === null ? this._model.findByIds(ids) : this.find({ id: { $in: ids } });
  }

  findOne(query: AdapterQuery, excludes?: AdapterQuery) {
    return this._model.findOne(this.scope(query), excludes);
  }

  /**
   * @param {string} id
   * @return {Promise} the row, or null when it isn't the tenant's
   */
  findById(id: string): Promise<DocumentOf<M> | null> {
    if (this.tenant === null) return this._model.findById(id);
    return this._model.findOne({ id, ...this._besideId });
  }

  /**
   * @param {string} id
   * @return {Promise} the row, refusing an id that can't be one with 400 invalid_id, and one that names no row of the
   * tenant's, another app's included, with 404 not_found
   */
  async findByIdOrFail(id: string): Promise<DocumentOf<M>> {
    if (!this._model.isValidId(id)) throw invalidId();
    const row = await this.findById(id);
    if (!row) throw this._notFound(id);
    return row;
  }

  /**
   * Refuses an id that can't be one with 400 invalid_id, and one that names no row of the tenant's with 404 not_found.
   * @param {string} id
   */
  async assertExists(id: string) {
    if (!this._model.isValidId(id)) throw invalidId();
    if (!(await this.exists(id))) throw this._notFound(id);
  }

  /**
   * As assertExists for each id, in one query: the first id that can't be one is 400 invalid_id, and the first that
   * names no row of the tenant's 404 not_found.
   * @param {string[]} ids
   */
  async assertAllExist(ids: string[]) {
    if (ids.some((id) => !this._model.isValidId(id))) throw invalidId();

    const found = await Helpers.streamAll<{ id: unknown }>(
      await this.find({ id: { $in: ids } }, {}, 0, 0, null, { id: 1 }),
    );
    const foundIds = new Set(found.map((row) => String(row.id)));
    const missing = ids.find((id) => !foundIds.has(String(id)));
    if (missing !== undefined) throw this._notFound(missing);
  }

  count(query?: AdapterQuery) {
    return this._model.count(this.scope(query));
  }

  async exists(id: string): Promise<boolean> {
    return Boolean(await this._model.exists(id, null, this._besideId));
  }

  async updateByPath(body: UpdatePathBody | UpdatePathBody[], id: string) {
    await this._assertTenants(id);
    return this._model.updateByPath(body, id);
  }

  /**
   * @param {string|object} target - the row's id, or the row, as the apps model takes
   * @return {Promise}
   */
  async rm(target: string | { id: string }) {
    await this._assertTenants(typeof target === 'string' ? target : String(target.id));
    return this._model.rm(target);
  }

  /**
   * Removes those of the rows that are the tenant's, through the model's own rmBulk
   * @param {string[]} ids
   * @return {Promise}
   */
  async rmBulk(ids: string[]) {
    if (this.tenant === null) return this._model.rmBulk(ids);

    const owned = await Helpers.streamAll<{ id: unknown }>(await this.find({ id: { $in: ids } }));
    const ownedIds = new Set(owned.map((row) => String(row.id)));
    return this._model.rmBulk(ids.filter((id) => ownedIds.has(String(id))));
  }

  /**
   * Adds rows for the tenant. Its app goes into the model's internals, the fields only the server sets, over any app
   * the caller names; a system token names the app itself.
   * @param {object} body
   * @param {object} internals - the model's own add internals, e.g. an execution's `_tokenId`
   * @return {Promise}
   */
  async add(
    body: Parameters<M['add']>[0],
    internals: Partial<Parameters<M['add']>[1]> = {},
  ): Promise<Awaited<ReturnType<M['add']>>> {
    if (this.tenantKey === 'id') throw new Error('Adding an app goes through the apps model, not a scoped one');

    const given = internals as { _appId?: string };
    const appId = this.tenant ?? given._appId;
    if (!appId) throw new Error(`Adding to ${this._model.schemaData.name} needs the app it's for`);
    return (await this._model.add(body, { ...given, _appId: appId })) as Awaited<ReturnType<M['add']>>;
  }

  /**
   * The whole model, once the row is the tenant's, for the model's own methods that act on a row by id
   * (setDeployment, activate, updatePolicyProperties...). Another app's row is refused.
   * @param {string} id
   * @return {Promise<StandardModel>}
   */
  async owned(id: string): Promise<M> {
    await this._assertTenants(id);
    return this._model;
  }

  rmAll(query?: AdapterQuery) {
    return this._model.rmAll(this.scope(query));
  }

  // The clause, to go beside a condition on the id in one query object. The apps model's names `id` too, which would
  // replace the id asked for with the tenant's own, so it goes under $and there
  private get _besideId(): AdapterQuery {
    return this.tenantKey === 'id' && this.tenant !== null ? { $and: [this.clause] } : this.clause;
  }

  private async _assertTenants(id: string) {
    if (this.tenant === null) return;
    if (!this._model.isValidId(id)) throw invalidId();
    if (!(await this.exists(id))) throw this._notFound(id);
  }

  private _notFound(id: string) {
    return Helpers.Errors.entityNotFound(Sugar.String.singularize(this._model.schemaData.name), id);
  }
}
