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
import { Response, Request } from 'express';
import { QueryParams } from '../../types/bjs-query.js';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';
import StandardModel from '../../model/type/standard.js';
import { describeInvalidUpdate } from '../../model/shared.js';

/**
 * @class UpdateMany
 */
export default class UpdateMany extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}/bulk/update`, `BULK UPDATE ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.POST;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityDescription = `BULK UPDATE ${schema.name}`;
    this.activityBroadcast = true;
  }

  override async _validate(req: Request, _res: Response) {
    const model = await this.routeModel();

    if (!Array.isArray(req.body)) {
      this.log(`${this.schemaName}: Expected body to be an array of updates`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Expected body to be an array of updates`);
    }

    // Each item is validated and applied on its own, so a refused item doesn't stop the others, even ones that update
    // the same entity. Each entity is only checked once.
    const updatable = new Map<string, boolean>();
    for await (const update of req.body) {
      const { validation, body } = model.validateUpdate(update.body);
      update.body = body;

      if (!validation.isValid) {
        update.validation = { code: 400, message: `${this.schemaName}: ${describeInvalidUpdate(validation)}` };
        this.log(update.validation.message, Route.LogLevel.ERR, req.context.id);
        continue;
      }

      const key = `${update.sourceId}/${update.id}`;
      if (!updatable.has(key)) updatable.set(key, await this.__isUpdatable(req, model, update.id, update.sourceId));
      if (!updatable.get(key)) {
        update.validation = { code: 400, message: `${this.schemaName}: Invalid ID: ${update.id}` };
        this.log(update.validation.message, Route.LogLevel.ERR, req.context.id);
        continue;
      }

      update.validation = true;
    }

    return req.body;
  }

  // Whether the entity exists and is inside the caller's access-control scope.
  async __isUpdatable(req: Request, model: StandardModel, id: string, sourceId?: string) {
    let objectId;
    try {
      objectId = model.createId(id);
    } catch (_err) {
      return false;
    }

    if (!(await model.exists(id, sourceId))) return false;

    const findParams: QueryParams<{ id: unknown }> = { query: { id: objectId }, limit: 1, skip: 0 };
    const rxsScoped = await ACM.find(model, findParams, req.context.ac);
    try {
      return Boolean(await Helpers.streamFirst(rxsScoped));
    } catch (_err) {
      return false;
    }
  }

  override async _exec(_req: Request, _res: Response, _data: unknown) {
    const model = await this.routeModel();

    const output: {
      id: string;
      sourceId: string;
      results: unknown;
      validation?: unknown;
    }[] = [];

    type UpdateManyBody = { id: string; sourceId: string; body: unknown; validation?: unknown };

    for await (const body of _data as UpdateManyBody[]) {
      // Items that failed validation (bad path/value, missing id, or outside the caller's
      // access-control scope) must not be applied, only reported back.
      if (body.validation !== true) {
        output.push({ id: body.id, sourceId: body.sourceId, results: null, validation: body.validation });
        continue;
      }

      const result = await model.updateByPath(body.body, body.id, body.sourceId);
      output.push({ id: body.id, sourceId: body.sourceId, results: result });
    }

    return output;
  }

  // Refused items are reported in the response but changed nothing, so they aren't broadcast.
  override async _broadcast(req: Request, res: Response, result: unknown, path: string, isSuper = false) {
    const applied = (result as { results: unknown }[]).filter((item) => item.results !== null);
    if (applied.length < 1) return;

    return super._broadcast(req, res, applied, path, isSuper);
  }
}
