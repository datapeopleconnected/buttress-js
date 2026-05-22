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

import Stream from 'node:stream';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Logging from '../helpers/logging.js';
import Model, { ModelManager } from '../model/index.js';
import * as Helpers from '../helpers/index.js';
import { Schema } from '../helpers/schema.js';

import RemoteModel from '../model/type/remote.js';

import NodeRedisPubsub from '../services/nrp.js';
import { RESTActivity } from '../types/bjs-nrp-objects.js';
import ActivitySchemaModel from '../model/core/activity.js';
import TokenSchemaModel from '../model/core/token.js';
import StandardModel from '../model/type/standard.js';
import { App } from '../model/core/app.js';
import { Services } from '../bootstrap.js';

export interface NotifyLambdaPathChangeMessage {
  paths: string[];
  values: any[];
  collection: string;
}

/**
 */
// var _otp = OTP.create({
//   length: 12,
//   mode: OTP.Constants.Mode.ALPHANUMERIC,
//   salt: Config.RHIZOME_OTP_SALT,
//   tolerance: 3
// });

let _app = null;
let _io = null;

/**
 * @type {{Auth: {
 *          NONE: number,
 *          USER: number,
 *          ADMIN: number,
 *          SUPER: number},
 *         Permissions: {
 *          NONE: string,
 *          ADD: string,
 *          READ: string,
 *          WRITE: string,
 *          LIST: string,
 *          DELETE: string,
 *          ALL: string
 *          },
 *         Verbs: {
 *          GET: string,
 *          POST: string,
 *          PUT: string,
 *          DEL: string
 *          }}}
 */
const Constants = {
  Type: {
    USER: 'user',
    DATASHARING: 'dataSharing',
    LAMBDA: 'lambda',
    APP: 'app',
    SYSTEM: 'system',
  },
  Permissions: {
    NONE: '',
    ADD: 'add',
    READ: 'read',
    WRITE: 'write',
    LIST: 'list',
    DELETE: 'delete',
    SEARCH: 'search',
    COUNT: 'count',
    ALL: '*',
  },
  Verbs: {
    GET: 'get',
    POST: 'post',
    PUT: 'put',
    DEL: 'delete',
    SEARCH: 'search',
  },
  BulkRequests: {
    BULK_PUT: '/bulk/update',
    BULK_DEL: '/bulk/delete',
  },
};

const AuthTypeOrder = Object.values(Constants.Type);
const authTypeIdx = (type) => AuthTypeOrder.indexOf(type);

export default class Route {
  verb: string = Constants.Verbs.GET;
  authType: string = Constants.Type.USER;
  permissions: string = Constants.Permissions.READ;

  activity: boolean = true;
  activityBroadcast: boolean = false;
  activityVisibility: string = Model.getCoreModel(ActivitySchemaModel).Constants.Visibility.PRIVATE;
  activityTitle: string = 'Private Activity';
  activityDescription: string = '';

  slowLogging: boolean = Config.logging.slow === 'TRUE';
  slowLoggingTime: number = parseFloat(Config.logging.slowTime);

  timingChunkSample: number = 250;

  core: boolean = true;
  redactResults: boolean = true;
  addSourceId: boolean = false;

  // model: T;
  appId?: string;
  schemaName?: string;

  paths: string[];

  name: string;

  protected _nrp?: NodeRedisPubsub;
  protected _modelManager?: ModelManager;

  _redisClient: any;

  _timer?: Helpers.Timer;

  constructor(paths: string | string[], name: string, services: Services, schema: Schema | null, app?: App) {
    // this.model = model;
    this.schemaName = schema?.name;
    this.appId = app?.id;

    this.paths = Array.isArray(paths) ? paths : [paths];

    this.name = name;

    this._nrp = services.get('nrp') as NodeRedisPubsub;
    if (!this._nrp) throw new Error('Route: NRP not found in services');

    this._modelManager = services.get('modelManager') as ModelManager;
    if (!this._modelManager) throw new Error('Route: ModelManager not found in services');

    this._redisClient = services.get('redisClient');
  }

  // Quickly apply some common schemaRoute configurations, will typically be called
  // straight after the constructor super call.
  __configureSchemaRoute() {
    this.core = false;
    this.redactResults = true;
    this.addSourceId = true;
  }

  async _validate(_req: Request, _res: Response): Promise<unknown> {
    throw new Error('Route:_validate not implemented');
  }

  async _exec(_req: Request, _res: Response, _validate: unknown): Promise<unknown> {
    throw new Error('Route:_exec not implemented');
  }

  async routeModel<T extends StandardModel>() {
    if (!this.schemaName) throw new Error('Route:model called but no schemaName defined');

    if (this.appId) {
      return Model.getAppModel<T>(this.appId, this.schemaName);
    } else {
      return Model.getCoreModelByName<T>(this.schemaName);
    }
  }

  /**
   * @param {Object} req - ExpressJS request object
   * @param {Object} res - ExpresJS response object
   * @return {Promise} - Promise is fulfilled once execution has completed
   */
  async exec(req: Request, res: Response) {
    const ip = req.ip || req._remoteAddress || (req.connection && req.connection.remoteAddress) || undefined;
    Logging.logTimer(
      `${req.method} ${req.originalUrl || req.url} ${ip}`,
      req.context.timer,
      Logging.Constants.LogLevel.DEBUG,
      req.context.id,
    );
    Logging.logTimer('Route:exec:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    this._timer = req.context.timer;

    if (!this._exec) {
      Logging.logTimer('Route:exec:end-no-exec-defined', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
      throw new Helpers.Errors.RequestError(500, 'Tried to exec route but no exec function defined');
    }

    await this._authenticate(req, res);

    req.context.timings.validate = req.context.timer.interval;
    Logging.logTimer('Route:exec:validate:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    const validate = await this._validate(req, res);
    Logging.logTimer('Route:exec:validate:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

    req.context.timings.exec = req.context.timer.interval;
    Logging.logTimer('Route:exec:exec:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    const result = await this._exec(req, res, validate);
    Logging.logTimer('Route:exec:exec:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

    // Send the result back to the client and resolve the request from
    // this point onward you should treat the request as furfilled.
    if (result instanceof Stream.Readable && result.readable) {
      result.on('bjs-stream-status', (data) => req.context.bjsReqStatus(data, this._nrp));

      const resStream = new Stream.PassThrough({ objectMode: true });
      const broadcastStream = new Stream.PassThrough({ objectMode: true });

      result.pipe(resStream);

      if (this.verb !== Constants.Verbs.GET && this.verb !== Constants.Verbs.SEARCH) {
        result.pipe(broadcastStream);
      }

      // await Plugins.do_action('route-add-many:_exec', this.schema, results);

      await this._respond(req, res, resStream);

      await this._logActivity(req, res);

      await this._boardcastData(req, res, broadcastStream);

      req.bjsReqStatus({ status: 'ready' }, this._nrp);
    } else {
      // await Plugins.do_action('route-add-many:_exec', this.schema, results);

      await this._respond(req, res, result);

      await this._logActivity(req, res);

      await this._boardcastData(req, res, result);
    }

    Logging.logTimer(`Route:exec:end ${res.statusCode}`, this._timer, Logging.Constants.LogLevel.SILLY, req.context.id);
  }

  /**
   * Set the responce for a request
   * @param {Object} req
   * @param {Object} res
   * @param {*} result
   * @return {*} result
   */
  async _respond(req: Request, res: Response, result) {
    req.context.timings.respond = req.context.timer.interval;

    const isReadStream = result instanceof Stream.Readable && result.readable;

    Logging.logTimer(
      `_respond:start isReadStream:${isReadStream} redactResults:${this.redactResults}`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    if (isReadStream) {
      let chunkCount = 0;
      const stringifyStream = new Helpers.JSONStringifyStream({}, (chunk) => {
        chunkCount++;

        if (chunkCount % this.timingChunkSample === 0) req.context.timings.stream.push(req.context.timer.interval);
        return this.redactResults
          ? Helpers.Schema.prepareSchemaResult(chunk, this.addSourceId ? req.context.authApp?.id : null)
          : chunk;
      });

      res.set('Content-Type', 'application/json');

      Logging.logTimer(`_respond:start-stream`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

      result.once('end', () => {
        // Logging.logTimerException(`PERF: STREAM DONE: ${req.context.pathSpec}`, req.context.timer, 0.05, req.context.id);
        Logging.logTimer(
          `_respond:end-stream chunks:${chunkCount}`,
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
        if (this._nrp) req.context.bjsReqClose(this._nrp);
        this._close(req);
      });

      result.pipe(stringifyStream).pipe(res);

      return result;
    }

    if (this.redactResults) {
      res.json(Helpers.Schema.prepareSchemaResult(result, this.addSourceId ? req.context.authApp?.id : null));
    } else {
      res.json(result);
    }

    this._close(req);

    Logging.logTimer(`_respond:end ${req.context.pathSpec}`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    // Logging.logTimerException(`PERF: DONE: ${req.context.pathSpec}`, req.context.timer, 0.05, req.context.id);

    return result;
  }

  _logActivity(req, res) {
    req.context.timings.logActivity = req.context.timer.interval;
    Logging.logTimer('_logActivity:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    if (this.verb === Constants.Verbs.GET) {
      Logging.logTimer('_logActivity:end-get', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
      return;
    }
    if (this.verb === Constants.Verbs.SEARCH) {
      Logging.logTimer('_logActivity:end-search', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
      return;
    }

    // Fire and forget
    if (this.activity) {
      this._addLogActivity(req, req.context.pathSpec, this.verb);
    }

    Logging.logTimer('_logActivity:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
  }

  _addLogActivity(req: Request, path: string, verb: string) {
    Logging.logTimer('_addLogActivity:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    // TODO: activity should pass back a stripped version of the activity object.
    return Model.getCoreModel(ActivitySchemaModel)
      .add({
        activityTitle: this.activityTitle,
        activityDescription: this.activityDescription,
        activityVisibility: this.activityVisibility,
        path: path,
        verb: verb,
        permissions: this.permissions,
        // auth: this.auth,
        params: req.params,
        req: req,
        res: {},
      })
      .then(Logging.Promise.logTimer('_addLogActivity:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id))
      .catch((e) => Logging.logError(e, req.context.id));
  }

  /**
   * Handle broadcasting the result by app policies
   * @param {Object} req
   * @param {Object} res
   * @param {*} result
   */
  async _boardcastData(req: Request, res: Response, result) {
    req.context.timings.boardcastData = req.context.timer.interval;
    Logging.logTimer('_boardcastData:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

    if (this.verb === Constants.Verbs.GET || this.verb === Constants.Verbs.SEARCH) {
      Logging.logTimer('_boardcastData:end-get', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
      return;
    }

    const pathArr = req.path.split('/');
    if (pathArr[0] === '') pathArr.shift();
    if (req.context.authApp?.apiPath && pathArr.indexOf(req.context.authApp.apiPath) === 0) {
      pathArr.shift();
    }

    // Replace API version prefix
    const path = `/${pathArr.join('/')}`.replace(Config.app.apiPrefix, '');

    this._broadcast(req, res, result, path, true);

    this._broadcast(req, res, result, path);

    await this._checkBasedPathLambda(req);

    Logging.logTimer('_boardcastData:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
  }

  /**
   * Handle result based on the collection and broadcast
   * @param {*} req
   * @param {*} res
   * @param {*} result
   * @param {*} path
   * @param {boolean} isSuper
   */
  async _broadcast(req: Request, _res: Response, result, path: string, isSuper = false) {
    const isReadStream = result instanceof Stream.Readable && result.readable;
    Logging.logTimer(
      `_broadcast:start isReadStream:${isReadStream} path:${path} isSuper:${isSuper}`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    const emit = (_result) => {
      if (this.activityBroadcast === true) {
        this._nrp?.emit(
          'rest:activity',
          JSON.stringify({
            title: this.activityTitle,
            description: this.activityDescription,
            visibility: this.activityVisibility,
            broadcast: this.activityBroadcast,
            path: path,
            pathSpec: req.context.pathSpec,
            verb: this.verb,
            permissions: this.permissions,
            params: req.params,
            timestamp: new Date(),
            response: _result,
            user: req.context.authUser ? req.context.authUser.id : '',
            appAPIPath: req.context.authApp ? req.context.authApp.apiPath : '',
            appId: req.context.authApp ? req.context.authApp.id : '',
            isSuper: isSuper,
            isCoreSchema: this.core,
            schemaName: this.schemaName,
          } as RESTActivity),
        );
      } else {
        // Trigger the emit activity so we can update the stats namespace
      }
    };

    if (isReadStream) {
      result.on('data', (data) => emit(Helpers.Schema.prepareSchemaResult(data, req.context.authApp?.id)));
      Logging.logTimer('_broadcast:end-stream', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
      return;
    }

    emit(Helpers.Schema.prepareSchemaResult(result, req.context.authApp?.id));
    Logging.logTimer('_broadcast:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
  }

  /**
   * Triggers path based lambdas
   * @param {Object} req
   */
  _checkBasedPathLambda(req: Request) {
    // NOTE: Do we not want to receive updates on core schema?
    // TODO: There should be a restriction here to scope to the application.
    if (!this.schemaName) return;

    const schemaName = this.schemaName;
    const isLambdaChange = req.context.token?.type === Model.getCoreModel(TokenSchemaModel).Constants.Type.LAMBDA;
    if (isLambdaChange) {
      // If the current lambda is a path mutation, we don't want to trigger other path mutations
      // not great but we'll just block all lambdas that have a pathMutation trigger
      if (req.context.authLambda?.trigger.find((t) => t.type === 'PATH_MUTATION')) {
        Logging.logDebug(`Blocked path mutation lambda ${req.context.authLambda.name} from triggering other path mutations`);
        return;
      }
    }

    let paths: string[] = [];
    const values: any[] = [];
    let body: any = null;

    try {
      body = JSON.parse(req.body);
    } catch (e) {
      body = req.body;
    }

    const id = req.params.id;

    if (this.verb === Constants.Verbs.POST) {
      if (req.context.pathSpec?.includes(Constants.BulkRequests.BULK_PUT)) {
        body.forEach((item) => {
          if (Array.isArray(item.body)) {
            item.body.forEach((obj) => {
              paths.push(`${schemaName}.${item.id}.${obj.path}`);
              item.body.forEach((i) => values.push(i.value));
            });
          } else {
            paths.push(`${schemaName}.${item.id}.${item.body.path}`);
            values.push(item.body.value);
          }
        });
      } else if (req.context.pathSpec?.includes(Constants.BulkRequests.BULK_DEL)) {
        body.forEach((id) => paths.push(`${schemaName}.${id}`));
      } else {
        paths.push(schemaName);
        values.push(body);
      }
    }

    if (this.verb === Constants.Verbs.DEL) {
      if (id) {
        paths.push(`${schemaName}.${id}`);
      } else if (Array.isArray(body)) {
        body.forEach((item) => paths.push(`${schemaName}.${item.path}`));
      } else {
        paths.push(schemaName);
      }
    }
    if (this.verb === Constants.Verbs.PUT) {
      if (!Array.isArray(body)) body = [body];
      body.forEach((item) => {
        if (!item.path) return;
        paths.push(`${schemaName}.${id}.${item.path}`);
        values.push(item.value);
      });
    }

    paths = paths.filter((v, idx, arr) => arr.indexOf(v) === idx);
    if (paths.length > 0) {
      const message: NotifyLambdaPathChangeMessage = {
        paths: paths,
        values: values,
        collection: schemaName,
      };

      this._nrp?.emit('rest:worker:notifyLambdaPathChange', JSON.stringify(message));
    }
  }

  /**
   * @param {Object} req - ExpressJS request object
   * @param {Object} res - ExpresJS response object
   * @return {Promise} - Promise is fulfilled once the authentication is completed
   * @private
   */
  _authenticate(req: Request, _res: Response) {
    req.context.timings.authenticate = req.context.timer.interval;
    return new Promise((resolve, reject) => {
      if (!req.token) {
        this.log('EAUTH: INVALID TOKEN', Logging.Constants.LogLevel.ERR, req.context.id);
        Logging.logTimer('_authenticate:end-invalid-token', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
        return reject(new Helpers.Errors.RequestError(401, 'invalid_token'));
      }

      if (this.authType && authTypeIdx(req.token.type) < authTypeIdx(this.authType)) {
        this.log(
          `EAUTH: INSUFFICIENT AUTHORITY ${req.token.type} is not equal to ${this.authType}`,
          Logging.Constants.LogLevel.ERR,
          req.context.id,
        );
        Logging.logTimer(
          '_authenticate:end-insufficient-authority',
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
        return reject(new Helpers.Errors.RequestError(401, 'insufficient_authority'));
      }
      /**
       * @description Route:
       *  '*' - all routes (SUPER)
       *  'route' - specific route (ALL)
       *  'route/subroute' - specific route (ALL)
       *  'route/*' name plus all children (ADMIN)
       * @TODO Improve the pattern matching granularity ie like Glob
       * @TODO Support Regex in specific ie match routes like app/:id/permission
       */
      Logging.logTimer(`_authenticate:start-app-routes`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

      // BYPASS schema checks for app tokens
      if (req.token.type === 'app') {
        Logging.logTimer('_authenticate:end-app-token', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
        resolve(req.token);
        return;
      }

      // NOT GOOD
      if (req.token.type === 'dataSharing') {
        Logging.logTimer('_authenticate:end-app-token', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
        resolve(req.token);
        return;
      }

      Logging.logTimer(`_authenticate:end-app-routes`, req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

      resolve(req.token);
    });
  }

  /**
   * @param {string} permissionSpec -
   * @return {boolean} - true if authorised
   * @private
   */
  _matchPermission(permissionSpec) {
    if (permissionSpec === '*' || permissionSpec === this.permissions) {
      return true;
    }

    return false;
  }

  /**
   * @param {string} log - log text
   * @param {enum} level - NONE, ERR, WARN, INFO
   */
  log(log: string, level?: string, reqId?: string) {
    level = level || Logging.Constants.LogLevel.INFO;
    Logging.log(log, level, reqId);
  }

  /**
   * Called when we expect the request to be closed
   * @param {object} req - The request object to be compared to
   * @private
   */
  _close(req) {
    req.context.timings.close = req.context.timer.interval;
    if (this.slowLogging && req.context.timings.close > this.slowLoggingTime) {
      Logging.logError(`${req.method} ${req.url} SLOW REQUEST ${JSON.stringify(req.context.timings)}`, req.context.id);
    }
  }

  static set app(app) {
    _app = app;
  }
  static get app() {
    return _app;
  }
  static set io(io) {
    _io = io;
  }
  static get io() {
    return _io;
  }
  static get Constants() {
    return Constants;
  }

  /**
   * @return {enum} - returns the LogLevel enum (convenience)
   */
  static get LogLevel() {
    return Logging.Constants.LogLevel;
  }
}
