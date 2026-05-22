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

import * as ACM from '../../access-control/models-access.js';
import TokenSchemaModel, { Token } from '../../model/core/token.js';

import { QueryParams } from '../../types/bjs-query.js';
import UserSchemaModel from '../../model/core/user.js';
import AppSchemaModel from '../../model/core/app.js';

const routes: (typeof Route)[] = [];

/**
 * @class GetTokenList
 */
class GetTokenList extends Route {
  constructor(services) {
    super('token', 'LIST TOKEN', services, Model.getCoreModel(TokenSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.LIST;

    this.redactResults = false;
  }

  override _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No auth app in request context', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(500, `no_auth_app`));
    }

    const queryParams: QueryParams<Token> = {
      query: {
        _appId: Model.getCoreModel(AppSchemaModel).createId(req.context.authApp.id),
      },
      project: {
        id: 1,
        type: 1,
        policyProperties: 1,
      },
    };

    if (req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      queryParams.query = {};
      queryParams.project = {};
    }

    return Promise.resolve(queryParams);
  }

  override async _exec(req: Request, res: Response, validate) {
    return ACM.find(Model.getCoreModel(TokenSchemaModel), validate, req.context.ac);
  }
}
routes.push(GetTokenList);

/**
 * @class GetTokenList
 */
class SearchTokenList extends Route {
  constructor(services) {
    super('token', 'SEARCH TOKEN', services, Model.getCoreModel(TokenSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.redactResults = false;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No auth app in request context', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(500, `no_auth_app`));
    }

    const queryParams: QueryParams<Token> = {
      query: {
        $and: [{ _appId: Model.getCoreModel(AppSchemaModel).createId(req.context.authApp.id) }],
      },
      project: {
        id: 1,
        type: 1,
        policyProperties: 1,
      },
    };

    if (req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      queryParams.query = {};
      queryParams.project = {};
    }

    if (!queryParams.query.$and) {
      queryParams.query.$and = [];
    }

    if (req.body.query) {
      queryParams.query.$and.push(req.body.query);
    }

    return queryParams;
  }

  override _exec(req: Request, res: Response, validate) {
    return ACM.find(Model.getCoreModel(TokenSchemaModel), validate, req.context.ac);
  }
}
routes.push(SearchTokenList);

/**
 * @class DeleteAllTokens
 */
class DeleteAllTokens extends Route {
  constructor(services) {
    super('token{/:type}', 'DELETE ALL TOKENS', services, Model.getCoreModel(TokenSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.DELETE;

    this.redactResults = false;
  }

  override _validate(_req: Request, _res: Response) {
    return Promise.resolve();
  }

  override async _exec(req: Request, _res: Response, _validate) {
    if (!req.context.authApp) {
      this.log('ERROR: No auth app in request context', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(500, `no_auth_app`));
    }

    if (req.params.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      this.log('ERROR: Cannot delete system tokens', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_param_type`));
    }

    if (req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      const query = req.params.type
        ? {
            type: req.params.type,
          }
        : {
            type: {
              $ne: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
            },
          };
      await Model.getCoreModel(TokenSchemaModel).rmAll(query);
    } else {
      if (req.params.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.APP) {
        this.log('ERROR: Cannot delete app tokens as app', Route.LogLevel.ERR);
        return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_param_type`));
      }

      const query = req.params.type
        ? {
            type: req.params.type,
          }
        : {
            type: {
              $ne: Model.getCoreModel(TokenSchemaModel).Constants.Type.APP,
            },
          };

      await Model.getCoreModel(TokenSchemaModel).rmAll({
        ...query,
        _appId: Model.getCoreModel(AppSchemaModel).createId(req.context.authApp.id),
      });
    }

    return true;
  }
}
routes.push(DeleteAllTokens);

/**
 * @class SearchUserToken
 */
class SearchUserToken extends Route {
  constructor(services) {
    super('token/:userId', 'SEARCH USER TOKEN', services, Model.getCoreModel(TokenSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.SEARCH;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.SEARCH;

    this.redactResults = false;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No auth app in request context', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(500, `no_auth_app`));
    }

    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      this.log('ERROR: No user ID in request params', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `missing_param_userId`));
    }

    const queryParams: QueryParams<Token> = {
      query: {
        $and: [{ _appId: Model.getCoreModel(AppSchemaModel).createId(req.context.authApp.id) }],
      },
      project: {
        id: 1,
        type: 1,
        policyProperties: 1,
      },
    };

    if (req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
      queryParams.query = {};
      queryParams.project = {};
    }

    const exists = await Model.getCoreModel(UserSchemaModel).exists(userId);
    if (!exists) {
      this.log('ERROR: Invalid User ID', Route.LogLevel.ERR);
      return Promise.reject(new Helpers.Errors.RequestError(400, `invalid_param_id`));
    }

    if (!queryParams.query.$and) {
      queryParams.query.$and = [];
    }

    queryParams.query.$and.push({
      _userId: {
        $eq: Model.getCoreModel(UserSchemaModel).createId(userId),
      },
    });

    if (req.body?.query) {
      queryParams.query.$and.push(req.body.query);
    }

    return queryParams;
  }

  override _exec(req: Request, res: Response, validate) {
    return ACM.find(Model.getCoreModel(TokenSchemaModel), validate, req.context.ac);
  }
}
routes.push(SearchUserToken);

/**
 * @type {*[]}
 */
export default routes;
