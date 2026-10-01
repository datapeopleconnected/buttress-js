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
import { Request, Response, NextFunction } from 'express';
import onFinished from 'on-finished';

import Logging from '../helpers/logging.js';
import * as Helpers from '../helpers/index.js';
import IOStats from '../helpers/io-stats.js';
import Model from '../model/index.js';
import Datastore from '../datastore/index.js';
import TokenSchemaModel from '../model/core/token.js';

import { RequestContext } from '../types/bjs-express.js';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import { validate as uuidValidate, version as uuidVersion } from 'uuid';

import AdminRoutes from './admin-routes.js';
import AppSchemaModel, { App } from '../model/core/app.js';
import AppDataSharingSchemaModel from '../model/core/app-data-sharing.js';
import UserSchemaModel, { User } from '../model/core/user.js';
import LambdaSchemaModel from '../model/core/lambda.js';
import TokenSchemaModelCore, { Token } from '../model/core/token.js';

export class RoutesMiddleware {
  _routerMap: Record<string, unknown>;
  _tokensHelper: {
    _getProvidedToken(req: Request): Promise<Token | null>;
    _getToken(req: Request, value: string): Promise<Token | null>;
    _lookupToken(tokens: Token[], value: string): Token | null;
  };

  constructor(
    routerMap: Record<string, unknown>,
    tokensHelper: {
      _getProvidedToken(req: Request): Promise<Token | null>;
      _getToken(req: Request, value: string): Promise<Token | null>;
      _lookupToken(tokens: Token[], value: string): Token | null;
    },
  ) {
    this._routerMap = routerMap;
    this._tokensHelper = tokensHelper;
  }

  _createContext(req: Request, _res: Response, next: NextFunction) {
    const id = Datastore.getInstance('core').ID.new().toString();
    const context: RequestContext = {
      id: id,
      timer: new Helpers.Timer(),
      timings: {
        authenticateToken: null,
        accessControl: null,
        configCrossDomain: null,
        authenticate: null,
        validate: null,
        exec: null,
        respond: null,
        logActivity: null,
        boardcastData: null,
        close: null,
        stream: [],
      },
      authAppDataSharing: null,
      authLambda: null,
      authUser: null,
      authApp: null,
      token: null,
      clientSessionId: null,
      isPluginPath: false,
      ac: {
        policyConfigs: [],
      },
      bjsReqStatus: (data, nrp) =>
        nrp.emit(`sock:worker:request-status`, JSON.stringify({ id: req.context.id, ...data })),
      bjsReqClose: (nrp) => nrp.emit(`sock:worker:request-end`, JSON.stringify({ id: req.context.id, status: 'done' })),
    };

    req.context = context;

    // Count the I/O the rest of the request causes against it, including work still running after it responds.
    IOStats.run(id, next);
  }

  _timeRequest(req: Request, res: Response, next: NextFunction) {
    res.set('x-bjs-request-id', req.context.id);

    req.context.timer.start();

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    Logging.logDebug(`[${req.method.toUpperCase()}] ${req.path} - ${ip}`, req.context.id);
    Logging.logTimer(`_timeRequest:start`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

    onFinished(res, () => {
      Logging.logInfo(`[${req.method.toUpperCase()}] ${req.path} ${res.statusCode} - ${ip}`, req.context.id);
      Logging.logTimer(`res finished`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    });

    next();
  }

  async _authenticateToken(req: Request, res: Response, next: NextFunction) {
    req.context.timings.authenticateToken = req.context.timer?.interval || 0;
    Logging.logTimer(
      `_authenticateToken:start ${req.context.token}`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    req.context.isPluginPath = Object.keys(this._routerMap)
      .filter((key) => key.indexOf('plugin-') === 0)
      .map((key) => key.replace('plugin-', ''))
      .some((key) => req.path.indexOf(`${Config.app.apiPrefix}/${key}`) === 0);

    const clientSessionId = req.headers['x-client-session-id']?.toString() || null;
    if (clientSessionId && !(uuidValidate(clientSessionId) && uuidVersion(clientSessionId) === 4)) {
      throw Helpers.Errors.badRequest('invalid_client_session_id', 'X-Client-Session-Id must be a v4 uuid');
    }

    req.context.clientSessionId = clientSessionId;

    try {
      const adminRoutecall = await AdminRoutes.checkAdminCall(req);
      if (adminRoutecall.adminToken && adminRoutecall.adminApp) {
        req.context.token = adminRoutecall.adminToken;
        Logging.logTimer(
          `_authenticateAdminToken:got-admin-token`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );

        req.context.authApp = adminRoutecall.adminApp;
        Logging.logTimer(
          `_authenticateAdminApp:got-admin-app`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );

        Logging.logTimer(
          '_authenticateAdminCall:end',
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
        return next();
      }

      let reqToken: Token | null = null;
      let tokenApp: App | null = null;
      let useUserToken = true;

      req.context.authLambda = null;

      const isLambdaAPICall = req.url.includes('/lambda/v1/');
      if (isLambdaAPICall) {
        let apiLambdaApp: App | null = null;
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
            req.context.timer,
            Logging.Constants.LogLevel.SILLY,
            req.context.id,
          );
          throw Helpers.Errors.notFound('unknown_lambda_endpoint', 'No lambda has that endpoint');
        }

        const [endpoint] = req.url.split(`/lambda/v1/${apiPath}/`).join('').split('?');
        req.context.authLambda = await Model.getCoreModel(LambdaSchemaModel).findOne({
          'trigger.apiEndpoint.url': {
            $eq: endpoint,
          },
          _appId: {
            $eq: apiLambdaApp.id,
          },
        });

        if (!req.context.authLambda) {
          Logging.logTimer(
            `_authenticateToken:end-unknown-lambda-endpoint`,
            req.context.timer,
            Logging.Constants.LogLevel.SILLY,
            req.context.id,
          );
          throw Helpers.Errors.notFound('unknown_lambda_endpoint', 'No lambda has that endpoint');
        }

        // Only a PUBLIC endpoint takes calls without a token. Any other takes a token of the lambda's own app, or a
        // system token, so a lambda stored without a type is PRIVATE, as its schema's default is.
        if (req.context.authLambda.type !== 'PUBLIC') {
          reqToken = await this._getProvidedToken(req);
          if (!reqToken) throw Helpers.Errors.unauthorised('missing_token', 'A token is required');

          const isSystem = reqToken.type === TokenSchemaModelCore.Constants.Type.SYSTEM;
          if (!isSystem && String(reqToken._appId) !== String(apiLambdaApp.id)) {
            Logging.logTimer(
              `_authenticateToken:end-private-lambda-other-app`,
              req.context.timer,
              Logging.Constants.LogLevel.SILLY,
              req.context.id,
            );
            throw Helpers.Errors.forbidden('insufficient_authority', "The token can't call this lambda endpoint");
          }
        }

        Logging.logTimer(
          `_authenticateAPILambdaToken:got-lambda ${req.context.authLambda.id}`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );

        const apiLambdaTrigger = req.context.authLambda.trigger.find(
          (t) => t.type === 'API_ENDPOINT' && t.apiEndpoint.url === endpoint,
        );

        useUserToken = Boolean(apiLambdaTrigger && apiLambdaTrigger.apiEndpoint.useCallerToken);
        if (!useUserToken) {
          const token = await Model.getCoreModel(TokenSchemaModelCore).findOne({
            _lambdaId: req.context.authLambda.id,
          });
          req.context.token = token;
          req.context.authApp = apiLambdaApp;
        }
      }

      req.context.apiPath = typeof req.query.apiPath === 'string' ? req.query.apiPath : '';

      if (useUserToken) {
        req.context.token = reqToken ? reqToken : await this._getProvidedToken(req);
      }

      if (!isLambdaAPICall && req.context.token?._lambdaId) {
        const lambda = await Model.getCoreModel(LambdaSchemaModel).findById(req.context.token._lambdaId);
        req.context.authLambda = lambda;
        Logging.logTimer(
          `_authenticateToken:got-lambda ${req.context.authLambda ? req.context.authLambda.id : lambda}`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
      }

      if (!req.context.token) {
        Logging.logTimer(
          `_authenticateToken:end-missing-token`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
        throw Helpers.Errors.unauthorised('missing_token', 'A token is required');
      }

      const token = req.context.token;

      Logging.logTimer(
        `_authenticateToken:got-token ${token.id}`,
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );
      Logging.logTimer(
        `_authenticateToken:got-token type ${token.type}`,
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );

      if (!req.context.authApp) {
        const getApp = async () => {
          if (token._appId) {
            return Model.getCoreModel(AppSchemaModel).findById(token._appId);
          }
          return Model.getCoreModel(AppSchemaModel).findOne({
            _tokenId: Model.getCoreModel(TokenSchemaModelCore).createId(token.id),
          });
        };

        tokenApp = await getApp();
        if (!tokenApp) {
          Logging.logTimer(
            '_authenticateToken:end-app-not-found',
            req.context.timer,
            Logging.Constants.LogLevel.SILLY,
            req.context.id,
          );
          throw Helpers.Errors.unauthorised('app_not_found', "The token's app was not found");
        }
        req.context.authApp = tokenApp;
        Logging.logTimer(
          `_authenticateToken:got-app ${req.context.authApp.id}`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
      }

      if (!req.context.authAppDataSharing) {
        const appDataSharing = token._appDataSharingId
          ? await Model.getCoreModel(AppDataSharingSchemaModel).findById(token._appDataSharingId)
          : null;
        req.context.authAppDataSharing = appDataSharing;
        Logging.logTimer(
          `_authenticateToken:got-app-data-sharing-agreement ${req.context.authAppDataSharing ? req.context.authAppDataSharing.id : appDataSharing}`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
      }

      // A partner's token works only while its agreement is active. An agreement that has never been active (it has no
      // token of the partner's yet) lets the partner complete the handshake: its client reads the app's schema, then
      // activates the agreement. One this app has deactivated takes nothing.
      const agreement = req.context.authAppDataSharing;
      if (token.type === TokenSchemaModelCore.Constants.Type.DATA_SHARING && !agreement?.active) {
        const pending = Boolean(agreement) && !agreement?.remoteApp?.token;
        const isHandshake =
          (req.method === 'POST' && req.path === `${Config.app.apiPrefix}/app-data-sharing/activate`) ||
          (req.method === 'GET' && req.path === `${Config.app.apiPrefix}/app/schema`);
        if (!pending || !isHandshake) {
          Logging.logTimer(
            '_authenticateToken:end-data-sharing-inactive',
            req.context.timer,
            Logging.Constants.LogLevel.SILLY,
            req.context.id,
          );
          throw Helpers.Errors.forbidden('data_sharing_inactive', 'The data sharing agreement is not active');
        }
      }

      let user: User | null = null;
      if (token._userId) {
        user = await Model.getCoreModel(UserSchemaModel).findById(token._userId);

        if (!user) {
          Logging.logSilly(`Request was made with a valid token but no user was found for token ${token.id}`);
          throw Helpers.Errors.unauthorised('invalid_token', "The token's user was not found");
        }
      }

      req.context.authUser = user;
      Logging.logTimer(
        `_authenticateToken:got-user ${req.context.authUser ? req.context.authUser.id : user}`,
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );

      Logging.logTimer('_authenticateToken:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
      next();
    } catch (err: unknown) {
      next(err);
    }
  }

  async _getProvidedToken(req: Request): Promise<Token | null> {
    return await this._tokensHelper._getProvidedToken(req);
  }

  async _getToken(req: Request, value: string): Promise<Token | null> {
    return await this._tokensHelper._getToken(req, value);
  }

  _lookupToken(tokens: Token[], value: string): Token | null {
    return this._tokensHelper._lookupToken(tokens, value);
  }

  _configCrossDomain(req: Request, res: Response, next: NextFunction) {
    const { context } = req;
    context.timings.configCrossDomain = context.timer?.interval ?? 0;
    Logging.logTimer('_configCrossDomain:start', context.timer, Logging.Constants.LogLevel.SILLY, context.id);
    if (!context.token) {
      Logging.logTimer('_configCrossDomain:end-no-auth', context.timer, Logging.Constants.LogLevel.SILLY, context.id);
      next(Helpers.Errors.unauthorised('missing_token', 'A token is required'));
      return;
    }
    if (context.token.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.USER) {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,SEARCH,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'content-type');
      Logging.logTimer('_configCrossDomain:end-app-token', context.timer, Logging.Constants.LogLevel.SILLY, context.id);
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

    // A token stored before its domains were checked may hold something other than a list of strings, which is
    // left out, so the request is refused like any other that matches none of its domains.
    const tokenDomains: unknown[] = Array.isArray(context.token.domains) ? context.token.domains : [];
    const domains = tokenDomains
      .filter((d): d is string => typeof d === 'string')
      .map((d) => {
        matches = rex.exec(d);
        return matches ? matches[1] : d;
      });

    domains.push(Config.app.host);

    Logging.logSilly(`_configCrossDomain:origin ${origin}`, context.id);
    Logging.logSilly(`_configCrossDomain:domains ${domains}`, context.id);

    const hasFullWildcard = domains.includes('*');
    if (!hasFullWildcard) {
      const domainIdx = domains.findIndex((d) => {
        if (d.indexOf('*') === -1) return d === origin;

        const rex = new RegExp(d.replace(/\./g, '\\.').replace(/\*/g, '.*'));
        return rex.test(origin);
      });

      if (domainIdx === -1) {
        Logging.logError(new Error(`Invalid Domain: ${origin}`));
        next(Helpers.Errors.forbidden('origin_not_allowed', "The request's origin isn't one of the token's domains"));
        Logging.logTimer(
          '_configCrossDomain:end-invalid-domain',
          context.timer,
          Logging.Constants.LogLevel.SILLY,
          context.id,
        );
        return;
      }
    }

    res.header('Access-Control-Allow-Origin', req.header('Origin'));
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,SEARCH,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      Logging.logTimer(
        '_configCrossDomain:end-options-req',
        context.timer,
        Logging.Constants.LogLevel.SILLY,
        context.id,
      );
      return;
    }

    Logging.logTimer('_configCrossDomain:end', context.timer, Logging.Constants.LogLevel.SILLY, context.id);
    next();
  }

  /**
   * Sends the error response: an ApiError's status and `{code, message, details?}`, or a 500 `internal_error` for
   * anything else, whose message may carry internal details, and which is logged. The error isn't passed on once it's
   * sent, as Express's final handler destroys the socket of a request whose response has started, and a client
   * reusing the keep-alive connection would have its next request fail.
   */
  logErrors(err: unknown, req: Request, res: Response, next: NextFunction) {
    Logging.logSilly(`logErrors ${err}`);
    const apiError = Helpers.Errors.toApiError(err);
    if (apiError.status >= 500) {
      Logging.logError(apiError === err && apiError.cause !== undefined ? apiError.cause : err, req.context.id);
    }

    // Part of the response has already gone, so the error can't be sent. Destroying the socket is how the client
    // learns the response is incomplete.
    if (res.headersSent) return next(err);

    res.status(apiError.status).json(apiError.toBody());
  }
}

export default RoutesMiddleware;
