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
import { invalidUpdateError } from '../../model/shared.js';
import type { RequestWithBody } from '../../types/routes.js';
import { pickWriteTarget } from './write-target.js';

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
      const err = invalidUpdateError(this.schemaName, validation);
      this.log(err.message, Route.LogLevel.ERR, req.context.id);
      throw err;
    }

    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`${this.schemaName}: Invalid ID`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('missing_id', 'An id is required');
    }

    let sourceId: string | undefined;
    if (req.params.sourceId) {
      sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;

      if (!sourceId) {
        this.log(`${this.schemaName}: Invalid source ID`, Route.LogLevel.ERR, req.context.id);
        throw Helpers.Errors.badRequest('invalid_source_id', 'The source id is not valid');
      }
    }

    if (!model.isValidId(id)) {
      this.log(`${this.schemaName}: Invalid ID: ${id}`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('invalid_id', 'The id is not valid');
    }

    // The record is found within the caller's policies, in whichever source has it, and the write goes back there
    const findParams: QueryParams<{ id: unknown }> = { query: { id: model.createId(id) }, skip: 0 };
    const found = await Helpers.streamAll<AdapterDocument>(await ACM.find(model, findParams, req.context.ac));
    const target = pickWriteTarget(model, found, {
      appId: this._dataApp(req).id ?? '',
      schemaName: this.schemaName ?? 'entity',
      id,
      sourceId,
    });
    // One outside the caller's policies is answered as one that doesn't exist
    if (!target || !(await model.exists(id, target.via))) {
      this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.entityNotFound(this.schemaName ?? 'entity', id);
    }

    // So the SPR finds the changed record where it was changed
    if (target.via) req.context.dataShareId = target.via;

    return { id, via: target.via };
  }

  override async _exec(req: RequestWithBody<unknown>, _res: Response, validate: { id: string; via: string | null }) {
    // _validate replaced the body with the validated updates
    return (await this.routeModel()).updateByPath(req.body as UpdatePathBody[], validate.id, validate.via);
  }
}
