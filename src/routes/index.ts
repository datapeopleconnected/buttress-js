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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import NRP from '../services/nrp.js';

import Logging from '../helpers/logging.js';
import * as Helpers from '../helpers/index.js';
import AccessControl from '../access-control/index.js';
import Model from '../model/index.js';
import Route from './route.js';

import { Services } from '../bootstrap.js';

import AdminRoutes from './admin-routes.js';
import SchemaRoutes from './schema-routes/index.js';

import { Routes as CoreRoutes } from './api/index.js';

import AppSchemaModel, { App } from '../model/core/app.js';
import AppDataSharingSchemaModel from '../model/core/app-data-sharing.js';
import { Schema } from '../helpers/schema.js';

import RoutesTokens from './tokens.js';
import RoutesLambdaSetup from './lambda-setup.js';
import RoutesMiddleware from './middleware.js';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class Routes {
  app: express.Application;
  id: string;

  _routerMap: any;
  _routerOrder: string[];
  _dispatcherMounted: boolean;
  _errorHandlerMounted: boolean;

  _services: Services = new Map();

  _nrp?: NRP;

  _preRouteMiddleware: any[];

  _tokensHelper: RoutesTokens;
  _lambdaSetupHelper: RoutesLambdaSetup;
  _middlewareHelper: RoutesMiddleware;

  constructor(app: express.Application) {
    this.app = app;
    this.id = uuidv4();

    this._routerMap = {};
    this._routerOrder = [];
    this._dispatcherMounted = false;
    this._errorHandlerMounted = false;

    this._tokensHelper = new RoutesTokens();
    this._lambdaSetupHelper = new RoutesLambdaSetup(app, undefined, []);
    this._middlewareHelper = new RoutesMiddleware(this._routerMap, this._tokensHelper);

    this._preRouteMiddleware = [
      (req: Request, res: Response, next: NextFunction) => this._middlewareHelper._createContext(req, res, next),
      (req: Request, res: Response, next: NextFunction) => this._middlewareHelper._timeRequest(req, res, next),
      (req: Request, res: Response, next: NextFunction) => this._authenticateToken(req, res, next),
      (req: Request, res: Response, next: NextFunction) =>
        AccessControl.accessControlPolicyMiddleware(req, res, next),
      (req: Request, res: Response, next: NextFunction) => this._configCrossDomain(req, res, next),
    ];
  }

  async init(services) {
    this._services = services;

    this._nrp = services.get('nrp');
    if (!this._nrp) throw new Error('Routes: NRP not found in services');

    this._lambdaSetupHelper = new RoutesLambdaSetup(this.app, this._nrp, this._preRouteMiddleware);
    this._middlewareHelper = new RoutesMiddleware(this._routerMap, this._tokensHelper);

    this._nrp?.on('rest:worker:app-deleted', (exec: any) => {
      exec = JSON.parse(exec);
      if (!exec.apiPath) return;
      this._deregisterRouter(exec.apiPath);
    });
  }

  /**
   * Init core routes & app schema
   * @return {promise}
   */
  async initRoutes() {
    this.app.get('/favicon.ico', (req: Request, res: Response) => res.sendStatus(404));
    this.app.get(['/', '/index.html'], (req: Request, res: Response) => res.sendFile(path.join(__dirname, '../static/index.html')));

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const logEvent = (event: string, err?: any) => {
        if (err) {
          Logging.logError(`${event}`, req.context.id);
          Logging.logError(err, req.context.id);
        } else {
          Logging.logSilly(`${event}`, req.context.id);
        }
      };

      req.on('close', () => logEvent('close'));
      req.on('end', () => logEvent('end'));
      req.on('error', (err) => logEvent('error', err));
      req.on('pause', () => logEvent('pause'));
      req.on('resume', () => logEvent('resume'));
      req.on('timeout', () => logEvent('timeout'));

      // if (req.socket) {
      // 	req.socket.once('close', (hadError) => logEvent(`socket onClose had_error:${hadError}`));
      //   req.socket.once('connect', () => logEvent('socket onConnect'));
      //   req.socket.once('end', () => logEvent('socket onEnd'));
      //   req.socket.once('lookup', (err, address, family, host) => {
      //       if (err) {
      //           logEvent('socket onLookup', err);
      //           return;
      //       }
      //       Logging.logDebug(`socket onLookup address:${address} family:${family} host:${host}}`, req.context.id);
      //   });
      //   req.socket.once('timeout', () => logEvent('socket onTimeout'));
      //   req.socket.once('error', (err) => logEvent('socket onError', err));
      // }

      next();
    });
    this.app.use((err, req: Request, res: Response, next: NextFunction) => {
      if (err) Logging.logError(err, req.context.id);
      next();
    });

    const coreRouter = this._createRouter();
    const providers = this._getCoreRoutes();
    for (let x = 0; x < providers.length; x++) {
      const routes = providers[x];
      for (let y = 0; y < routes.length; y++) {
        const route = routes[y];
        this._initRoute(coreRouter, route, true);
      }
    }

    this._registerRouter('core', coreRouter);

    await this._tokensHelper.loadTokens();

    await this._lambdaSetupHelper._setupLambdaEndpoints();

    await AdminRoutes.initAdminRoutes(this.app);

    this._mountErrorHandler();
    Logging.logSilly(`init:registered-routes`);
  }

  async initAppRoutes() {
    const rxsApps = await Model.getCoreModel(AppSchemaModel).findAll();
    for await (const app of rxsApps) {
      await this._generateAppRoutes(app);
    }
  }

  /**
   * @return {object} - express router object
   */
  _createRouter() {
    const apiRouter = Router();

    // We used to assign middleware to the router here. When a request comes in
    // each defined router is called to see if it has matching routes, this resulted
    // in the middleware being called mutliple times for each router defined.
    // I've now moved the middleware to be called before each route.
    // See: this._preRouteMiddleware

    return apiRouter;
  }

  _mountRouterDispatcher() {
    if (this._dispatcherMounted) return;

    this.app.use('', (req: Request, res: Response, next: NextFunction) => this._dispatchRouters(req, res, next));
    this._dispatcherMounted = true;
  }

  _mountErrorHandler() {
    if (this._errorHandlerMounted) return;

    const logErrors = (err: any, req: Request, res: Response, next: NextFunction) => this.logErrors(err, req, res, next);
    this.app.use(logErrors);
    this._errorHandlerMounted = true;
  }

  _dispatchRouters(req: Request, res: Response, next: NextFunction) {
    const keys = [...this._routerOrder];
    let idx = 0;

    const run = (err?: any) => {
      if (err) return next(err);
      if (res.headersSent || res.writableEnded) return;

      const key = keys[idx++];
      if (!key) return next();

      const router = this._routerMap[key];
      if (!router) return run();

      return router(req, res, run);
    };

    return run();
  }

  /**
   * Register a router in _routerMap
   * @param {string} key
   * @param {object} router - express router object
   */
  _registerRouter(key, router) {
    if (this._routerMap[key]) {
      Logging.logSilly(`Routes:_registerRouter Reregister ${key}`);
      this._routerMap[key] = router;
      return;
    }

    Logging.logSilly(`Routes:_registerRouter Register ${key}`);
    this._routerMap[key] = router;
    this._routerOrder.push(key);

    this._mountRouterDispatcher();
  }

  _deregisterRouter(key) {
    if (!this._routerMap[key]) return;

    Logging.logSilly(`Routes:_deregisterRouter Deregister ${key}`);
    delete this._routerMap[key];
    this._routerOrder = this._routerOrder.filter((k) => k !== key);
  }

  /**
   * Get router with key
   * @param {string} key
   * @return {object} - express router object
   */
  _getRouter(key) {
    return this._routerMap[key];
  }

  /**
   * Regenerate app routes for given app id
   * @param {string} appId - Buttress app id
   * @return {promise}
   */
  regenerateAppRoutes(appId) {
    Logging.logSilly(`Routes:regenerateAppRoutes regenerating routes for ${appId}`);
    return Model.getCoreModel(AppSchemaModel)
      .findById(appId)
      .then((app) => this._generateAppRoutes(app));
  }

  /**
   * Genereate app routes & register for given app
   * @param {object} app - Buttress app object
   */
  async _generateAppRoutes(app) {
    if (!app) throw new Error(`Expected app object to be passed through to _generateAppRoutes, got ${app}`);
    if (!app.__schema) return;

    // Get DS agreements
    const appDSAs = await Helpers.streamAll(
      await Model.getCoreModel(AppDataSharingSchemaModel).find({
        _appId: app.id,
      }),
    );

    const appRouter = this._createRouter();

    Helpers.Schema.decode(app.__schema)
      .filter((schema) => schema.type.indexOf('collection') === 0)
      .filter((schema) => {
        if (!schema.remotes) return true;
        const remotes = Array.isArray(schema.remotes) ? schema.remotes : [schema.remotes];

        const nonActiveDSA = remotes.reduce((arr, remoteRef) => {
          // if the data sharing agreement is not active, we'll make note of the name for debugging.
          if (appDSAs.find((dsa) => dsa.active && dsa.name === remoteRef.name) === undefined) {
            arr.push(remoteRef.name);
          }
          return arr;
        }, []);

        if (nonActiveDSA.length > 0) {
          Logging.logWarn(
            `Routes:_generateAppRoutes ${app.id} skipping route /${app.apiPath} for ${schema.name}, DSA not active`,
          );
          return false;
        }

        return true;
      })
      .forEach((schema) => {
        Logging.logSilly(`Routes:_generateAppRoutes ${app.id} init routes /${app.apiPath} for ${schema.name}`);
        return this._initSchemaRoutes(appRouter, app, schema);
      });

    this._registerRouter(app.apiPath, appRouter);
  }

  createPluginRoutes(pluginName, routes) {
    if (routes.length === 0) return;

    Logging.logDebug(`Routes:createPluginRoutes ${pluginName} has ${routes.length} routes`);

    const pluginRouter = this._createRouter();

    for (let y = 0; y < routes.length; y++) {
      const route = routes[y];
      this._initRoute(pluginRouter, route, false, pluginName);
    }

    this._registerRouter(`plugin-${pluginName}`, pluginRouter);
  }

  _initRoute(app: Router, routeClass: any, core: boolean, pathPrefix: string = '') {
    const route = core ? new routeClass(this._services) : new routeClass(null, null, this._services);
    route.paths.forEach((pathSpec) => {
      const routePath = path.join(...[Config.app.apiPrefix, pathPrefix, pathSpec]);
      Logging.logSilly(`_initRoute:register [${route.verb.toUpperCase()}] ${routePath}`);
      app[route.verb](routePath, this._preRouteMiddleware, (req: Request, res: Response, next: NextFunction) => {
        req.context.pathSpec = pathSpec;
        return route.exec(req, res).catch(next);
      });
    });
  }

  /**
   * @param  {Object} express - express applcation container
   * @param  {Object} app - app data object
   * @param  {Object} schemaData - schema data object
   */
  _initSchemaRoutes(express, app: App, schemaData: Schema) {
    SchemaRoutes.forEach((SchemaRoute) => {
      let route: Route;

      try {
        route = new SchemaRoute(schemaData, app, this._services);
      } catch (err) {
        if (err instanceof Helpers.Errors.RouteMissingModel) return Logging.logWarn(`${err.message} for ${app.name}`);

        throw err;
      }

      route.paths.forEach((pathSpec) => {
        let routePath = path.join(...[app.apiPath, Config.app.apiPrefix, pathSpec]);
        if (routePath.indexOf('/') !== 0) routePath = `/${routePath}`;
        Logging.logSilly(`_initSchemaRoutes:register [${route.verb.toUpperCase()}] ${routePath}`);
        express[route.verb](routePath, this._preRouteMiddleware, (req: Request, res: Response, next: NextFunction) => {
          req.context.pathSpec = pathSpec;
          return route.exec(req, res).catch(next);
        });
      });
    });
  }

  async _authenticateToken(req: Request, res: Response, next: NextFunction) {
    await this._middlewareHelper._authenticateToken(req, res, next);
  }

  _configCrossDomain(req: Request, res: Response, next: NextFunction) {
    this._middlewareHelper._configCrossDomain(req, res, next);
  }

  logErrors(err, req: Request, res: Response, next: NextFunction) {
    this._middlewareHelper.logErrors(err, req, res, next);
  }

  _getCoreRoutes() {
    return CoreRoutes;
  }

  async _setupLambdaEndpoints() {
    await this._lambdaSetupHelper._setupLambdaEndpoints();
  }

  async _queueLambdaAPIExecution(endpointOrId: string, apiPath, req: Request) {
    return await this._lambdaSetupHelper._queueLambdaAPIExecution(endpointOrId, apiPath, req);
  }

  async loadTokens() {
    await this._tokensHelper.loadTokens();
  }

  async _getProvidedToken(req: Request) {
    return await this._tokensHelper._getProvidedToken(req);
  }

  _lookupToken(tokens: any[], value: string) {
    return this._tokensHelper._lookupToken(tokens, value);
  }
}

export default Routes;
