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
import { CoreDeleteAll, CoreGetList, CoreRouteConfig, CoreUpdateByPath } from '../core-routes.js';
import Model from '../../model/index.js';
import { invalidEntityError } from '../../model/shared.js';
import * as Helpers from '../../helpers/index.js';
import TrackingSchemaModel, { Tracking } from '../../model/core/tracking.js';
import ActivitySchemaModel from '../../model/core/activity.js';
import { Services } from '../../bootstrap.js';
import type { CoreRouteClass, RequestWithBody } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

// Every tracking route takes only system tokens, which reach every app's entries
const SYSTEM_ONLY = 'the route takes only system tokens';

/**
 * @class GetTrackingList
 */
class GetTrackingList extends CoreGetList<TrackingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'tracking',
    name: 'GET TRACKING LIST',
    model: TrackingSchemaModel,
    authType: Route.Constants.Type.SYSTEM,
    permissions: Route.Constants.Permissions.LIST,
  };
}
routes.push(GetTrackingList);

/**
 * @class AddTracking
 */
class AddTracking extends Route {
  constructor(services: Services) {
    super('tracking', 'ADD TRACKING', services, Model.getCoreModel(TrackingSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.ADD;

    this.activity = false;
    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = false;
  }

  override _validate(req: RequestWithBody<unknown>, _res: Response) {
    return new Promise<boolean>((resolve, reject) => {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        this.log('ERROR: Expected the tracking entry as an object', Route.LogLevel.ERR);
        return reject(Helpers.Errors.badRequest('invalid_body'));
      }

      const validation = Model.getCoreModel(TrackingSchemaModel).validate(req.body);
      if (!validation.isValid) {
        const err = invalidEntityError(this.schemaName, validation);
        this.log(`ERROR: ${err.message}`, Route.LogLevel.ERR);
        return reject(err);
      }

      resolve(true);
    });
  }

  override _exec(req: RequestWithBody<unknown>, _res: Response, _validate: boolean) {
    return this.unscopedModel(TrackingSchemaModel, SYSTEM_ONLY).add(req.body);
  }
}
routes.push(AddTracking);

class UpdateTracking extends CoreUpdateByPath<TrackingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'tracking/:id',
    name: 'UPDATE TRACKING',
    model: TrackingSchemaModel,
    authType: Route.Constants.Type.SYSTEM,
    permissions: Route.Constants.Permissions.WRITE,
  };

  constructor(services: Services) {
    super(services);
    this.activity = false;
  }
}
routes.push(UpdateTracking);

/**
 * @class DeleteTracking
 */
class DeleteTracking extends Route {
  constructor(services: Services) {
    super('tracking/:id', 'DELETE TRACKING', services, Model.getCoreModel(TrackingSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.DELETE;
  }

  override async _validate(req: Request<{ id: string }>, _res: Response) {
    const tracking = await this.scoped(req, TrackingSchemaModel).findByIdOrFail(req.params.id);

    return tracking;
  }

  override async _exec(req: Request, res: Response, tracking: Tracking) {
    await this.unscopedModel(TrackingSchemaModel, SYSTEM_ONLY).rm(tracking.id);
    return true;
  }
}
routes.push(DeleteTracking);

/**
 * @class DeleteAllTrackings
 */
class DeleteAllTrackings extends CoreDeleteAll<TrackingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'tracking',
    name: 'DELETE ALL TRACKINGS',
    model: TrackingSchemaModel,
    authType: Route.Constants.Type.SYSTEM,
    permissions: Route.Constants.Permissions.DELETE,
  };
}
routes.push(DeleteAllTrackings);

/**
 * @type {*[]}
 */
export default routes;
