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
import {
  CoreCount,
  CoreDeleteAll,
  CoreGetList,
  CoreRouteConfig,
  CoreSearch,
  CoreTokenPolicyProperties,
  CoreUpdateByPath,
} from '../core-routes.js';
import Model from '../../model/index.js';
import { invalidEntityError, validateSchemaObject } from '../../model/shared.js';
import Logging from '../../helpers/logging.js';
import * as Helpers from '../../helpers/index.js';
import TokenSchemaModel, { PolicyProperties, Token } from '../../model/core/token.js';
import UserSchemaModel, { User, UserAddBody, UserAuth } from '../../model/core/user.js';
import { Services } from '../../bootstrap.js';
import type { CoreRouteClass, RequestWithBody } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

// The user's token the request names, or the user's only one, wasn't found
const userTokenNotFound = () =>
  Helpers.Errors.notFound('not_found', "The user's token was not found", { schema: 'token' });

function getTokenQueryfromParams(req: Request, userId: string) {
  const id = Array.isArray(req.params.tokenId) ? req.params.tokenId[0] : req.params.tokenId;
  if (!id) {
    return null;
  }

  let tokenId: string | null = null;
  try {
    tokenId = Model.getCoreModel(TokenSchemaModel).createId(id);
  } catch (err: unknown) {
    Logging.logSilly(Helpers.getThrownErrorMessage(err));
  }

  // If tokenId is not set, we will treat it as the token value.
  const tokenValue = tokenId === null ? id : null;

  if (!tokenId && !tokenValue) {
    return null;
  }

  const tokenQuery: {
    _id?: string;
    _userId: string;
    value?: string;
  } = {
    _userId: userId,
  };
  if (tokenId) tokenQuery._id = tokenId;
  if (tokenValue) tokenQuery.value = tokenValue;

  return tokenQuery;
}

/**
 * @class GetUserList
 */
class GetUserList extends CoreGetList<UserSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'user',
    name: 'GET USER LIST',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.LIST,
  };
}
routes.push(GetUserList);

interface GetUserOutput {
  id: string;
  auth: UserAuth[];
  tokens: { id: string; value: string; policyProperties: PolicyProperties }[] | null;
}

/**
 * @class GetUser
 */
class GetUser extends Route {
  constructor(services: Services) {
    super('user/:id', 'GET USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    let id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_field');
    }

    if (id === 'me') {
      if (!req.context.token) {
        this.log(`[${this.name}] Missing token`, Route.LogLevel.ERR);
        throw Helpers.Errors.unauthorised('missing_token', 'A token is required');
      }
      id = req.context.token._userId;
    }

    let user: User | null = null;
    let userTokens: Token[] = [];
    user = await this.scoped(req, UserSchemaModel).findByIdOrFail(id);
    const userId = user.id;

    if (userTokens.length < 1 && user) {
      userTokens = await Helpers.streamAll(
        await this.unscopedModel(
          TokenSchemaModel,
          'findUserAuthTokens is limited to the app it is given',
        ).findUserAuthTokens(user.id, req.context.authApp.id),
      );
    }
    if (userTokens.length < 1) {
      this.log(`[${this.name}] User does not have a token yet ${userId}`, Route.LogLevel.ERR);
    }

    const output: GetUserOutput = {
      id: user.id,
      auth: user.auth,
      tokens:
        userTokens.length > 0
          ? userTokens.map((t) => {
              return {
                id: t.id,
                value: t.value,
                policyProperties: t.policyProperties,
              };
            })
          : null,
    };

    return output;
  }

  override _exec(req: Request, res: Response, user: GetUserOutput) {
    return user;
  }
}
routes.push(GetUser);

interface FindUserOutput {
  id: string;
  auth: UserAuth[];
  tokens: { value: string; policyProperties: PolicyProperties }[];
}

/**
 * @class FindUser
 */
class FindUser extends Route {
  constructor(services: Services) {
    super('user/:app/:id', 'FIND USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    const authApp = Array.isArray(req.params.app) ? req.params.app[0] : req.params.app;
    const validAuthApps = ['twitter', 'facebook', 'google', 'linkedin', 'microsoft'];
    // No user is found by another auth app. Clients look a user up, and add them when it isn't found.
    if (!validAuthApps.includes(authApp) && !authApp.startsWith('app-')) {
      return Promise.reject(
        Helpers.Errors.notFound('not_found', 'No user has that auth app id', { schema: 'user', app: authApp }),
      );
    }

    // The id param's a string, only wildcard route params are arrays
    const _user = await this.unscopedModel(
      UserSchemaModel,
      'getByAuthAppId is limited to the app it is given',
    ).getByAuthAppId(authApp, req.params.id as string, req.context.authApp.id);
    if (!_user) {
      this.log(`[${this.name}] Could not fetch user`, Route.LogLevel.ERR);
      return Promise.reject(
        Helpers.Errors.notFound('not_found', 'No user has that auth app id', { schema: 'user', app: authApp }),
      );
    }

    const output: FindUserOutput = {
      id: _user.id,
      auth: _user.auth,
      tokens: [],
    };

    const userTokens = await Helpers.streamAll<Token>(
      await this.unscopedModel(
        TokenSchemaModel,
        'findUserAuthTokens is limited to the app it is given',
      ).findUserAuthTokens(_user.id, req.context.authApp.id),
    );
    output.tokens =
      userTokens.length > 0
        ? userTokens.map((t) => {
            return {
              value: t.value,
              policyProperties: t.policyProperties,
            };
          })
        : [];

    return Promise.resolve(output);
  }

  override _exec(req: Request, res: Response, validate: FindUserOutput) {
    return Promise.resolve(validate);
  }
}
routes.push(FindUser);

interface GetUserByTokenOutput {
  id: string;
  auth: UserAuth[];
  token: string;
  policyProperties: PolicyProperties;
}

/**
 * @class GetUserByToken
 */
class GetUserByToken extends Route {
  constructor(services: Services) {
    super('user/get-by-token', 'GET USER BY TOKEN', services, Model.getCoreModel(UserSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: RequestWithBody<{ token?: string }>, _res: Response): Promise<GetUserByTokenOutput> {
    const token = req.body?.token;
    if (!token) {
      this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_field');
    }

    // A token of another app is answered as an unknown one, unless the caller is a system token
    const userToken = await this.scoped(req, TokenSchemaModel).findOne({
      value: {
        $eq: token,
      },
    });
    // Another app's token is answered as one nobody has
    if (!userToken) {
      this.log('ERROR: Invalid User Token', Route.LogLevel.ERR);
      throw Helpers.Errors.notFound('not_found', 'No user has that token', { schema: 'token' });
    }

    const user = await this.scoped(req, UserSchemaModel).findById(userToken._userId);
    if (!user) {
      this.log('ERROR: Can not find a user with the provided token', Route.LogLevel.ERR);
      throw Helpers.Errors.notFound('not_found', 'No user has that token', { schema: 'user' });
    }

    return {
      id: user.id,
      auth: user.auth,
      token: userToken.value,
      policyProperties: userToken.policyProperties || null,
    };
  }

  override _exec(req: Request, res: Response, user: GetUserByTokenOutput) {
    return user;
  }
}
routes.push(GetUserByToken);

/**
 * @class CreateUserAuthToken
 */
class CreateUserAuthToken extends Route {
  constructor(services: Services) {
    super('user/:id/token', 'CREATE USER AUTH TOKEN', services, Model.getCoreModel(UserSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.WRITE;

    this.redactResults = false;
  }

  override async _validate(req: RequestWithBody<Partial<Token> | undefined, { id: string }>, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    if (!req.body || !req.body.policyProperties || !req.body.domains) {
      this.log(`[${this.name}] Missing required field (policyProperties or domains)`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    if (!Helpers.isDomainList(req.body.domains)) {
      this.log(`[${this.name}] domains must be a list of domain names`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_domains'));
    }

    if (!req.params.id) {
      this.log(`[${this.name}] Missing required field (id)`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    const user = await this.scoped(req, UserSchemaModel).findByIdOrFail(req.params.id);

    const policyCheck = await Helpers.checkAppPolicyProperty(
      req.context.authApp.policyPropertiesList,
      req.body.policyProperties,
    );
    if (!policyCheck.passed) {
      this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_policy_property'));
    }

    // Only the domains and policy properties come from the caller; the rest is set here, as a user's
    // token made with the user is
    const token: Partial<Token> = {
      type: Model.getCoreModel(TokenSchemaModel).Constants.Type.USER,
      permissions: [{ route: '*', permission: '*' }],
      domains: req.body.domains,
      policyProperties: req.body.policyProperties,
    };

    return Promise.resolve({
      appId: req.context.authApp.id,
      user,
      token,
    });
  }

  override async _exec(req: Request, res: Response, validate: { appId: string; user: User; token: Partial<Token> }) {
    const rxsToken = await this.scoped(req, TokenSchemaModel).add(validate.token, {
      _appId: validate.appId,
      _userId: validate.user.id,
    });
    const token = await Helpers.streamFirst<Token>(rxsToken);

    // We'll make sure to add the user to the app
    // if+ (user._appId !== req.context.authApp.id.toString()) {
    // 	await Model.getCoreModel(UserSchemaModel).updateApps(user, req.context.authApp.id);
    // }

    this._notify('app-routes:bust-cache', '{}');

    return {
      value: token.value,
      policyProperties: token.policyProperties,
    };
  }
}
routes.push(CreateUserAuthToken);

// Pre-lambda user addition
// /**
//  * @class AddUser
//  */
// class AddUser extends Route {
// 	constructor() {
// 		super('user/:app?', 'ADD USER');
// 		this.verb = Route.Constants.Verbs.POST;
// 		this.auth = Route.Constants.Auth.ADMIN;
// 		this.permissions = Route.Constants.Permissions.ADD;
// 	}

// 	async _validate(req: Request, res: Response) {
// 		Logging.log(req.body.user, Logging.Constants.LogLevel.DEBUG);
// 		const app = req.body.user.app ? req.body.user.app : req.params.app;

// 		if (!app ||
// 				!req.body.user.id ||
// 				!req.body.user.token ||
// 				req.body.user.policyProperties === undefined) {
// 			this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
// 		}

// 		if (req.body.auth) {
// 			this.log(req.body.auth);
// 			this.log('User Auth Token Reqested');
// 			if (!req.body.auth.authLevel ||
// 					!req.body.auth.permissions ||
// 					!req.body.auth.domains) {
// 				this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
// 				return Promise.reject(Helpers.Errors.badRequest('missing_field'));
// 			}

// 			req.body.auth.type = Model.getCoreModel(TokenSchemaModel).Constants.Type.USER;
// 			req.body.auth.app = req.context.authApp.id;
// 		} else {
// 			this.log(`[${this.name}] Auth properties are required when creating a user`, Route.LogLevel.ERR);
// 			return Promise.reject(Helpers.Errors.badRequest('missing_auth'));
// 		}

// 		const policyCheck = await Helpers.checkAppPolicyProperty(req?.authApp?.policyPropertiesList, req.body.user.policyProperties);
// 		if (!policyCheck.passed) {
// 			this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
// 			return Promise.reject(Helpers.Errors.badRequest('invalid_field'));
// 		}

// 		return Promise.resolve(true);
// 	}

// 	async _exec(req: Request, res: Response, validate) {
// 		const user = await Model.getCoreModel(UserSchemaModel).add(req.body.user, req.body.auth);
// 		// TODO: Strip back return data, should match find user
// 		let policyProperties = null;
// 		if (user._appMetadata) {
// 			const _appMetadata = user._appMetadata.find((md) => md.appId.toString() === req.context.authApp.id.toString());
// 			policyProperties = (_appMetadata) ? _appMetadata.policyProperties : null;
// 		}

// 		return {
// 			id: user.id,
// 			auth: user.auth,
// 			tokens: user.tokens,
// 			policyProperties,
// 		};
// 	}
// }
// routes.push(AddUser);

/**
 * @class AddUser
 */
class AddUser extends Route {
  constructor(services: Services) {
    super('user', 'ADD USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  override async _validate(req: RequestWithBody<UserAddBody>, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_app'));
    }

    if (!req.body?.auth) {
      this.log(`[${this.name}] Missing required user auth block`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_user_auth'));
    }

    if (!Array.isArray(req.body.auth) || (Array.isArray(req.body.auth) && req.body.auth.length < 1)) {
      this.log(`[${this.name}] Invalid user auth block`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_user_auth'));
    }

    // Each auth entry is an object of text, before any of it is looked for
    const validation = validateSchemaObject(UserSchemaModel.AddSchema, req.body);
    if (!validation.isValid) {
      const err = invalidEntityError(UserSchemaModel.AddSchema.name, validation);
      this.log(`[${this.name}] ${err.message}`, Route.LogLevel.ERR);
      return Promise.reject(err);
    }

    const existingUsers: User[] = [];
    for await (const auth of req.body.auth) {
      // A user with an auth entry for the same app and the same id or email, both in that one entry. Only what the
      // auth gives is matched, as a missing field would match every entry without one.
      const identifiers = [
        auth.appId !== undefined && auth.appId !== null ? { appId: auth.appId } : null,
        auth.email !== undefined && auth.email !== null ? { email: auth.email } : null,
      ].filter((identifier) => identifier !== null);
      if (identifiers.length < 1) continue;

      // Within the caller's app, which a system token names too
      const user = await this.scoped(req, UserSchemaModel).findOne({
        auth: { $elemMatch: { app: auth.app, $or: identifiers } },
        _appId: req.context.authApp.id,
      });
      if (user) {
        existingUsers.push(user);
      }
    }

    if (existingUsers.length > 0) {
      this.log(`[${this.name}] A user already exists with matching auth (appId or email)`, Route.LogLevel.ERR);
      Logging.logObject(existingUsers, Logging.LogLevel.DEBUG);
      return Promise.reject(Helpers.Errors.badRequest('user_already_exists_with_that_name'));
    }

    if (req.body.token && req.body.token.domains !== undefined && !Helpers.isDomainList(req.body.token.domains)) {
      this.log(`[${this.name}] token.domains must be a list of domain names`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_domains'));
    }

    if (req.body.token && req.body.token.policyProperties) {
      const policyCheck = await Helpers.checkAppPolicyProperty(
        req.context.authApp.policyPropertiesList,
        req.body.token.policyProperties,
      );
      if (!policyCheck.passed) {
        this.log(`[${this.name}] ${policyCheck.errMessage}`, Route.LogLevel.ERR);
        return Promise.reject(Helpers.Errors.badRequest('invalid_policy_property'));
      }
    }

    return Promise.resolve({
      appId: req.context.authApp.id,
    });
  }

  override async _exec(req: RequestWithBody<UserAddBody>, _res: Response, validate: { appId: string }) {
    const user = await this.scoped(req, UserSchemaModel).add(req.body, { _appId: validate.appId });

    return {
      id: user.id,
      auth: user.auth,
      tokens: user.tokens,
    };
  }
}
routes.push(AddUser);

/**
 * @class UpdateUser
 */
class UpdateUser extends CoreUpdateByPath<UserSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'user/:id',
    name: 'UPDATE USER',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.WRITE,
  };
}
routes.push(UpdateUser);

/**
 * @class SetUserPolicyProperties
 */
/**
 * A user's token's policy properties, the token named by the `:tokenId` param, its id or its value. Sockets look at
 * the user's rooms again when properties are taken away.
 */
abstract class UserTokenPolicyProperties extends CoreTokenPolicyProperties<UserSchemaModel> {
  protected override async findToken(req: Request, id: string) {
    const tokenQuery = getTokenQueryfromParams(req, this.scoped(req, UserSchemaModel).createId(id));
    if (!tokenQuery) {
      this.log('ERROR: Invalid Token ID', Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('invalid_token_param');
    }

    const userToken = await this.scoped(req, TokenSchemaModel).findOne(tokenQuery);
    if (!userToken) {
      this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
      throw userTokenNotFound();
    }
    return userToken;
  }

  protected override async afterChange(req: Request, id: string) {
    if (this.config.policyProperties !== 'remove' && this.config.policyProperties !== 'clear') return;

    this._notify('worker:socket:evaluateUserRooms', JSON.stringify({ userId: id, appId: req.context.authApp?.id }));
  }
}

class SetUserPolicyProperties extends UserTokenPolicyProperties {
  static override config: CoreRouteConfig = {
    path: 'user/:id/policy-property/:tokenId',
    name: 'SET USER POLICY PROPERTY',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.WRITE,
    policyProperties: 'set',
  };
}
routes.push(SetUserPolicyProperties);

/**
 * @class UpdateUserPolicyProperties
 */
class UpdateUserPolicyProperties extends UserTokenPolicyProperties {
  static override config: CoreRouteConfig = {
    path: 'user/:id/update-policy-property/:tokenId',
    name: 'UPDATE USER POLICY PROPERTY',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.WRITE,
    policyProperties: 'update',
  };
}
routes.push(UpdateUserPolicyProperties);

/**
 * @class RemoveUserPolicyProperties
 */
class RemoveUserPolicyProperties extends UserTokenPolicyProperties {
  static override config: CoreRouteConfig = {
    path: 'user/:id/remove-policy-property/:tokenId',
    name: 'REMOVE USER POLICY PROPERTY',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.WRITE,
    policyProperties: 'remove',
  };
}
routes.push(RemoveUserPolicyProperties);

/**
 * @class ClearUserPolicyProperties
 */
class ClearUserPolicyProperties extends UserTokenPolicyProperties {
  static override config: CoreRouteConfig = {
    path: 'user/:id/clear-policy-property/:tokenId',
    name: 'CLEAR USER POLICY PROPERTY',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.WRITE,
    policyProperties: 'clear',
  };
}
routes.push(ClearUserPolicyProperties);

/**
 * @class DeleteAllUsers
 */
class DeleteAllUsers extends CoreDeleteAll<UserSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'user',
    name: 'DELETE ALL USERS',
    model: UserSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.DELETE,
    // A system token too removes only its own app's users
    scope: 'own-app',
  };
}
routes.push(DeleteAllUsers);

/**
 * @class DeleteUser
 */
class DeleteUser extends Route {
  constructor(services: Services) {
    super('user/:id', 'DELETE USER', services, Model.getCoreModel(UserSchemaModel).schemaData);
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.DELETE;
  }

  override async _validate(req: Request, _res: Response) {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_field'));
    }

    if (!req.context.token) {
      this.log('ERROR: No authenticated token', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_token'));
    }

    const user = await this.scoped(req, UserSchemaModel).findByIdOrFail(id);

    // A user can have more than one token (CreateUserAuthToken adds them), and every one of them goes with the user
    const userTokens = await Helpers.streamAll<Token>(
      await this.scoped(req, TokenSchemaModel).find({ _userId: user.id }),
    );
    if (userTokens.length < 1) {
      this.log('ERROR: Can not find User token', Route.LogLevel.ERR);
      return Promise.reject(userTokenNotFound());
    }

    const callerValue = req.context.token.value;
    if (userTokens.some((token) => token.value === callerValue)) {
      this.log(`ERROR: A user could not delete itself`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('user_can_not_delete_itself'));
    }

    return {
      user,
      tokens: userTokens,
    };
  }

  override async _exec(req: Request, res: Response, validate: { user: User; tokens: Token[] }) {
    await this.scoped(req, UserSchemaModel).rm(validate.user.id);

    await this.scoped(req, TokenSchemaModel).rmBulk(validate.tokens.map((token) => token.id));

    return true;
  }
}
routes.push(DeleteUser);

/**
 * @class clearUserLocalData
 */
class clearUserLocalData extends Route {
  constructor(services: Services) {
    super(
      'user/:id/clear-local-data',
      'CLEAR USER LOCAL DATA',
      services,
      Model.getCoreModel(UserSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.LAMBDA;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override _validate(req: Request<{ id: string }>, _res: Response) {
    return new Promise<User>((resolve, reject) => {
      if (!req.params.id) {
        this.log(`[${this.name}] Missing required field`, Route.LogLevel.ERR);
        return reject(Helpers.Errors.badRequest('missing_field'));
      }

      this.scoped(req, UserSchemaModel).findByIdOrFail(req.params.id).then(resolve).catch(reject);
    });
  }

  override async _exec(req: RequestWithBody<{ collections?: unknown }>, res: Response, user: User) {
    this._notify(
      'clearUserLocalData',
      JSON.stringify({
        appAPIPath: req.context.authApp ? req.context.authApp.apiPath : '',
        userId: user.id,
        collections: req.body?.collections ? req.body.collections : false,
      }),
    );

    return true;
  }
}
routes.push(clearUserLocalData);

/**
 * @class SearchUserList
 */
class SearchUserList extends CoreSearch<UserSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'user',
    name: 'SEARCH USER LIST',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.LIST,
  };
}
routes.push(SearchUserList);

/**
 * @class UserCount
 */
class UserCount extends CoreCount<UserSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'user/count',
    name: 'COUNT USERS',
    model: UserSchemaModel,
    authType: Route.Constants.Type.LAMBDA,
    permissions: Route.Constants.Permissions.SEARCH,
  };
}
routes.push(UserCount);

/**
 * @type {*[]}
 */
export default routes;
