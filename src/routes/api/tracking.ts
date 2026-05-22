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
import Model from '../../model/index.js';
import * as Helpers from '../../helpers/index.js';
import TrackingSchemaModel from '../../model/core/tracking.js';
import ActivitySchemaModel from '../../model/core/activity.js';

const routes: (typeof Route)[] = [];

/**
 * @class GetTrackingList
 */
class GetTrackingList extends Route {
  constructor(services) {
    super('tracking', 'GET TRACKING LIST', services, Model.getCoreModel(TrackingSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  override _validate(_req: Request, _res: Response) {
    return Promise.resolve(true);
  }

  override _exec(_req: Request, _res: Response, _validate: any) {
    return Model.getCoreModel(TrackingSchemaModel).findAll();
  }
}
routes.push(GetTrackingList);

/**
 * @class AddTracking
 */
class AddTracking extends Route {
  constructor(services) {
    super('tracking', 'ADD TRACKING', services, Model.getCoreModel(TrackingSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.ADD;

    this.activity = false;
    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = false;
  }

  override _validate(req: Request, _res: Response) {
    return new Promise((resolve, reject) => {
      const validation = Model.getCoreModel(TrackingSchemaModel).validate(req.body);
      if (!validation.isValid) {
        if (validation.missing.length > 0) {
          this.log(`ERROR: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR);
          return reject(new Helpers.Errors.RequestError(400, `TRACKING: Missing field: ${validation.missing[0]}`));
        }
        if (validation.invalid.length > 0) {
          this.log(`ERROR: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR);
          return reject(new Helpers.Errors.RequestError(400, `TRACKING: Invalid value: ${validation.invalid[0]}`));
        }

        this.log(`ERROR: TRACKING: Unhandled Error`, Route.LogLevel.ERR);
        return reject(new Helpers.Errors.RequestError(400, `unknown_error`));
      }

      resolve(true);
    });
  }

  override _exec(req: Request, _res: Response, _validate) {
    return Model.getCoreModel(TrackingSchemaModel).add(req.body);
  }
}
routes.push(AddTracking);

class UpdateTracking extends Route {
  constructor(services) {
    super('tracking/:id', 'UPDATE TRACKING', services, Model.getCoreModel(TrackingSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.activity = false;
    this.activityVisibility = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
    this.activityBroadcast = true;
  }

  override _validate(req: Request, _res: Response) {
    return new Promise((resolve, reject) => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!id) {
        this.log('ERROR: Missing required Tracking ID', Route.LogLevel.ERR);
        return reject(new Helpers.Errors.RequestError(400, `missing_required_tracking_id`));
      }

      const { validation, body } = Model.getCoreModel(TrackingSchemaModel).validateUpdate(req.body);
      req.body = body;
      if (!validation.isValid) {
        if (validation.isPathValid === false) {
          this.log(`ERROR: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR);
          return reject(
            new Helpers.Errors.RequestError(400, `TRACKING: Update path is invalid: ${validation.invalidPath}`),
          );
        }
        if (validation.isValueValid === false) {
          this.log(`ERROR: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR);
          return reject(
            new Helpers.Errors.RequestError(400, `TRACKING: Update value is invalid: ${validation.invalidValue}`),
          );
        }
      }

      Model.getCoreModel(TrackingSchemaModel)
        .exists(id)
        .then((exists) => {
          if (!exists) {
            this.log('ERROR: Invalid Tracking ID', Route.LogLevel.ERR);
            return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
          }
          resolve({
            id,
          });
        });
    });
  }

  override _exec(req: Request, _res: Response, validate: { id: string }) {
    return Model.getCoreModel(TrackingSchemaModel).updateByPath(req.body, validate.id);
  }
}
routes.push(UpdateTracking);

/**
 * @class DeleteTracking
 */
class DeleteTracking extends Route {
  constructor(services) {
    super('tracking/:id', 'DELETE TRACKING', services, Model.getCoreModel(TrackingSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.DELETE;
  }

  override async _validate(req: Request, _res: Response) {
    const tracking = await Model.getCoreModel(TrackingSchemaModel).findById(req.params.id);
    if (!tracking) {
      this.log('ERROR: Invalid Tracking ID', Route.LogLevel.ERR);
      throw new Helpers.Errors.RequestError(400, `invalid_id`);
    }

    return tracking;
  }

  override async _exec(req: Request, res: Response, tracking) {
    await Model.getCoreModel(TrackingSchemaModel).rm(tracking.id);
    return true;
  }
}
routes.push(DeleteTracking);

/**
 * @class DeleteAllTrackings
 */
class DeleteAllTrackings extends Route {
  constructor(services) {
    super('tracking', 'DELETE ALL TRACKINGS', services, Model.getCoreModel(TrackingSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.DELETE;
  }

  override async _validate(_req: Request, _res: Response) {
    return true;
  }

  override async _exec(_req: Request, _res: Response, _validate) {
    await Model.getCoreModel(TrackingSchemaModel).rmAll({});
    return true;
  }
}
routes.push(DeleteAllTrackings);

/**
 * @type {*[]}
 */
export default routes;
