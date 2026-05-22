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

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

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

  async _validate(req: Request, _res: Response) {
    const model = await this.routeModel();

    const { validation, body } = model.validateUpdate(req.body);
    req.body = body;
    if (!validation.isValid) {
      if (validation.isPathValid === false) {
        this.log(
          `${this.schemaName}: Update path is invalid: ${validation.invalidPath}`,
          Route.LogLevel.ERR,
          req.context.id,
        );
        throw new Helpers.Errors.RequestError(
          400,
          `${this.schemaName}: Update path is invalid: ${validation.invalidPath}`,
        );
      }
      if (validation.isValueValid === false) {
        this.log(
          `${this.schemaName}: Update value is invalid: ${validation.invalidValue}`,
          Route.LogLevel.ERR,
          req.context.id,
        );
        if (validation.isMissingRequired) {
          throw new Helpers.Errors.RequestError(
            400,
            `${this.schemaName}: Missing required property updating ${req.body.path}: ${validation.missingRequired}`,
          );
        }

        throw new Helpers.Errors.RequestError(
          400,
          `${this.schemaName}: Update value is invalid for path ${req.body.path}: ${validation.invalidValue}`,
        );
      }
    }

    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`${this.schemaName}: Invalid ID`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid ID`);
    }

    const sourceId = Array.isArray(req.params.sourceId) ? req.params.sourceId[0] : req.params.sourceId;
    if (!sourceId) {
      this.log(`${this.schemaName}: Invalid source ID`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Invalid source ID`);
    }

    const exists = await model.exists(id, sourceId);
    if (!exists) {
      this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    return {
      id,
      sourceId,
    };
  }

  async _exec(req: Request, _res: Response, validate: { id: string; sourceId: string }) {
    return (await this.routeModel()).updateByPath(req.body, validate.id, validate.sourceId);
  }
}
