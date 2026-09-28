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
import { Response } from 'express';
import { QueryParams } from '../../types/bjs-query.js';
import { AdapterDocument, UpdatePathBody } from '../../types/datastore.js';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

import * as ACM from '../../access-control/models-access.js';
import { describeInvalidUpdate } from '../../model/shared.js';
import type { RequestWithBody } from '../../types/routes.js';

/**
 * @class UpdateOne
 */
export default class UpdateOne extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(
      [`${schemaRoutePath}/:id`, `${schemaRoutePath}/:sourceId/:id`],
      `UPDATE ${schema.name}`,
      services,
      schema,
      app,
    );
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.PUT;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activityDescription = `UPDATE ${schema.name}`;
    this.activityBroadcast = true;
  }

  override async _validate(req: RequestWithBody<unknown>, _res: Response) {
    const model = await this.routeModel();

    const { validation, body } = model.validateUpdate(req.body);
    req.body = body;
    // BUG: req.body is now the validated array, so the messages below always report the path as undefined
    if (!validation.isValid) {
      const message = `${this.schemaName}: ${describeInvalidUpdate(validation)}`;
      this.log(message, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, message);
    }

    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`${this.schemaName}: Invalid ID`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid ID`);
    }

    let sourceId: string | undefined;
    if (req.params.sourceId) {
      sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;

      if (!sourceId) {
        this.log(`${this.schemaName}: Invalid source ID`, Route.LogLevel.ERR, req.context.id);
        throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid source ID`);
      }
    }

    const exists = await model.exists(id, sourceId);
    if (!exists) {
      this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    let objectId: string;
    try {
      objectId = model.createId(id);
    } catch (_err) {
      this.log(`${this.schemaName}: Invalid ID: ${id}`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    const findParams: QueryParams<{ id: unknown }> = { query: { id: objectId }, limit: 1, skip: 0 };
    const rxsScoped = await ACM.find(model, findParams, req.context.ac);
    let scopedEntity: AdapterDocument | null;
    try {
      scopedEntity = await Helpers.streamFirst<AdapterDocument>(rxsScoped);
    } catch (_err) {
      scopedEntity = null;
    }
    if (!scopedEntity) {
      this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    return {
      id,
      sourceId,
    };
  }

  override async _exec(
    req: RequestWithBody<unknown>,
    _res: Response,
    validate: { id: string; sourceId: string | undefined },
  ) {
    // _validate replaced the body with the validated updates
    return (await this.routeModel()).updateByPath(req.body as UpdatePathBody[], validate.id, validate.sourceId);
  }
}
