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

import Route from '../route.js';
import Model from '../../model/index.js';
import * as Helpers from '../../helpers/index.js';
import ActivitySchemaModel, { Activity } from '../../model/core/activity.js';
import TokenSchemaModel from '../../model/core/token.js';
import { Services } from '../../bootstrap.js';
import type { CoreRouteClass } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

// Every activity route takes only system tokens, which reach every app's activity
const SYSTEM_ONLY = 'the route takes only system tokens';

/**
 * @class GetActivityList
 */
class GetActivityList extends Route {
  constructor(services: Services) {
    super('activity', 'GET ACTIVITY LIST', services, Model.getCoreModel(ActivitySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.LIST;
  }

  override _validate(_req: Request, _res: Response) {
    return Promise.resolve(true);
  }

  override _exec(req: Request, _res: Response, _validate: boolean) {
    if (req.context.token && req.context.token.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      return this.unscopedModel(ActivitySchemaModel, SYSTEM_ONLY).findAll();
    }

    const appId = req.context.authApp?.id;
    if (!appId) {
      this.log('ERROR: No App ID in token', Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    // Only a system token reaches this route today, but another would see its app's public activity
    return this.scoped(req, ActivitySchemaModel).find({
      visibility: Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PUBLIC,
    });
  }
}
routes.push(GetActivityList);

/**
 * @class GetActivity
 */
class GetActivity extends Route {
  constructor(services: Services) {
    super('activity/:id', 'GET ACTIVITY', services, Model.getCoreModel(ActivitySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request<{ id: string }>, _res: Response) {
    if (!req.params.id) {
      this.log('ERROR: Missing required field', Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('missing_required_fields');
    }

    const activity = await this.scoped(req, ActivitySchemaModel).findByIdOrFail(req.params.id);

    return activity;
  }

  override _exec(req: Request, res: Response, activity: Activity) {
    return Promise.resolve(activity.body);
  }
}
routes.push(GetActivity);

/**
 * @class DeleteAllActivity
 */
class DeleteAllActivity extends Route {
  constructor(services: Services) {
    super('activity', 'DELETE ALL ACTIVITY', services, Model.getCoreModel(ActivitySchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.DELETE;
  }

  override async _validate(_req: Request, _res: Response) {
    return true;
  }

  override _exec(_req: Request, _res: Response, _validate: boolean) {
    return this.unscopedModel(ActivitySchemaModel, SYSTEM_ONLY)
      .rmAll({})
      .then(() => true);
  }
}
routes.push(DeleteAllActivity);

// class AddActivityMetadata extends Route {
// 	constructor(services) {
// 		super('activity/:id/metadata/:key', 'ADD ACTIVITY METADATA', services, Model.getCoreModel(ActivitySchemaModel));
// 		this.verb = Route.Constants.Verbs.POST;
// 		this.permissions = Route.Constants.Permissions.ADD;
// 	}

// 	async _validate(req: Request, res: Response) {
// 		const activity = await this.model.findById(req.params.id);

// 		if (!activity) {
// 			this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
// 			throw Helpers.Errors.badRequest('invalid_id', 'The id is not valid');
// 		}

// 		try {
// 			JSON.parse(req.body.value);
// 		} catch (e) {
// 			if (e instanceof Error) {
// 				this.log(`ERROR: ${e.message}`, Route.LogLevel.ERR);
// 			}

// 			throw Helpers.Errors.badRequest('invalid_json');
// 		}

// 		return activity;
// 	}

// 	_exec(req: Request, res: Response, activity) {
// 		return this._activity.addOrUpdateMetadata(req.params.key, req.body.value);
// 	}
// }
// routes.push(AddActivityMetadata);

/**
 * @class UpdateActivityMetadata
 */
// class UpdateActivityMetadata extends Route {
// 	constructor(services) {
// 		super('activity/:id/metadata/:key', 'UPDATE ACTIVITY METADATA', services, Model.getCoreModel(ActivitySchemaModel));
// 		this.verb = Route.Constants.Verbs.PUT;
// 		this.permissions = Route.Constants.Permissions.ADD;

// 		this._activity = false;
// 	}

// 	_validate(req: Request, res: Response) {
// 		return new Promise((resolve, reject) => {
// 			this.model.findById(req.params.id).then((activity) => {
// 				if (!activity) {
// 					this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
// 					return reject(Helpers.Errors.badRequest('invalid_id', 'The id is not valid'));
// 				}
// 				if (activity.findMetadata(req.params.key) === false) {
// 					this.log('ERROR: Metadata does not exist', Route.LogLevel.ERR);
// 					return reject(Helpers.Errors.notFound(`metadata_not_found`));
// 				}
// 				try {
// 					JSON.parse(req.body.value);
// 				} catch (e) {
// 					this.log(`ERROR: ${e.message}`, Route.LogLevel.ERR);
// 					return reject(Helpers.Errors.internal('invalid_json'));
// 				}

// 				this._activity = activity;
// 				resolve(true);
// 			});
// 		});
// 	}

// 	_exec(req: Request, res: Response, validate) {
// 		return this._activity.addOrUpdateMetadata(req.params.key, req.body.value);
// 	}
// }
// routes.push(UpdateActivityMetadata);

/**
 * @class GetActivityMetadata
 */
// class GetActivityMetadata extends Route {
// 	constructor(services) {
// 		super('activity/:id/metadata/:key', 'GET ACTIVITY METADATA', services, Model.getCoreModel(ActivitySchemaModel));
// 		this.verb = Route.Constants.Verbs.GET;
// 		this.permissions = Route.Constants.Permissions.GET;

// 		this._metadata = false;
// 	}

// 	_validate(req: Request, res: Response) {
// 		return new Promise((resolve, reject) => {
// 			this.model.findById(req.params.id).then((activity) => {
// 				if (!activity) {
// 					this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
// 					return reject(Helpers.Errors.badRequest('invalid_id', 'The id is not valid'));
// 				}

// 				this._metadata = activity.findMetadata(req.params.key);
// 				if (this._metadata === false) {
// 					this.log('WARN: Activity Metadata Not Found', Route.LogLevel.ERR);
// 					return reject(Helpers.Errors.notFound(`metadata_not_found`));
// 				}

// 				resolve(true);
// 			});
// 		});
// 	}

// 	_exec(req: Request, res: Response, validate) {
// 		return this._metadata.value;
// 	}
// }
// routes.push(GetActivityMetadata);

/**
 * @class DeleteActivityMetadata
 */
// class DeleteActivityMetadata extends Route {
// 	constructor(services) {
// 		super('activity/:id/metadata/:key', 'DELETE ACTIVITY METADATA', services, Model.getCoreModel(ActivitySchemaModel));
// 		this.verb = Route.Constants.Verbs.DEL;
// 		this.permissions = Route.Constants.Permissions.DELETE;
// 		this._activity = false;
// 	}

// 	_validate(req: Request, res: Response) {
// 		return new Promise((resolve, reject) => {
// 			this.model
// 				.findById(req.params.id).select('id')
// 				.then((activity) => {
// 					if (!activity) {
// 						this.log('ERROR: Invalid Activity ID', Route.LogLevel.ERR);
// 						return reject(Helpers.Errors.badRequest('invalid_id', 'The id is not valid'));
// 					}
// 					this._activity = activity;
// 					resolve(true);
// 				}, (err) => reject(Helpers.Errors.badRequest(err.message)));
// 		});
// 	}

// 	_exec(req: Request, res: Response, validate) {
// 		return this._activity.rmMetadata(req.params.key);
// 	}
// }
// routes.push(DeleteActivityMetadata);

export default routes;
