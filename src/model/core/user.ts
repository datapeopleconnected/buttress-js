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
import StandardModel from '../type/standard.js';
import { TenantKey } from '../type/tenant-scoped.js';

import Logging from '../../helpers/logging.js';
import * as Helpers from '../../helpers/index.js';
import { Schema } from '../../helpers/schema.js';
import TokenSchemaModel, { PolicyProperties, Token } from './token.js';
import { Services } from '../../bootstrap.js';
import { AdapterDocument, UpdatePathBody } from '../../types/datastore.js';

// A type rather than an interface, so it's assignable to AdapterDocument
export type User = {
  id: string;
  auth: Array<UserAuth>;
  _appId: string;
  // See UserSchemaModel.authKeys
  _authKeys?: string[];
};

export interface UserAuth {
  app: string;
  appId: string;
  username: string;
  password: string;
  profileUrl: string;
  images: {
    profile: string;
    banner: string;
  };
  email: string;
  locale: string;
  token: string;
  tokenSecret: string;
  refreshToken: string;
  extras: string;
}

// An auth entry as posted to the API, add stores the images from profileImgUrl and bannerImgUrl
export type UserAuthBody = {
  app?: string;
  appId?: string | null;
  username?: string;
  password?: string;
  profileUrl?: string;
  profileImgUrl?: string;
  bannerImgUrl?: string;
  email?: string;
  locale?: string;
  token?: string;
  tokenSecret?: string;
  refreshToken?: string;
  extras?: string;
};

// A user as posted to the API, with an optional token to create for them
export type UserAddBody = {
  id?: string;
  auth: UserAuthBody[];
  token?: {
    domains?: string[];
    policyProperties?: PolicyProperties;
  };
};

// A user's details from an auth app, see updateAppInfo
type UserAppInfo = {
  username: string;
  profileUrl: string;
  profileImgUrl: string;
  bannerImgUrl: string;
  email: string;
  token: string;
  tokenSecret: string;
  refreshToken: string;
};

type UserWithTokens = User & {
  tokens: Array<{
    id: string;
    value: string;
    policyProperties: Token['policyProperties'];
  }>;
};

// AddUser refuses a user that one of the app's users already has an auth entry of, as does the datastore
export const userAlreadyExists = () => Helpers.Errors.badRequest('user_already_exists_with_that_name');

// The datastore refusing a write because another of the app's users has one of its auth keys
const isAuthKeyDuplicate = (err: unknown) =>
  err instanceof Helpers.Errors.ApiError && err.code === 'duplicate' && err.details?.path === '_authKeys';

/**
 * Constants
 */
const apps = ['google', 'facebook', 'twitter', 'linkedin', 'microsoft'];
const App = {
  GOOGLE: apps[0],
  FACEBOOK: apps[1],
  TWITTER: apps[2],
  LINKEDIN: apps[3],
  MICROSOFT: apps[4],
};

export default class UserSchemaModel extends StandardModel<User> {
  static override name = 'User';
  // Each row names the app it belongs to
  static TenantKey: TenantKey = '_appId';

  constructor(services: Services) {
    const schema = UserSchemaModel.Schema;
    super(schema, null, services);
  }

  static get Constants() {
    return {
      App: App,
    };
  }
  get Constants() {
    return UserSchemaModel.Constants;
  }

  static get Schema(): Schema {
    return {
      name: 'users',
      type: 'collection',
      extends: [],
      core: true,
      properties: {
        auth: {
          __type: 'array',
          __required: true,
          __allowUpdate: true,
          __schema: {
            app: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            appId: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            username: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            // Never given back (D-24)
            password: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
              __private: true,
            },
            profileUrl: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            images: {
              profile: {
                __type: 'string',
                __default: '',
                __allowUpdate: true,
              },
              banner: {
                __type: 'string',
                __default: '',
                __allowUpdate: true,
              },
            },
            email: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            locale: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            token: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            tokenSecret: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            refreshToken: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
            extras: {
              __type: 'string',
              __default: '',
              __allowUpdate: true,
            },
          },
        },
        _appId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
        // Worked out from auth by the model, see authKeys; unique, so two creates at once can't both store a user
        _authKeys: {
          __type: 'array',
          __itemtype: 'string',
          __allowUpdate: false,
          __private: true,
          __unique: true,
        },
      },
    };
  }

  /**
   * The keys a user's auth entries claim within their app, one for each entry's app and id and one for its app and
   * email, for what the entry has. No two of an app's users may share one, which is what AddUser checks for, and the
   * datastore holds to under `_authKeys`'s unique index. A user may repeat one of their own.
   * @param {string} appId - the Buttress app the user belongs to
   * @param {unknown} auth - the user's auth entries, as stored
   * @return {string[]}
   */
  static authKeys(appId: string, auth: unknown): string[] {
    if (!Array.isArray(auth)) return [];

    const given = (value: unknown): value is string => typeof value === 'string' && value !== '';
    return auth.flatMap((item: unknown) => {
      if (item === null || typeof item !== 'object') return [];
      const entry = item as Partial<UserAuth>;
      const app = entry.app ?? '';
      return [
        ...(given(entry.appId) ? [JSON.stringify([appId, app, 'appId', entry.appId])] : []),
        ...(given(entry.email) ? [JSON.stringify([appId, app, 'email', entry.email])] : []),
      ];
    });
  }

  override get derivedFrom() {
    return ['auth', '_appId'];
  }

  override deriveFields(entity: AdapterDocument) {
    return { _authKeys: UserSchemaModel.authKeys(String(entity._appId), entity.auth) };
  }

  // A duplicate auth key means the update gives the user an auth entry another of the app's users has
  override async updateByPath(body: UpdatePathBody | UpdatePathBody[], id: string, via: string | null = null) {
    try {
      return await super.updateByPath(body, id, via);
    } catch (err: unknown) {
      if (isAuthKeyDuplicate(err)) throw userAlreadyExists();
      throw err;
    }
  }

  // Pre-lambda user addition
  // /**
  //  * @param {Object} body - body passed through from a POST request
  //  * @param {Object} auth - OPTIONAL authentication details for a user token
  //  * @return {Promise} - returns a promise that is fulfilled when the database request is completed
  //  */
  // async add(body, auth) {
  // 	const userBody = {
  // 		auth: [{
  // 			app: body.app,
  // 			appId: body.id,
  // 			username: body.username,
  // 			password: body.password,
  // 			profileUrl: body.profileUrl,
  // 			images: {
  // 				profile: body.profileImgUrl,
  // 				banner: body.bannerImgUrl,
  // 			},
  // 			email: body.email,
  // 			token: body.token,
  // 			tokenSecret: body.tokenSecret,
  // 			refreshToken: body.refreshToken,
  // 		}],
  // 	};

  // 	const rxsUser = await super.add(userBody, {
  // 		_appId: this.__modelManager.authApp.id,
  // 		_appMetadata: [{
  // 			appId: this.__modelManager.authApp.id,
  // 			policyProperties: (body.policyProperties) ? body.policyProperties : null,
  // 		}],
  // 	});
  // 	const user = await Helpers.streamFirst(rxsUser);

  // 	user.tokens = [];

  // 	if (!auth) {
  // 		return user;
  // 	}

  // 	const rxsToken = await this.__modelManager.Token.add(auth, {
  // 		_appId: this.__modelManager.authApp.id,
  // 		_userId: user.id,
  // 	});
  // 	const token = await Helpers.streamFirst(rxsToken);

  // 	this.__nrp.emit('app-routes:bust-cache', {});

  // 	if (token) {
  // 		user.tokens.push({
  // 			value: token.value,
  // 		});
  // 	}

  // 	return user;
  // }

  /**
   * @param {Object} body - body passed through from a POST request
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  /**
   * A user as AddUser takes one, which add stores as `Schema` reads it: each auth entry's fields are text, and its
   * images are given as `profileImgUrl` and `bannerImgUrl`. The token to create for them is checked by the route.
   */
  static get AddSchema(): Schema {
    const text = { __type: 'string', __allowUpdate: true } as const;
    return {
      name: 'users',
      type: 'collection',
      core: true,
      properties: {
        id: { __type: 'id', __allowUpdate: false },
        auth: {
          __type: 'array',
          __required: true,
          __allowUpdate: true,
          __schema: Object.fromEntries(
            [
              'app',
              'appId',
              'username',
              'password',
              'profileUrl',
              'profileImgUrl',
              'bannerImgUrl',
              'email',
              'locale',
              'token',
              'tokenSecret',
              'refreshToken',
              'extras',
            ].map((field) => [field, text]),
          ),
        },
      },
    };
  }

  override async add(body: UserAddBody, internals: { _appId: string }): Promise<UserWithTokens> {
    // Stored as the schema reads it, with its defaults for what's left out
    const userBody = {
      id: body.id ? this.createId(body.id) : this.createId(),
      auth: body.auth.map(({ profileImgUrl, bannerImgUrl, ...item }) => ({
        ...item,
        // The id the auth app has for the user, which finding them matches, or none
        appId: item.appId ? item.appId : null,
        images: { profile: profileImgUrl, banner: bannerImgUrl },
      })),
    };

    // A user stored since the route looked has the same auth, if the datastore refuses one of its auth keys
    const rxsUser = await super
      .add(userBody, {
        _appId: internals._appId,
      })
      .catch((err: unknown) => {
        throw isAuthKeyDuplicate(err) ? userAlreadyExists() : err;
      });
    const user = (await Helpers.streamFirst<User>(rxsUser)) as UserWithTokens;

    user.tokens = [];

    const tokenBody = body.token;
    if (tokenBody && tokenBody.domains && tokenBody.policyProperties) {
      const userToken = {
        type: TokenSchemaModel.Constants.Type.USER,
        permissions: [{ route: '*', permission: '*' }],
        domains: tokenBody.domains,
        policyProperties: tokenBody.policyProperties,
      };

      const rxsToken = await this.__modelManager.getCoreModel(TokenSchemaModel).add(userToken, {
        _appId: internals._appId,
        _userId: user.id,
      });
      const token = await Helpers.streamFirst<Token>(rxsToken);

      if (token) {
        user.tokens.push({
          id: token.id,
          value: token.value,
          policyProperties: token.policyProperties,
        });
      }
    }

    this.__nrp?.emit('app-routes:bust-cache', '{}');

    return user;
  }

  // addAuth(auth) {
  // 	Logging.log(`addAuth: ${auth.app}`, Logging.Constants.LogLevel.INFO);
  // 	const existing = this.auth.find((a) => a.app === auth.app && a.id == auth.id); // eslint-disable-line eqeqeq
  // 	if (existing) {
  // 		Logging.log(`present: ${auth.app}:${auth.id}`, Logging.Constants.LogLevel.DEBUG);
  // 		return Promise.resolve(this);
  // 	}

  // 	Logging.log(`not present: ${auth.app}:${auth.id}`, Logging.Constants.LogLevel.DEBUG);
  // 	this.auth.push(new this.__modelManager.Appauth({
  // 		app: auth.app,
  // 		appId: auth.id,
  // 		username: auth.username,
  // 		profileUrl: auth.profileUrl,
  // 		images: {
  // 			profile: auth.profileImgUrl,
  // 			banner: auth.bannerImgUrl,
  // 		},
  // 		email: auth.email,
  // 		token: auth.token,
  // 		tokenSecret: auth.tokenSecret,
  // 		refreshToken: auth.refreshToken,
  // 	}));

  // 	return this.save();
  // }

  /**
   * @param {object} user - user object of which the token is being updated
   * @param {object} app - app object of which the token is being updated
   * @param {Object} updated - updated app information passed through from a PUT request
   * @return {Promise} - returns a promise that is fulfilled when the database request is completed
   */
  updateAppInfo(user: User, app: string, updated: UserAppInfo) {
    const authIdx = user.auth.findIndex((a) => a.app === app);
    if (authIdx === -1) {
      Logging.log(`Unable to find Appauth for ${app}`, Logging.Constants.LogLevel.DEBUG);
      return Promise.resolve(false);
    }

    const auth = user.auth[authIdx];
    auth.username = updated.username;
    auth.profileUrl = updated.profileUrl;
    auth.images.profile = updated.profileImgUrl;
    auth.images.banner = updated.bannerImgUrl;
    auth.email = updated.email;
    auth.token = updated.token;
    auth.tokenSecret = updated.tokenSecret;
    auth.refreshToken = updated.refreshToken;

    const update: Record<string, UserAuth | string[]> = {};
    update[`auth.${authIdx}`] = auth;
    update._authKeys = UserSchemaModel.authKeys(user._appId, user.auth);
    return super.updateById(user.id, update).then(() => true);
  }

  /**
   * @param {string} username - username to check for
   * @return {Promise} - resolves to a User object or null
   */
  getByUsername(username: string) {
    return super.findOne({ username: username }, { id: 1 });
  }

  /**
   * @param {string} authAppName - Name of the authenticating App (facebook|twitter|google) that owns the user
   * @param {string} authAppUserId - Id of the user in the authenticating App
   * @param {string} appId - Buttress App Id of the user
   * @return {Promise} - resolves to an array of Apps
   */
  getByAuthAppId(authAppName: string, authAppUserId: string, appId?: string) {
    return super.findOne({
      'auth.app': authAppName,
      'auth.appId': authAppUserId,
      ...(appId ? { _appId: this.createId(appId) } : {}),
    });
  }

  override rm(userId: string) {
    return super.rm(userId);
  }
}
