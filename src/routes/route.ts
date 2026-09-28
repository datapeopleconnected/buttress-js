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
import Stream from 'node:stream';

import { Request, Response } from 'express';
import { RedisClientType } from '@redis/client';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Logging from '../helpers/logging.js';
import Model, { ModelManager } from '../model/index.js';
import * as Helpers from '../helpers/index.js';
import { Schema } from '../helpers/schema.js';

import NodeRedisPubsub from '../services/nrp.js';
import { RESTActivity } from '../types/bjs-nrp-objects.js';
import ActivitySchemaModel from '../model/core/activity.js';
import TokenSchemaModel from '../model/core/token.js';
import StandardModel from '../model/type/standard.js';
import { App } from '../model/core/app.js';
import { Services } from '../bootstrap.js';

export interface NotifyLambdaPathChangeMessage {
  paths: string[];
  values: unknown[];
  collection: string;
  // The app whose data changed. Only its lambdas may see the change.
  appId: string;
}

interface PathMutationItem {
  path?: string;
  value?: unknown;
}

interface BulkPathMutationItem {
  id: string;
  body: PathMutationItem | PathMutationItem[];
  // Set by UpdateMany._validate: true, or why the item was refused.
  validation?: unknown;
}

type PathLambdaBody = PathMutationItem | PathMutationItem[] | BulkPathMutationItem[] | string[] | unknown;

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

  _redisClient: RedisClientType;

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

    this._redisClient = services.get('redisClient') as RedisClientType;
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
    Logging.logTimer(
      `${req.method} ${req.originalUrl || req.url} ${req.ip}`,
      req.context.timer,
      Logging.Constants.LogLevel.DEBUG,
      req.context.id,
    );
    Logging.logTimer('Route:exec:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    this._timer = req.context.timer;

    if (!this._exec) {
      Logging.logTimer(
        'Route:exec:end-no-exec-defined',
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );
      throw new Helpers.Errors.RequestError(500, 'Tried to exec route but no exec function defined');
    }

    await this._authenticate(req, res);

    req.context.timings.validate = req.context.timer.interval;
    Logging.logTimer('Route:exec:validate:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    const validate = await this._validate(req, res);
    Logging.logTimer('Route:exec:validate:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

    // Before the change runs, so the owner of a record it deletes can still be found.
    req.context.changeOwners = await this._findChangeOwners(req);

    req.context.timings.exec = req.context.timer.interval;
    Logging.logTimer('Route:exec:exec:start', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);
    const result = await this._exec(req, res, validate);
    Logging.logTimer('Route:exec:exec:end', req.context.timer, Logging.Constants.LogLevel.SILLY, req.context.id);

    // Send the result back to the client and resolve the request from
    // this point onward you should treat the request as furfilled.
    if (result instanceof Stream.Readable && result.readable) {
      result.on('bjs-stream-status', (data) => (this._nrp ? req.context.bjsReqStatus(data, this._nrp) : null));

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

      if (this._nrp) req.context.bjsReqStatus({ status: 'ready' }, this._nrp);
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
  async _respond(req: Request, res: Response, result: unknown) {
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

    Logging.logTimer(
      `_respond:end ${req.context.pathSpec}`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );
    // Logging.logTimerException(`PERF: DONE: ${req.context.pathSpec}`, req.context.timer, 0.05, req.context.id);

    return result;
  }

  _logActivity(req, _res) {
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
      .then(
        Logging.Promise.logTimer(
          '_addLogActivity:end',
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        ),
      )
      .catch((e) => Logging.logError(e, req.context.id));
  }

  /**
   * Handle broadcasting the result by app policies
   * @param {Object} req
   * @param {Object} res
   * @param {*} result
   */
  async _boardcastData(req: Request, res: Response, result: unknown) {
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
   * @param {Request} req
   * @param {Response} res
   * @param {unknown} result
   * @param {string} path
   * @param {boolean} isSuper
   */
  async _broadcast(req: Request, _res: Response, result: unknown, path: string, isSuper = false) {
    const isReadStream = result instanceof Stream.Readable && result.readable;
    Logging.logTimer(
      `_broadcast:start isReadStream:${isReadStream} path:${path} isSuper:${isSuper}`,
      req.context.timer,
      Logging.Constants.LogLevel.SILLY,
      req.context.id,
    );

    const emit = (_result: unknown) => {
      if (this.activityBroadcast === true) {
        this._nrp?.emit(
          'rest:activity',
          JSON.stringify({
            title: this.activityTitle,
            description: this.activityDescription,
            visibility: this.activityVisibility,
            broadcast: this.activityBroadcast,
            path: path,
            pathSpec: req.context.pathSpec || '',
            verb: this.verb,
            permissions: this.permissions,
            params: req.params,
            timestamp: new Date(),
            response: _result,
            clientSessionId: req.context.clientSessionId,
            user: req.context.authUser ? req.context.authUser.id : '',
            appAPIPath: req.context.authApp ? req.context.authApp.apiPath : '',
            appId: req.context.authApp ? req.context.authApp.id : '',
            isSuper: isSuper,
            isCoreSchema: this.core,
            schemaName: this.schemaName || '',
            deletedEntities: isSuper ? undefined : req.context.deletedEntities,
          } satisfies RESTActivity),
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
   * Keeps the entities a delete is about to remove on the request, as they are stored rather than as the caller may
   * read them. The SPR can't look up an entity once it has gone, so they go to it with the scoped activity, for it to
   * check the delete against the policies of each token it could go to.
   * @param {Request} req
   * @param {unknown[]} ids
   */
  async _keepEntitiesBeingDeleted(req: Request, ids: unknown[]) {
    const model = await this.routeModel();
    // A combined (federated) model's find is async; a standard model's gives the stream itself.
    const stored = await model.find(model.parseQuery({ id: { $in: ids } }), {});
    req.context.deletedEntities = await Helpers.streamAll<Record<string, unknown>>(stored);
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
        Logging.logDebug(
          `Blocked path mutation lambda ${req.context.authLambda.name} from triggering other path mutations`,
        );
        return;
      }
    }

    let paths: string[] = [];
    let values: unknown[] = [];
    let body: PathLambdaBody = null;

    const isPathMutationItem = (value: unknown): value is PathMutationItem =>
      !!value && typeof value === 'object' && ('path' in value || 'value' in value);

    const isBulkPathMutationItem = (value: unknown): value is BulkPathMutationItem =>
      !!value && typeof value === 'object' && 'id' in value && 'body' in value;

    try {
      if (typeof req.body === 'string') {
        body = JSON.parse(req.body) as PathLambdaBody;
      } else {
        body = req.body as PathLambdaBody;
      }
    } catch (_err) {
      body = req.body as PathLambdaBody;
    }

    const id = req.params.id;

    if (this.verb === Constants.Verbs.POST) {
      if (req.context.pathSpec?.includes(Constants.BulkRequests.BULK_PUT)) {
        if (Array.isArray(body)) {
          body.forEach((item) => {
            if (!isBulkPathMutationItem(item)) return;
            // A refused item changed nothing.
            if (item.validation !== undefined && item.validation !== true) return;

            if (Array.isArray(item.body)) {
              item.body.forEach((obj) => {
                if (!isPathMutationItem(obj) || !obj.path) return;
                paths.push(`${schemaName}.${item.id}.${obj.path}`);
                values.push(obj.value);
              });
            } else if (isPathMutationItem(item.body) && item.body.path) {
              paths.push(`${schemaName}.${item.id}.${item.body.path}`);
              values.push(item.body.value);
            }
          });
        }
      } else if (req.context.pathSpec?.includes(Constants.BulkRequests.BULK_DEL)) {
        if (Array.isArray(body)) {
          body.forEach((deleteId) => {
            if (typeof deleteId === 'string') {
              paths.push(`${schemaName}.${deleteId}`);
            }
          });
        }
      } else {
        paths.push(schemaName);
        values.push(body);
      }
    }

    if (this.verb === Constants.Verbs.DEL) {
      if (id) {
        paths.push(`${schemaName}.${id}`);
      } else if (Array.isArray(body)) {
        body.forEach((item) => {
          if (isPathMutationItem(item) && item.path) {
            paths.push(`${schemaName}.${item.path}`);
          }
        });
      } else {
        paths.push(schemaName);
      }
    }
    if (this.verb === Constants.Verbs.PUT) {
      const putBody = Array.isArray(body) ? body : [body];
      putBody.forEach((item) => {
        if (!isPathMutationItem(item) || !item.path) return;
        paths.push(`${schemaName}.${id}.${item.path}`);
        values.push(item.value);
      });
    }

    // Each path once, where it was first seen. Where there's a value for each path, the path keeps the last value
    // written to it, so paths and values still line up.
    const hasValues = values.length === paths.length;
    const dedupedPaths: string[] = [];
    const dedupedValues: unknown[] = [];
    paths.forEach((path, idx) => {
      const seenIdx = dedupedPaths.indexOf(path);
      if (seenIdx === -1) {
        dedupedPaths.push(path);
        if (hasValues) dedupedValues.push(values[idx]);
      } else if (hasValues) {
        dedupedValues[seenIdx] = values[idx];
      }
    });
    paths = dedupedPaths;
    if (hasValues) values = dedupedValues;

    // Each change goes to the app that owns the data. A schema route's data belongs to the route's app, whichever
    // app's token made the change. A core record belongs to the app found for it before the change, and anything
    // else, such as a create, to the requesting app.
    const requestingAppId = this.appId ?? req.context.authApp?.id;
    const messages = new Map<string, NotifyLambdaPathChangeMessage>();
    paths.forEach((path, idx) => {
      const recordId = path.startsWith(`${schemaName}.`) ? path.slice(schemaName.length + 1).split('.')[0] : '';
      const appId = req.context.changeOwners?.get(recordId) ?? requestingAppId;
      if (!appId) return;

      const key = String(appId);
      if (!messages.has(key)) messages.set(key, { paths: [], values: [], collection: schemaName, appId: key });
      const message = messages.get(key) as NotifyLambdaPathChangeMessage;
      message.paths.push(path);
      if (hasValues) message.values.push(values[idx]);
    });

    messages.forEach((message) => this._nrp?.emit('rest:worker:notifyLambdaPathChange', JSON.stringify(message)));
  }

  /**
   * The apps that own the core records a request changes, by record id. An app record is its own owner, and any other
   * core record belongs to its _appId. A schema route's data belongs to the route's app, so it needs none.
   */
  async _findChangeOwners(req: Request): Promise<Map<string, string> | undefined> {
    if (this.appId || !this.schemaName) return undefined;
    if (this.verb === Constants.Verbs.GET || this.verb === Constants.Verbs.SEARCH) return undefined;

    const owners = new Map<string, string>();
    const recordIds = this._changedRecordIds(req);
    if (recordIds.length < 1) return owners;

    if (this.schemaName === Model.CoreModels.App.Schema.name) {
      recordIds.forEach((id) => owners.set(id, id));
      return owners;
    }

    const model = Model.getCoreModelBySchemaName(this.schemaName);
    if (!model) return owners;

    for (const id of recordIds) {
      let record: { _appId?: unknown } | null = null;
      try {
        record = (await model.findOne({ _id: model.createId(id) })) as { _appId?: unknown } | null;
      } catch (_err) {
        // Not an id this model can look up; nothing to find.
      }
      if (record?._appId) owners.set(id, String(record._appId));
    }

    return owners;
  }

  // The ids of the records a request names, the same way _checkBasedPathLambda reads them.
  _changedRecordIds(req: Request): string[] {
    const ids: unknown[] = [];
    if (this.verb === Constants.Verbs.PUT || this.verb === Constants.Verbs.DEL) {
      ids.push(req.params.id);
    } else if (this.verb === Constants.Verbs.POST && Array.isArray(req.body)) {
      if (req.context.pathSpec?.includes(Constants.BulkRequests.BULK_PUT)) {
        req.body.forEach((item) => ids.push(item?.id));
      } else if (req.context.pathSpec?.includes(Constants.BulkRequests.BULK_DEL)) {
        ids.push(...req.body);
      }
    }

    return [...new Set(ids.filter((id) => typeof id === 'string' && id))] as string[];
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
      if (!req.context.token) {
        this.log('EAUTH: INVALID TOKEN', Logging.Constants.LogLevel.ERR, req.context.id);
        Logging.logTimer(
          '_authenticate:end-invalid-token',
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
        return reject(new Helpers.Errors.RequestError(401, 'invalid_token'));
      }

      if (this.authType && authTypeIdx(req.context.token.type) < authTypeIdx(this.authType)) {
        this.log(
          `EAUTH: INSUFFICIENT AUTHORITY ${req.context.token.type} is not equal to ${this.authType}`,
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

      // Every route acts on the token's own app; ?apiPath= isn't honoured. Refuse anything but the token's own app,
      // including ?apiPath= given more than once (an array), rather than silently act on the token's app instead.
      const apiPath = req.query?.apiPath;
      const authApiPath = req.context.authApp?.apiPath;
      if (apiPath !== undefined && apiPath !== '' && authApiPath !== undefined && apiPath !== authApiPath) {
        this.log(`EAUTH: ?apiPath=${apiPath} names another app than ${authApiPath}`, Logging.Constants.LogLevel.ERR);
        return reject(
          new Helpers.Errors.RequestError(
            400,
            `apiPath_not_supported: requests act on the app of the token (${authApiPath})`,
          ),
        );
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
      Logging.logTimer(
        `_authenticate:start-app-routes`,
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );

      // BYPASS schema checks for app tokens
      if (req.context.token.type === 'app') {
        Logging.logTimer(
          '_authenticate:end-app-token',
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
        resolve(req.context.token);
        return;
      }

      // NOT GOOD
      if (req.context.token.type === 'dataSharing') {
        Logging.logTimer(
          '_authenticate:end-app-token',
          req.context.timer,
          Logging.Constants.LogLevel.SILLY,
          req.context.id,
        );
        resolve(req.context.token);
        return;
      }

      Logging.logTimer(
        `_authenticate:end-app-routes`,
        req.context.timer,
        Logging.Constants.LogLevel.SILLY,
        req.context.id,
      );

      resolve(req.context.token);
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
