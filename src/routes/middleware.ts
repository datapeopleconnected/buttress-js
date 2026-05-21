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
import { Response, NextFunction } from 'express';
import onFinished from 'on-finished';

import Logging from '../helpers/logging.js';
import * as Helpers from '../helpers/index.js';
import Model from '../model/index.js';
import Datastore from '../datastore/index.js';
import TokenSchemaModel from '../model/core/token.js';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import AdminRoutes from './admin-routes.js';
import { BjsRequest } from '../types/bjs-express.js';
import AppSchemaModel from '../model/core/app.js';
import AppDataSharingSchemaModel from '../model/core/app-data-sharing.js';
import UserSchemaModel from '../model/core/user.js';
import LambdaSchemaModel from '../model/core/lambda.js';
import TokenSchemaModelCore from '../model/core/token.js';

export class RoutesMiddleware {
  _routerMap: { [key: string]: any };
  _tokensHelper: any;

  constructor(routerMap: { [key: string]: any }, tokensHelper: any) {
    this._routerMap = routerMap;
    this._tokensHelper = tokensHelper;
  }

  _timeRequest(req: BjsRequest, res, next) {
    req.id = Datastore.getInstance('core').ID.new();
    res.set('x-bjs-request-id', req.id);

    req.timer = new Helpers.Timer();
    req.timer.start();

    req.timings = {
      authenticateToken: null,
      configCrossDomain: null,
      authenticate: null,
      validate: null,
      exec: null,
      respond: null,
      logActivity: null,
      boardcastData: null,
      close: null,
      stream: [],
    };

    req.bjsReqStatus = (data, nrp) => nrp.emit(`sock:worker:request-status`, JSON.stringify({ id: req.id, ...data }));
    req.bjsReqClose = (nrp) => nrp.emit(`sock:worker:request-end`, JSON.stringify({ id: req.id, status: 'done' }));

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    Logging.logDebug(`[${req.method.toUpperCase()}] ${req.path} - ${ip}`, req.id);
    Logging.logTimer(`_timeRequest:start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

    onFinished(res, () => {
      Logging.logInfo(`[${req.method.toUpperCase()}] ${req.path} ${res.statusCode} - ${ip}`, req.id);
      Logging.logTimer(`res finished`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    });

    next();
  }

  async _authenticateToken(req: BjsRequest, res, next) {
    req.timings.authenticateToken = req.timer?.interval || 0;
    Logging.logTimer(`_authenticateToken:start ${req.token}`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

    req.isPluginPath = Object.keys(this._routerMap)
      .filter((key) => key.indexOf('plugin-') === 0)
      .map((key) => key.replace('plugin-', ''))
      .some((key) => req.path.indexOf(`${Config.app.apiPrefix}/${key}`) === 0);

    try {
      const adminRoutecall = await AdminRoutes.checkAdminCall(req);
      if (adminRoutecall.adminToken && adminRoutecall.adminApp) {
        req.token = adminRoutecall.adminToken;
        Logging.logTimer(
          `_authenticateAdminToken:got-admin-token`,
          req.timer,
          Logging.Constants.LogLevel.SILLY,
          req.id,
        );

        req.authApp = adminRoutecall.adminApp;
        Logging.logTimer(`_authenticateAdminApp:got-admin-app`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

        Logging.logTimer('_authenticateAdminCall:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
        return next();
      }

      let reqToken: any = null;
      let tokenApp: any = null;
      let useUserToken: any = true;

      req.authLambda = null;

      const isLambdaAPICall = req.url.includes('/lambda/v1/');
      if (isLambdaAPICall) {
        let apiLambdaApp: any = null;
        let apiPath: string = '';

        [apiPath] = req.url.split('/lambda/v1/').join('').split('/');
        apiLambdaApp = await Model.getCoreModel(AppSchemaModel).findOne({
          apiPath: {
            $eq: apiPath,
          },
        });

        if (!apiLambdaApp) {
          Logging.logTimer(
            `_authenticateToken:end-unknown-lambda-app-endpoint`,
            req.timer,
            Logging.Constants.LogLevel.SILLY,
            req.id,
          );
          throw new Helpers.Errors.RequestError(404, 'unknown_lambda_endpoint');
        }

        const [endpoint] = req.url.split(`/lambda/v1/${apiPath}/`).join('').split('?');
        req.authLambda = await Model.getCoreModel(LambdaSchemaModel).findOne({
          'trigger.apiEndpoint.url': {
            $eq: endpoint,
          },
          _appId: {
            $eq: apiLambdaApp.id,
          },
        });

        if (!req.authLambda) {
          Logging.logTimer(
            `_authenticateToken:end-unknown-lambda-endpoint`,
            req.timer,
            Logging.Constants.LogLevel.SILLY,
            req.id,
          );
          throw new Helpers.Errors.RequestError(404, 'unknown_lambda_endpoint');
        }

        if (req.authLambda.type === 'PRIVATE' && !reqToken) {
          reqToken = await this._getProvidedToken(req);
        }

        Logging.logTimer(
          `_authenticateAPILambdaToken:got-lambda ${req.authLambda.id}`,
          req.timer,
          Logging.Constants.LogLevel.SILLY,
          req.id,
        );

        const apiLambdaTrigger = req.authLambda.trigger.find(
          (t) => t.type === 'API_ENDPOINT' && t.apiEndpoint.url === endpoint,
        );

        useUserToken = apiLambdaTrigger && apiLambdaTrigger.apiEndpoint.useCallerToken;
        if (!useUserToken) {
          const token = await Model.getCoreModel(TokenSchemaModelCore).findOne({
            _lambdaId: req.authLambda.id,
          });
          req.token = token;
          req.authApp = apiLambdaApp;
        }
      }

      req.apiPath = typeof req.query.apiPath === 'string' ? req.query.apiPath : '';

      if (useUserToken) {
        req.token = reqToken ? reqToken : await this._getProvidedToken(req);
      }

      if (!isLambdaAPICall && req.token?._lambdaId) {
        const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(req.token._lambdaId);
        req.authLambda = lambda;
        Logging.logTimer(
          `_authenticateToken:got-lambda ${req.authLambda ? req.authLambda.id : lambda}`,
          req.timer,
          Logging.Constants.LogLevel.SILLY,
          req.id,
        );
      }

      if (!req.token) {
        Logging.logTimer(`_authenticateToken:end-missing-token`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
        throw new Helpers.Errors.RequestError(401, 'missing_token');
      }

      Logging.logTimer(
        `_authenticateToken:got-token ${req.token.id}`,
        req.timer,
        Logging.Constants.LogLevel.SILLY,
        req.id,
      );
      Logging.logTimer(
        `_authenticateToken:got-token type ${req.token.type}`,
        req.timer,
        Logging.Constants.LogLevel.SILLY,
        req.id,
      );

      if (!req.authApp) {
        const getApp = async () => {
          if (req.token._appId) {
            return Model.getCoreModel(AppSchemaModel).findById(req.token._appId);
          }
          return Model.getCoreModel(AppSchemaModel).findOne({
            _tokenId: Model.getCoreModel(TokenSchemaModelCore).createId(req.token.id),
          });
        };

        tokenApp = await getApp();
        if (!tokenApp) {
          Logging.logTimer('_authenticateToken:end-app-not-found', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
          throw new Helpers.Errors.RequestError(401, 'app_not_found');
        }
        req.authApp = tokenApp;
        Logging.logTimer(
          `_authenticateToken:got-app ${req.authApp.id}`,
          req.timer,
          Logging.Constants.LogLevel.SILLY,
          req.id,
        );
      }

      if (!req.authAppDataSharing) {
        const appDataSharing = req.token._appDataSharingId
          ? await Model.getCoreModel(AppDataSharingSchemaModel).findById(req.token._appDataSharingId)
          : null;
        req.authAppDataSharing = appDataSharing;
        Logging.logTimer(
          `_authenticateToken:got-app-data-sharing-agreement ${req.authAppDataSharing ? req.authAppDataSharing.id : appDataSharing}`,
          req.timer,
          Logging.Constants.LogLevel.SILLY,
          req.id,
        );
      }

      let user = null;
      if (req.token._userId) {
        user = await Model.getCoreModel(UserSchemaModel).findById(req.token._userId);

        if (!user) {
          Logging.logSilly(`Request was made with a valid token but no user was found for token ${req.token.id}`);
          throw new Helpers.Errors.RequestError(400, 'invalid_token');
        }
      }

      req.authUser = user;
      Logging.logTimer(
        `_authenticateToken:got-user ${req.authUser ? req.authUser.id : user}`,
        req.timer,
        Logging.Constants.LogLevel.SILLY,
        req.id,
      );

      Logging.logTimer('_authenticateToken:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
      next();
    } catch (err) {
      next(err);
    }
  }

  async _getProvidedToken(req: BjsRequest): Promise<any> {
    return await this._tokensHelper._getProvidedToken(req);
  }

  async _getToken(req: BjsRequest, value: string): Promise<any> {
    return await this._tokensHelper._getToken(req, value);
  }

  _lookupToken(tokens: any[], value: string): any {
    return this._tokensHelper._lookupToken(tokens, value);
  }

  _configCrossDomain(req: BjsRequest, res: Response, next: NextFunction) {
    req.timings.configCrossDomain = req.timer?.interval ?? 0;
    Logging.logTimer('_configCrossDomain:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    if (!req.token) {
      res.status(401).json({ message: 'Auth token is required' });
      Logging.logTimer('_configCrossDomain:end-no-auth', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
      return;
    }
    if (req.token.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.USER) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,SEARCH,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'content-type');
      Logging.logTimer('_configCrossDomain:end-app-token', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
      next();
      return;
    }

    const rex = /https?:\/\/(.+)$/;
    let origin: string = req.header('Origin') || '';

    if (!origin) {
      origin = req.header('Host') || '';
    }

    let matches = rex.exec(origin);
    if (matches) {
      origin = matches[1];
    }

    const domains = req.token.domains.map((d: string) => {
      matches = rex.exec(d);
      return matches ? matches[1] : d;
    });

    domains.push(Config.app.host);

    Logging.logSilly(`_configCrossDomain:origin ${origin}`, req.id);
    Logging.logSilly(`_configCrossDomain:domains ${domains}`, req.id);

    const hasFullWildcard = domains.includes('*');
    if (!hasFullWildcard) {
      const domainIdx = domains.findIndex((d) => {
        if (d.indexOf('*') === -1) return d === origin;

        const rex = new RegExp(d.replace(/\./g, '\\.').replace(/\*/g, '.*'));
        return rex.test(origin);
      });

      if (domainIdx === -1) {
        Logging.logError(new Error(`Invalid Domain: ${origin}`));
        res.sendStatus(403);
        Logging.logTimer('_configCrossDomain:end-invalid-domain', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
        return;
      }
    }

    res.header('Access-Control-Allow-Origin', req.header('Origin'));
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,SEARCH,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      Logging.logTimer('_configCrossDomain:end-options-req', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
      return;
    }

    Logging.logTimer('_configCrossDomain:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
    next();
  }

  logErrors(err: any, req: BjsRequest, res: Response, next: NextFunction) {
    Logging.logSilly(`logErrors ${err}`);
    if (err instanceof Helpers.Errors.RequestError) {
      res.status(err.code).json({ statusMessage: err.message, message: err.message });
    } else {
      if (err) {
        Logging.logError(err, req.id);
      }
      res.status(500);
    }

    res.end();
    next(err);
  }
}

export default RoutesMiddleware;
