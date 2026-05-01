/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';

import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';

/**
 * @class GetMany
 */
export default class GetMany extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}/bulk/load`, `BULK GET ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();
    this.verb = Route.Constants.Verbs.SEARCH;
    this.permissions = Route.Constants.Permissions.READ;

    this.activityDescription = `BULK GET ${schema.name}`;
    this.activityBroadcast = false;
  }

  _validate(req, res, token) {
    return new Promise((resolve, reject) => {
      const _ids = req.body.query.ids;
      const project = req.body && req.body.project ? req.body.project : false;

      if (!_ids) {
        this.log(`ERROR: No ${this.schemaName} IDs provided`, Route.LogLevel.ERR, req.id);
        return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
      }
      if (!_ids.length) {
        this.log(`ERROR: No ${this.schemaName} IDs provided`, Route.LogLevel.ERR, req.id);
        return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
      }

      resolve({ ids: _ids, project: project });
    });
  }

  async _exec(req, res, query) {
    const model = await this.routeModel();
    return model.find({ id: { $in: query.ids.map((id) => model.createId(id)) } }, {}, 0, 0, null, query.project);
  }
}
