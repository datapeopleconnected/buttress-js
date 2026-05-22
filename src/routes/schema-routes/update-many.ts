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
import AppSchemaModel, { App } from '../../model/core/app.js';
import Model from '../../model/index.js';
import { ContractUpdateTransaction } from '@hashgraph/sdk';

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

  async _validate(req: Request, _res: Response) {
    const model = await this.routeModel();

    if (!Array.isArray(req.body)) {
      this.log(`${this.schemaName}: Expected body to be an array of updates`, Route.LogLevel.ERR, req.context.id);
      throw new Helpers.Errors.RequestError(400, `${this.schemaName}: Expected body to be an array of updates`);
    }

    // Reduce down duplicate entity updates into one object
    const data = req.body.reduce((reducedUpdates, update) => {
      const existing = reducedUpdates.find((u) => u.id === update.id);

      if (!existing) {
        reducedUpdates.push(update);
      } else {
        if (!Array.isArray(existing.body)) existing.body = [existing.body];
        if (!Array.isArray(update.body)) update.body = [update.body];
        existing.body = [...existing.body, ...update.body];
      }

      return reducedUpdates;
    }, []);

    for await (const update of data) {
      const { validation, body } = model.validateUpdate(update.body);
      update.body = body;

      if (!validation.isValid) {
        if (validation.isPathValid === false) {
          this.log(
            `${this.schemaName}: Update path is invalid: ${validation.invalidPath}`,
            Route.LogLevel.ERR,
            req.context.id,
          );
          update.validation = {
            code: 400,
            message: `${this.schemaName}: Update path is invalid: ${validation.invalidPath}`,
          };
          continue;
        }
        if (validation.isValueValid === false) {
          this.log(
            `${this.schemaName}: Update value is invalid: ${validation.invalidValue}`,
            Route.LogLevel.ERR,
            req.context.id,
          );
          if (validation.isMissingRequired) {
            update.validation = {
              code: 400,
              message: `${this.schemaName}: Missing required property updating ${body.path}: ${validation.missingRequired}`,
            };
            continue;
          }
        }

        // ? I've moved outside isValidValue to be the default fallback if isValid is false.
        update.validation = {
          code: 400,
          message: `${this.schemaName}: Update value is invalid for path ${body.path}: ${validation.invalidValue}`,
        };
        continue;
      }

      const exists = await model.exists(update.id, body.sourceId);

      if (!exists) {
        this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.context.id);
        update.validation = {
          code: 400,
          message: `${this.schemaName}: Missing required property updating ${body.path}: ${validation.missingRequired}`,
        };
        continue;
      }

      update.validation = true;
    }

    return data;
  }

  async _exec(_req: Request, _res: Response, _data: unknown) {
    const model = await this.routeModel();

    const output: {
      id: string;
      sourceId: string;
      results: any;
    }[] = [];

    for await (const body of _data as any[]) {
      const result = await model.updateByPath(body.body, body.id, body.sourceId);
      output.push({ id: body.id, sourceId: body.sourceId, results: result });
    }

    return output;
  }
}
