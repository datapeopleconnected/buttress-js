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
import { Application, Request, Response } from 'express';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Model from '../model/index.js';
import Logging from '../helpers/logging.js';
import * as Helpers from '../helpers/index.js';

import adminPolicy from '../admin-policy.json' with { type: 'json' };
import adminLambda from '../admin-lambda.json' with { type: 'json' };
import TokenSchemaModel, { Token } from '../model/core/token.js';
import AppSchemaModel, { App } from '../model/core/app.js';
import PolicySchemaModel, { PolicyAddBody } from '../model/core/policy.js';
import LambdaSchemaModel, { LambdaAddBody } from '../model/core/lambda.js';
import type { RequestWithBody } from '../types/routes.js';

// The sets of lambdas in admin-lambda.json, and one of their lambdas
type AdminLambdaKey = keyof typeof adminLambda;
type AdminLambda = (typeof adminLambda)[AdminLambdaKey][number];

// A config in admin-policy.json as _createAdminPolicy reads it: the schemas it's for, and its query, or a list of them
type AdminPolicyQuery = Record<string, unknown> & { id?: unknown; _appId?: unknown };
type AdminPolicyConfig = {
  schema: string[];
  query?: AdminPolicyQuery | AdminPolicyQuery[];
};

type InstallLambdaRequest = RequestWithBody<{ installLambda?: string[]; refreshAdminToken?: unknown } | undefined>;

type PolicyPropertiesListArray = Extract<App['policyPropertiesList'][string], unknown[]>;

// TODO: This file might be able to be rolled into routes.

// The token of an `Authorization: Bearer <token>` header, or null
const bearerToken = (req: Request) => {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
};

const tokenInURL = () => Helpers.Errors.badRequest('token_in_url_not_supported', 'A token in the URL is not supported');
const missingToken = () => Helpers.Errors.unauthorised('missing_token', 'A token is required');
const invalidToken = () => Helpers.Errors.unauthorised('invalid_token', 'The token is not valid');

class AdminRoutes {
  _routes: string[];

  constructor() {
    this._routes = ['/api/v1/check/admin', '/api/v1/admin/activate', '/api/v1/admin/install-lambda'];
  }

  /**
   * Init admin routes
   * @param {object} app
   * @return {promise}
   */
  async initAdminRoutes(app: Application) {
    app.get('/api/v1/check/admin', async (req: Request, res: Response) => {
      const superToken = await Model.getCoreModel(TokenSchemaModel).findOne({
        type: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
      });
      if (!superToken) {
        Logging.logError('Buttress admin check can not find super token');
        throw Helpers.Errors.notFound('admin_app_not_found', 'The admin app was not found');
      }

      const superApp = await Model.getCoreModel(AppSchemaModel).findOne({
        _tokenId: Model.getCoreModel(TokenSchemaModel).createId(superToken.id),
      });

      if (!superApp) {
        Logging.logError('Buttress admin check can not find super app');
        throw Helpers.Errors.notFound('admin_app_not_found', 'The admin app was not found');
      }

      res.status(200).send({
        active: superApp?.adminActive,
        apiPath: superApp?.apiPath,
        oAuthOptions: superApp?.oAuth,
      });
    });

    // A token in a URL ends up in access logs and browser history, so it's refused rather than looked up
    app.get('/api/v1/admin/activate/:superToken', () => {
      throw tokenInURL();
    });

    app.get('/api/v1/admin/activate', async (req: Request, res: Response) => {
      const tokenValue = bearerToken(req);
      if (!tokenValue) throw missingToken();
      const superToken = await Model.getCoreModel(TokenSchemaModel).findOne({
        value: tokenValue,
        type: 'system',
      });

      if (!superToken) {
        Logging.logError('The used token does not exist');
        throw invalidToken();
      }

      const superApp = await Model.getCoreModel(AppSchemaModel).findOne({
        _tokenId: Model.getCoreModel(TokenSchemaModel).createId(superToken.id),
      });

      if (!superApp) {
        Logging.logError('Buttress admin activate can not find super app');
        throw Helpers.Errors.notFound('admin_app_not_found', 'The admin app was not found');
      }

      await this._updateAppPolicySelectorList(superApp);

      res.status(200).send({ appId: superApp.id });
    });

    app.post('/api/v1/admin/install-lambda', async (req: InstallLambdaRequest, res: Response) => {
      if (req.query?.token !== undefined) throw tokenInURL();

      const tokenValue = bearerToken(req);
      if (!tokenValue) throw missingToken();
      const adminToken = await Model.getCoreModel(TokenSchemaModel).findOne({
        value: tokenValue,
      });
      if (!adminToken) throw invalidToken();
      if (adminToken.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM) {
        throw Helpers.Errors.forbidden('insufficient_authority', 'Only a system token can install admin lambdas');
      }

      // Read once the token is known to be allowed: a request without a body has none
      const lambdaToInstall: string[] | undefined = req.body?.installLambda;
      const refreshAdminToken: unknown = req.body?.refreshAdminToken;
      if (!lambdaToInstall || !Array.isArray(lambdaToInstall)) {
        throw Helpers.Errors.badRequest('invalid_body', 'installLambda must be a list of admin lambda names');
      }

      const adminLambdaKeys = Object.keys(adminLambda);
      if (!lambdaToInstall.every((key): key is AdminLambdaKey => adminLambdaKeys.includes(key))) {
        throw Helpers.Errors.notFound('lambda_not_found', 'No admin lambda has that name');
      }

      const adminApp = await Model.getCoreModel(AppSchemaModel).findOne({
        _tokenId: Model.getCoreModel(TokenSchemaModel).createId(adminToken.id),
      });

      if (!adminApp) {
        Logging.logError('Buttress admin install lambda can not find admin app');
        throw Helpers.Errors.notFound('admin_app_not_found', 'The admin app was not found');
      }

      await this._createAdminPolicy(adminApp.id);
      for await (const lambdaKey of lambdaToInstall) {
        await this._createAdminLambda(adminLambda[lambdaKey]);
      }

      if (refreshAdminToken) {
        await this._refreshAdminAppToken(adminToken, adminApp);

        await Model.getCoreModel(AppSchemaModel).updateById(Model.getCoreModel(AppSchemaModel).createId(adminApp.id), {
          $set: {
            adminActive: true,
          },
        });
      }

      res.status(200).send({ message: 'done' });
    });
  }

  async checkAdminCall(req: Request) {
    let adminToken: Token | null = null;
    let adminApp: App | null = null;
    const isAdminRouteCall = this._routes.some((r) => {
      let reqURL = req.url;
      if (r.includes(':')) {
        const bareAdminRoute = r.split('/:');
        const bareCalledRoute = reqURL.split('/');
        r = bareAdminRoute?.slice(0, bareAdminRoute.length - 1).join();
        reqURL = bareCalledRoute?.slice(0, bareCalledRoute.length - 1).join('/');
      }

      return r === reqURL;
    });

    if (isAdminRouteCall) {
      adminToken = await Model.getCoreModel(TokenSchemaModel).findOne({
        type: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
      });
    }
    if (adminToken) {
      adminApp = await Model.getCoreModel(AppSchemaModel).findOne({
        _tokenId: Model.getCoreModel(TokenSchemaModel).createId(adminToken.id),
      });
    }

    return {
      adminToken,
      adminApp,
    };
  }

  /**
   * Update admin app policy selectors list
   * @param {Object} app
   */
  async _updateAppPolicySelectorList(app: App) {
    let adminPolicyPropsList: App['policyPropertiesList'] = {
      role: ['ADMIN', 'ADMIN_LAMBDA'],
    };
    const policyPropsList = app.policyPropertiesList;
    if (policyPropsList) {
      const currentAppListKeys = Object.keys(policyPropsList);
      Object.keys(adminPolicyPropsList).forEach((key) => {
        if (currentAppListKeys.includes(key)) {
          // Only the admin lists have been set so far, and they're all arrays
          adminPolicyPropsList[key] = (adminPolicyPropsList[key] as PolicyPropertiesListArray)
            .concat(policyPropsList[key])
            .filter((v, idx, arr) => arr.indexOf(v) === idx);
        }
      });
      adminPolicyPropsList = { ...policyPropsList, ...adminPolicyPropsList };
    }

    await Model.getCoreModel(AppSchemaModel).setPolicyPropertiesList(app.id.toString(), adminPolicyPropsList);
  }

  /**
   * Create Buttress pre-defined policy
   * @param {String} appId
   */
  async _createAdminPolicy(appId: string) {
    for await (const template of adminPolicy) {
      const policyDB = await Model.getCoreModel(PolicySchemaModel).findOne({
        name: {
          $eq: template.name,
        },
      });

      if (policyDB) continue;

      // Filled in for the app, leaving the imported template as it is
      const policy = structuredClone(template);
      const name = policy.name.replace(/[\s-]+/g, '_').toUpperCase();
      if (name.toUpperCase() === 'ADMIN_LAMBDA_ACCESS') {
        // Its configs reach only the admin app: the app config's `id`, and the user and token configs' `_appId`, are
        // `{'@eq': null}` until the app is known. The schemas are the config's, not its queries'.
        (policy.config as AdminPolicyConfig[]).forEach((conf) => {
          if (!conf.query) return;

          for (const query of Array.isArray(conf.query) ? conf.query : [conf.query]) {
            if (conf.schema.includes('app') && query.id) {
              query.id = {
                '@eq': appId,
              };
            }
            if (conf.schema.includes('user') || conf.schema.includes('token')) {
              query._appId = {
                '@eq': appId,
              };
            }
          }
        });
      }

      await Model.getCoreModel(PolicySchemaModel).add(policy as PolicyAddBody, { _appId: appId });
    }
  }

  /**
   * Create Buttress pre-defined lambda
   * @param {Array} lambdas
   */
  async _createAdminLambda(lambdas: AdminLambda[]) {
    try {
      const adminToken = await Model.getCoreModel(TokenSchemaModel).findOne({
        type: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
      });
      if (!adminToken) {
        throw new Error('Cannot find an admin app token');
      }

      const adminApp = await Model.getCoreModel(AppSchemaModel).findOne({
        _tokenId: Model.getCoreModel(TokenSchemaModel).createId(adminToken.id),
      });
      if (!adminApp) {
        throw new Error('Cannot find an admin app');
      }

      for await (const lambda of lambdas) {
        const lambdaDB = await Model.getCoreModel(LambdaSchemaModel).findOne({
          name: lambda.name,
          _appId: Model.getCoreModel(AppSchemaModel).createId(adminApp.id),
        });
        if (lambdaDB) continue;

        const adminLambdaAuth = {
          type: 'lambda',
          domains: [Config.app.host],
          permissions: [{ route: '*', permission: '*' }],
          policyProperties: lambda.policyProperties,
        };

        // await Model.getCoreModel(LambdaSchemaModel).add(lambda, adminLambdaAuth, adminApp);
        // JSON imports type strings as string, rather than the literals LambdaAddBody wants
        await Model.getCoreModel(LambdaSchemaModel).add(lambda as LambdaAddBody, {
          _appId: adminApp.id,
          auth: adminLambdaAuth,
          app: adminApp,
        });
      }

      // ? This normally get's attached the request and not the model manager
      // delete Model.authApp;
    } catch (err: unknown) {
      const errMessage = Helpers.getThrownErrorMessage(err);
      Logging.logError(`Lambda Manager failed to clone required lambdas for installation due to ${errMessage}`);
      throw err;
    }
  }

  /**
   * Refresh Buttress admin app token
   * @param {Object} token
   * @param {Object} app
   */
  async _refreshAdminAppToken(token: Token, app: App) {
    const rxsNewToken = await Model.getCoreModel(TokenSchemaModel).add(
      {
        type: Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM,
        permissions: token.permissions,
      },
      {
        _appId: app.id,
      },
    );
    const newToken = await Helpers.streamFirst<Token>(rxsNewToken);
    await Model.getCoreModel(AppSchemaModel).updateById(Model.getCoreModel(AppSchemaModel).createId(app.id), {
      $set: {
        _tokenId: Model.getCoreModel(TokenSchemaModel).createId(newToken.id),
      },
    });

    await Model.getCoreModel(TokenSchemaModel).rm(token.id);
  }
}

export default new AdminRoutes();
