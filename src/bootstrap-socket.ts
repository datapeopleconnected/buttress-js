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
import net from 'node:net';
import http from 'node:http';

import createConfig from '@dpc/node-env-obj';

import Express from 'express';
import { createClient, RedisClientType } from '@redis/client';

import { Server as sio, Socket as sioSocket, DefaultEventsMap } from 'socket.io';
import sioClient, { Socket as sioClientSocket } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';

import Bootstrap, { LocalProcessMessage } from './bootstrap.js';

const Config = createConfig() as unknown as Config;

import Model from './model/index.js';
import * as Helpers from './helpers/index.js';
import Logging from './helpers/logging.js';
import { redactUrl, tokenFingerprint } from './helpers/redact.js';
import { dataSharingDestinationProblem } from './helpers/egress.js';

import AccessControl from './access-control/index.js';

import * as Schema from './helpers/schema.js';

import Datastore from './datastore/index.js';
import { Datastore as DatastoreInstance } from './datastore/index.js';
import { CONNECTED_TOKEN_HEARTBEAT_MS, PolicyCache } from './services/policy-cache.js';
import type {
  AppSchemaUpdatedMessage,
  DataShareActivatedMessage,
  SocketConnectionMessage,
  SocketHeartbeatMessage,
} from './services/nrp.js';

import { DataShareSocketSharePayload, RESTActivity } from './types/bjs-nrp-objects.js';

import TokenSchemaModel, { Token } from './model/core/token.js';
import AppSchemaModel from './model/core/app.js';
import AppDataSharingSchemaModel, { AppDataSharing } from './model/core/app-data-sharing.js';
import UserSchemaModel from './model/core/user.js';
interface RequestStatusMessage {
  id: string;
  status: 'started' | 'completed' | 'failed';
}
interface RequestEndMessage {
  id: string;
}
interface RequestSubscribeMessage {
  id: string;
}

// Set on an app namespace socket when it connects
interface SocketData {
  type: string;
  tokenId: string;
  dataShareId?: string;
  userId?: string;
}
type AppSocket = sioSocket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The activity to relay into this instance for one a data share peer sent, for one of the app's remote schemas. Only
 * the fields an activity has are taken from the peer, and it's always the app's own, never a system token's copy or a
 * core schema's; the peer's user and client session mean nothing here. Anything that isn't a write gives null.
 */
export const relayedDataShareActivity = (
  remote: unknown,
  app: { id: string; apiPath: string },
  schemaName: string,
): RESTActivity | null => {
  if (!isPlainObject(remote)) return null;
  const { verb } = remote;
  if (verb !== 'post' && verb !== 'put' && verb !== 'delete') return null;

  const text = (value: unknown, otherwise = '') => (typeof value === 'string' ? value : otherwise);
  const deletedEntities = Array.isArray(remote.deletedEntities)
    ? remote.deletedEntities.filter(isPlainObject)
    : undefined;

  return {
    title: text(remote.title),
    description: text(remote.description),
    visibility: text(remote.visibility, 'public'),
    broadcast: remote.broadcast !== false,
    path: text(remote.path),
    pathSpec: text(remote.pathSpec),
    verb,
    permissions: text(remote.permissions),
    params: isPlainObject(remote.params) ? remote.params : {},
    timestamp: (typeof remote.timestamp === 'string' ? remote.timestamp : new Date().toISOString()) as unknown as Date,
    response: remote.response,
    user: '',
    clientSessionId: null,
    appAPIPath: app.apiPath,
    appId: app.id,
    isSuper: false,
    // Set, so the activity isn't relayed on again
    isSameApp: app.apiPath === remote.appAPIPath,
    isCoreSchema: false,
    schemaName,
    ...(deletedEntities ? { deletedEntities } : {}),
  };
};

export default class BootstrapSocket extends Bootstrap {
  // Each app's connections to the instances it shares data with: one for each agreement, with the id of the token the
  // agreement gives its partner, which the agreement's policy selects
  private _dataShareSockets: {
    [key: string]: Array<{ socket: sioClientSocket; tokenId: string; dataShareId: string }>;
  } = {};

  private _redisClient?: RedisClientType;
  // Renews the tokens this process has sockets open for, so the SPR keeps them connected
  private _socketHeartbeat?: NodeJS.Timeout;
  private _redisClientEmitter?: RedisClientType;
  private _redisClientIOPub?: RedisClientType;
  private _redisClientIOSub?: RedisClientType;

  // private _processResQueue: any;

  private _requestSockets: Helpers.ExpireMap<string, AppSocket>;

  emitter?: Emitter;
  io?: sio<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

  isPrimary: boolean;

  logicalOperator: string[];

  private _socketExpressServer: http.Server | null;

  private _mainServer: net.Server | null;

  private _primaryDatastore: DatastoreInstance;

  constructor() {
    super();

    this._dataShareSockets = {};

    this.isPrimary = Config.sio.app === 'primary';

    this._socketExpressServer = null;

    this._mainServer = null;

    this._primaryDatastore = Datastore.createInstance(Config.datastore, true);

    // A map that holds reference to sockets which have subscribed to a request
    // the map keys will expire after 5 minutes.
    this._requestSockets = new Helpers.ExpireMap(5 * 60 * 1000);

    this.logicalOperator = ['$or', '$and'];
  }

  override async init() {
    await super.init();

    await this._primaryDatastore.connect();

    if (!this.__nrp) throw new Error('No NRP instance');

    // Register some services.
    this.__services.set('modelManager', Model);

    this._redisClient = createClient({
      url: Config.redis.url,
    });
    await this._redisClient.connect();

    this.__services.set('policyCache', new PolicyCache(this._redisClient, Model));

    // Call init on our singletons (this is mainly so they can setup their redis-pubsub connections)
    await Model.init(this.__services);
    await AccessControl.init(this.__nrp, this.__services.get('policyCache') as PolicyCache);

    // Init models
    await Model.initCoreModels();
    await Model.initSchema();

    return await this.__createCluster();
  }

  override async clean() {
    // Stop handing connections to the workers before stopping them. Don't wait for it to close, which it
    // only does once every connection it handed to a worker has closed, so not until the workers stop.
    if (this._mainServer) {
      Logging.logSilly('Closing main server');
      // this._mainServer.closeAllConnections();
      this._mainServer.close();
      this._mainServer = null;
    }

    if (this._socketHeartbeat) clearInterval(this._socketHeartbeat);

    // Close down all socket.io connections / handlers. This comes before closing NRP, which the disconnect
    // handlers publish to, and the redis clients that socket.io's adapter uses.
    if (this.io) {
      Logging.logSilly('Closing socket.io');
      this.io.disconnectSockets(true);
      await new Promise((resolve) => this.io?.close(resolve));
      this.io = undefined;
    }
    if (this._socketExpressServer) {
      Logging.logSilly('Closing socket.io express proxy');
      await new Promise((resolve) => this._socketExpressServer?.close(resolve));
      this._socketExpressServer = null;
    }

    await super.clean();

    Logging.logSilly('BootstrapSocket:clean');

    if (this.emitter) {
      Logging.logSilly('Closing emitter');
      this.emitter.disconnectSockets(true);
      this.emitter = undefined;
    }

    this._requestSockets.destroy();
    // this._requestSockets = null;

    if (this._redisClientEmitter) {
      Logging.logSilly('Closing redisClientEmitter');
      await this._redisClientEmitter.quit();
      this._redisClientEmitter = undefined;
    }
    if (this._redisClientIOPub) {
      Logging.logSilly('Closing redisClientIOPub');
      await this._redisClientIOPub.quit();
      this._redisClientIOPub = undefined;
    }
    if (this._redisClientIOSub) {
      Logging.logSilly('Closing redisClientIOSub');
      await this._redisClientIOSub.quit();
      this._redisClientIOSub = undefined;
    }

    if (this._redisClient) {
      await this._redisClient.quit();
    }

    for await (const sockets of Object.values(this._dataShareSockets)) {
      for await (const { socket } of sockets) {
        Logging.logSilly('Closing data share socket');
        // destroy() is private in the sio-client types
        (socket as unknown as { destroy: () => void }).destroy();
      }
    }

    // Destroy all models
    await Model.clean();

    // Close Datastore connections
    Logging.logSilly('Closing down all datastore connections');
    await Datastore.clean();
  }

  /**
   * message the primary and wait for a response
   * @param {*} channel
   * @param {*} message
   */
  // async _messagePrimary(channel: string, message?: unknown): Promise<void> {
  //   // Generate an identifier for message
  //   const id = uuidv4();
  //   // Notify the primary with our payload
  //   this.__nrp?.emit(`primary:${channel}`, JSON.stringify({ id, message, date: new Date() }));
  //   // Await a response from the primary
  //   return await new Promise((resolve, reject) => (this._processResQueue[id] = { resolve, reject }));
  // }

  override async __initMain() {
    this._redisClientEmitter = createClient({
      url: Config.redis.url,
    });
    await this._redisClientEmitter.connect();
    this.emitter = new Emitter(this._redisClientEmitter);

    if (this.isPrimary) {
      Logging.logVerbose(`Primary Main SOCKET`);
      await this.__registerNRPPrimaryListeners();

      // create app namespaces
      // const rxsApps = await Model.getCoreModel(AppSchemaModel).findAll();
      // for await (const app of rxsApps) {
      // 	if (!app._tokenId) {
      // 		Logging.logWarn(`App with no token`);
      // 		continue;
      // 	}

      // 	await this.__createAppNamespace(app);
      // }
    } else {
      Logging.logVerbose(`Secondary Main SOCKET`);
    }

    // This should be distributed across instances
    if (this.isPrimary) {
      Logging.logSilly(`Setting up data sharing connections`);
      const rxsDataShare = await Model.getCoreModel(AppDataSharingSchemaModel).find({
        active: true,
      });

      for await (const dataShare of rxsDataShare as AsyncIterable<AppDataSharing>) {
        await this.__primaryCreateDataShareConnection(dataShare);
      }
    }

    await this.__registerNRPMainListeners();
    // await this.__registerNRPProcessListeners();

    await this.__spawnWorkers();

    // Fielding request through to the worker processes. Do we even need this? It feels like
    // express should be handling this like we do on the rest.
    if (this.workerProcesses > 0) {
      this._mainServer = net
        .createServer({ pauseOnConnect: true }, (connection: net.Socket) => {
          // remoteAddress is set on a newly accepted connection
          this.notifyWorker(
            this.__indexFromIP(connection.remoteAddress as string, this.workerProcesses),
            {
              type: 'buttress:connection',
              payload: null,
            } satisfies LocalProcessMessage,
            connection,
          );
        })
        .listen(Config.listenPorts.sock);
    }
  }

  override async __initWorker() {
    const app = Express();
    this._socketExpressServer =
      this.workerProcesses > 0 ? app.listen(0, 'localhost') : app.listen(Config.listenPorts.sock);
    this.io = new sio(this._socketExpressServer, {
      // Allow connections from sio 2 clients
      // https://socket.io/docs/v3/migrating-from-2-x-to-3-0/#How-to-upgrade-an-existing-production-deployment
      allowEIO3: true,
      // https://expressjs.com/en/resources/middleware/cors.html#configuration-options
      // set origin to true to reflect the request origin, as defined by req.header('Origin'), or set it to false to disable CORS.
      cors: {
        origin: true,
        credentials: true,
      },
    });

    // As of v7, the library will no longer create Redis clients on behalf of the user.
    this._redisClientIOPub = createClient({
      url: Config.redis.url,
    });
    this._redisClientIOSub = this._redisClientIOPub.duplicate();

    await this._redisClientIOPub.connect();
    await this._redisClientIOSub.connect();

    this.io.adapter(createAdapter(this._redisClientIOPub, this._redisClientIOSub));

    const stats = this.io.of(`/stats`);
    stats.on('connect', (socket) => {
      Logging.logSilly(`${socket.id} Connected on /stats`);
      socket.on('disconnect', () => {
        Logging.logSilly(`${socket.id} Disconnect on /stats`);
      });
    });

    Logging.logSilly(`Listening on app namespaces`);
    this.io.of(/.*/).use(async (socket, next) => {
      if (socket.nsp.name === '/stats') return next();

      await this._workerHandleSocketConnection(socket, next);
    });

    await this.__registerNRPWorkerListeners();
    // await this.__registerNRPProcessListeners();

    this._socketHeartbeat = setInterval(() => this._publishSocketHeartbeat(), CONNECTED_TOKEN_HEARTBEAT_MS);
    this._socketHeartbeat.unref();

    Logging.logSilly(`Worker ready`);
  }

  protected override async __handleMessageFromMain(message: LocalProcessMessage, handle?: net.Socket) {
    if (message.type === 'buttress:connection') {
      const connection = handle;
      if (!connection || typeof connection.on !== 'function') {
        Logging.logError('Invalid socket handle received in worker for buttress:connection');
        return;
      }

      if (!this._socketExpressServer) throw new Error('No socket express server in worker');

      this._socketExpressServer.emit('connection', connection);
      connection.resume();
      return;
    }
  }

  private async _workerHandleSocketConnection(socket: AppSocket, next: (err?: Error) => void) {
    // A token in the query string ends up in access logs, so only auth.token is taken
    if (socket.handshake.query?.token !== undefined) {
      Logging.logWarn(`Token sent in the query string, closing connection: ${socket.id}`);
      return next(new Error('token-in-query-not-supported'));
    }
    const rawToken: unknown = socket.handshake.auth.token;
    // The client sends auth as JSON, so the token can be anything. A query object such as {$ne: null} would find
    // whichever token Mongo returned first, so only a string is looked up.
    if (typeof rawToken !== 'string' || rawToken === '') {
      Logging.logWarn(`Invalid token, closing connection: ${socket.id}`);
      return next(new Error('invalid-token'));
    }

    Logging.logDebug(`Fetching token ${tokenFingerprint(rawToken)}`);
    const token = (await Model.getCoreModel(TokenSchemaModel).findOne({ value: rawToken })) as Token;
    if (!token) {
      Logging.logWarn(`Invalid token, closing connection: ${socket.id}`);
      return next(new Error('invalid-token'));
    }

    socket.data.type = token.type;
    socket.data.tokenId = token.id.toString();

    Logging.logDebug(`Fetching app with appId: ${token._appId}`);
    const app = await Model.getCoreModel(AppSchemaModel).findOne({ id: token._appId });
    if (!app) {
      Logging.logWarn(`Invalid app, closing connection: ${socket.id}`);
      return next(new Error('invalid-app'));
    }

    const apiPath = app.apiPath;

    // Activity is only emitted to a token on its own app's namespace, so a token elsewhere would silently receive
    // nothing. System tokens may join any app's namespace to receive its activity.
    if (
      socket.nsp.name !== '/' &&
      socket.nsp.name !== `/${apiPath}` &&
      token.type !== TokenSchemaModel.Constants.Type.SYSTEM
    ) {
      Logging.logWarn(`Token for /${apiPath} used on ${socket.nsp.name}, closing connection: ${socket.id}`);
      return next(new Error('invalid-namespace'));
    }

    // Join them to a room based on the tokenId.
    socket.join(socket.data.tokenId);

    // Fire off a worker event to notify that a connection has been made with the token.
    this.__nrp?.emit(
      'worker:socket:connection',
      JSON.stringify({ tokenId: socket.data.tokenId, socketId: socket.id } satisfies SocketConnectionMessage),
    );

    if (token.type === 'dataSharing') {
      const remoteSchemas = Schema.decode(app.__schema).reduce((obj: Record<string, Schema.Schema>, item) => {
        if (!item.remotes) return obj;

        if (!Array.isArray(item.remotes)) {
          obj[`${item.remotes.name}.${item.remotes.schema}`] = item;
          return obj;
        }

        item.remotes.forEach((remote) => {
          obj[`${remote.name}.${remote.schema}`] = item;
        });

        return obj;
      }, {});

      Logging.logDebug(`Fetching data share with tokenId: ${socket.data.tokenId}`);
      const dataShare = await Model.getCoreModel(AppDataSharingSchemaModel).findOne({
        _tokenId: this._primaryDatastore.ID.new(socket.data.tokenId),
        active: true,
      });
      if (!dataShare) {
        Logging.logWarn(`Invalid data share, closing connection: ${socket.id}`);
        return next(new Error('invalid-data-share'));
      }

      socket.data.dataShareId = dataShare.id.toString();

      // Emit this activity to our instance.
      // This would result in the event being mutiplied
      socket.on('dataShareSocket:share', (data: DataShareSocketSharePayload) => {
        const remoteActivity = data.activity;
        if (!remoteActivity?.schemaName || !remoteSchemas[`${dataShare.name}.${remoteActivity.schemaName}`]) {
          Logging.log(
            `Skipping data sharing app doesn't use schema ${app.apiPath} ${dataShare.name}.${remoteActivity?.schemaName}, ${socket.id}`,
          );
          return;
        }

        const activity = relayedDataShareActivity(remoteActivity, app, remoteActivity.schemaName);
        if (!activity) return;

        this.__nrp?.emit('rest:activity', JSON.stringify(activity));
      });

      Logging.log(`[${apiPath}][DataShare] Connected ${socket.id} to room ${dataShare.name}`);
    } else if (token.type === 'user') {
      Logging.logDebug(`Fetching user with id: ${token._userId}`);
      const user = await Model.getCoreModel(UserSchemaModel).findById(token._userId);
      if (!user) {
        Logging.logWarn(`Invalid token user ID, closing connection: ${socket.id}`);
        return next(new Error('invalid-token-user-ID'));
      }

      socket.data.userId = user.id.toString();
    } else {
      // TODO: We're not handling other token types like app, lambda, etc.
      Logging.log(`[${apiPath}][Global] Connected ${socket.id}`);
    }

    socket.on('bjs-request-subscribe', (data: RequestSubscribeMessage) => {
      if (!data.id) return Logging.logError(`[${apiPath}] bjs-request-subscribe ${socket.id} missing id`);
      Logging.logSilly(`[${apiPath}] bjs-request-subscribe ${socket.id} ${data.id}`);

      // Check to see if there is already a socket subbing to this id.
      const reqSock = this._requestSockets.get(data.id);
      if (reqSock && socket !== reqSock)
        return Logging.logError(`[${apiPath}] bjs-request-subscribe ${socket.id} already subscribed`);

      // if the socket hasn't already been subscribed then we'll set it.
      if (!reqSock) this._requestSockets.set(data.id, socket);

      socket.emit('bjs-request-subscribe-ack', data);
    });

    socket.on('disconnect', () => {
      Logging.logSilly(`[${apiPath}] Disconnect ${socket.id}`);

      this.__nrp?.emit(
        'worker:socket:disconnect',
        JSON.stringify({ tokenId: socket.data.tokenId, socketId: socket.id } satisfies SocketConnectionMessage),
      );
    });

    next();
  }

  async __registerNRPPrimaryListeners() {
    Logging.logDebug(`Primary Main`);

    if (!this.__nrp) throw new Error('No NRP instance');

    // The data share connections are only open in this process, so it's the one that forwards activity over them.
    this.__nrp.on('spr:activity', (data) =>
      this._primaryForwardDataShareActivity(JSON.parse(data) as DataShareSocketSharePayload),
    );
    // this.__nrp.on('clearUserLocalData', (json) => this.__primaryClearUserLocalData(json));
    this.__nrp.on('dataShare:activated', async (json: string) => {
      const data = JSON.parse(json) as DataShareActivatedMessage;
      const dataShare = (await Model.getCoreModel(AppDataSharingSchemaModel).findById(
        data.appDataSharingId,
      )) as AppDataSharing | null;
      if (!dataShare?.active) {
        this._closeDataShareConnection(data.appDataSharingId);
        return;
      }
      await this.__primaryCreateDataShareConnection(dataShare);
    });
    // Also published when an agreement is deleted
    this.__nrp.on('dataShare:deactivated', (json: string) => {
      const data = JSON.parse(json) as DataShareActivatedMessage;
      this._closeDataShareConnection(data.appDataSharingId);
    });

    this.__nrp.on('app-schema:updated', async (json: string) => {
      const data = JSON.parse(json) as AppSchemaUpdatedMessage;
      await Model.initSchema(data.appId);
    });
  }

  async __registerNRPMainListeners() {}

  /**
   * Tells the SPR which tokens this process still has sockets open for, which renews them. A token whose sockets were
   * all in a process that has gone isn't renewed, so it's taken off the connected tokens once it expires.
   */
  _publishSocketHeartbeat() {
    if (!this.io) return;

    const tokenIds = new Set<string>();
    for (const namespace of this.io._nsps.values()) {
      for (const socket of namespace.sockets.values()) {
        const tokenId = (socket.data as { tokenId?: string }).tokenId;
        if (tokenId) tokenIds.add(tokenId);
      }
    }
    if (tokenIds.size < 1) return;

    this.__nrp?.emit(
      'worker:socket:heartbeat',
      JSON.stringify({ tokenIds: [...tokenIds] } satisfies SocketHeartbeatMessage),
    );
  }

  /**
   * Closes the sockets of tokens that have been deleted, which would otherwise keep receiving activity. A token's
   * sockets are in the room named after it, on its app's namespace, or on any namespace for a system token. The client
   * sees `io server disconnect` and doesn't reconnect by itself; if it tries, its token is refused.
   * @param {string[]} tokenIds
   */
  _disconnectTokenSockets(tokenIds: string[]) {
    if (!this.io) return;

    for (const namespace of this.io._nsps.values()) {
      tokenIds.forEach((tokenId) => namespace.in(tokenId).local.disconnectSockets());
    }
  }

  async __registerNRPWorkerListeners() {
    if (!this.__nrp) throw new Error('No NRP instance');

    this.__nrp.on('spr:activity', (data) => this._workerOnSPRActivity(JSON.parse(data) as DataShareSocketSharePayload));

    // Every Socket process is told, and each closes its own sockets.
    this.__nrp.on('token:deleted', (json: string) => {
      const { tokenIds } = JSON.parse(json) as { tokenIds: string[] };
      this._disconnectTokenSockets(tokenIds);
    });

    this.__nrp.on('sock:worker:request-status', async (json: string) => {
      const data = JSON.parse(json) as RequestStatusMessage;
      if (!data.id) return;

      const socket = this._requestSockets.get(data.id);
      if (!socket) return;

      socket.emit('bjs-request-status', data);
    });
    this.__nrp.on('sock:worker:request-end', async (json: string) => {
      const data = JSON.parse(json) as RequestEndMessage;
      if (!data.id) return;

      const socket = this._requestSockets.get(data.id);
      if (!socket) return;

      socket.emit('bjs-request-status', data);
      this._requestSockets.delete(data.id);
    });
  }

  // async __registerNRPProcessListeners() {
  //   this.__nrp?.on('process:messageQueueResponse', (json: string) => {
  //     const data = JSON.parse(json) as messageQueueResponse;

  //     if (!this._processResQueue[data.id]) return;
  //     Logging.logSilly(`process:messageQueueResponse ${data.id}`);
  //     this._processResQueue[data.id].resolve(data.response);
  //   });
  // }

  private async _workerOnSPRActivity(data: DataShareSocketSharePayload) {
    if (!this.io) throw new Error('No socket.io instance');

    if (!data.tokens || data.tokens.length < 1) {
      Logging.log(
        `[${data.activity.appAPIPath}][${data.activity.verb}] activity in on ${data.activity.path} - No tokens`,
        Logging.Constants.LogLevel.SILLY,
      );
      return;
    }

    const container = {
      id: Datastore.getInstance('core').ID.new().toString(),
      timer: new Helpers.Timer(),
    };
    container.timer.start();
    Logging.logTimer(
      `[${data.activity.appAPIPath}][${data.activity.verb}] activity in on ${data.activity.path}`,
      container.timer,
      Logging.Constants.LogLevel.SILLY,
      container.id,
    );

    const { tokens, activity }: DataShareSocketSharePayload = data;

    // Every Socket worker receives each activity over NRP, so each emits only to its own sockets. Emitting through
    // the redis adapter would reach every worker's sockets, and a client would get a copy from each worker.
    this.io.of(`/stats`).local.emit('activity', 1);
    Logging.logTimer(`emitted stats activity`, container.timer, Logging.Constants.LogLevel.SILLY, container.id);

    if (activity.broadcast === false) {
      Logging.log(
        `[${activity.appAPIPath}][${activity.verb}] activity in on ${activity.path} - Early out as it isn't public.`,
        Logging.Constants.LogLevel.SILLY,
      );
      return;
    }

    const packet = {
      time: new Date().toISOString(),
      data: {
        response: activity.response,
        path: activity.path,
        pathSpec: activity.pathSpec,
        user: activity.user,
        clientSessionId: activity.clientSessionId,
        verb: activity.verb,
        params: activity.params,
        schemaName: activity.schemaName,
        isSameApp: activity.isSameApp,
        isBulkDelete: Object.keys(activity.params).length < 1 && activity.verb === 'delete',
      },
    };

    this.io.of(`/${data.activity.appAPIPath}`).local.to(tokens).emit('db-activity', packet);
  }

  /**
   * Sends an activity on to the remote instances the app shares data with. Only the primary Socket instance's main
   * process holds data share connections, so the activity goes to each remote once, however many workers there are.
   * A partner gets only the activity the SPR sent the agreement's own token, which the agreement's policy selected
   * and projected, and none of this instance's token ids.
   * @param {DataShareSocketSharePayload} data
   */
  _primaryForwardDataShareActivity(data: DataShareSocketSharePayload) {
    const { tokens, activity } = data;
    if (!tokens || tokens.length < 1) return;
    if (activity.broadcast === false) return;
    // An activity that came in over a data share has isSameApp set by the receiving side, so it isn't sent back.
    if (activity.isSameApp !== undefined) return;

    const shares = activity.appId ? this._dataShareSockets[activity.appId] : undefined;
    if (!shares) return;

    for (const { socket, tokenId } of shares) {
      if (!tokens.includes(tokenId)) continue;

      Logging.logSilly(`[${activity.appAPIPath}][${activity.verb}] notifying data sharing on ${activity.path}`);
      socket.emit('dataShareSocket:share', { tokens: [], activity });
    }
  }

  __primaryClearUserLocalData() {
    throw new Error('DEPRECATED: call made to __primaryClearUserLocalData');
    // const apiPath = data.appAPIPath;

    // this.__namespace[apiPath].emitter.emit('clear-local-db', {
    // 	data: data,
    // });
  }

  __indexFromIP(ip: string, spread: number) {
    let s = '';
    for (let i = 0, _len = ip.length; i < _len; i++) {
      if (!isNaN(Number(ip[i]))) {
        s += ip[i];
      }
    }

    return Number(s) % spread;
  }

  async __primaryCreateDataShareConnection(dataShare: AppDataSharing) {
    let url = `${dataShare.remoteApp.endpoint}/${dataShare.remoteApp.apiPath}`;

    if (dataShare.remoteApp.ws) {
      url = `${dataShare.remoteApp.ws}/${dataShare.remoteApp.apiPath}`;
    }

    // Only to hosts the operator allows, when they've set a list
    const destination = await dataSharingDestinationProblem([url]);
    if (destination) {
      Logging.logError(`Data sharing ${dataShare.id} not connecting to ${redactUrl(url)}: ${destination}`);
      return;
    }

    Logging.logSilly(
      `Attempting to connect to ${redactUrl(url)} with token ${tokenFingerprint(dataShare.remoteApp.token)}`,
    );
    // An agreement activated again, e.g. with a new token, replaces its connection
    this._closeDataShareConnection(String(dataShare.id));
    if (!this._dataShareSockets[dataShare._appId]) {
      this._dataShareSockets[dataShare._appId] = [];
    }

    const socket = this._connectDataShare(url, dataShare.remoteApp.token);

    this._dataShareSockets[dataShare._appId].push({
      socket,
      tokenId: String(dataShare._tokenId),
      dataShareId: String(dataShare.id),
    });

    socket.on('connect', () => {
      Logging.logSilly(`Data sharing ${dataShare.id} connected to ${url} with id ${socket.id}`);
    });
    socket.on('disconnect', () => {
      Logging.logSilly(`Data sharing ${dataShare.id} disconnected from ${url} with id ${socket.id}`);
    });
  }

  _connectDataShare(url: string, token: string) {
    return sioClient(url, {
      auth: {
        token,
      },
      forceNew: true,
    });
  }

  /**
   * Closes the connection an agreement has to its partner, if it has one.
   * @param {string} dataShareId
   */
  _closeDataShareConnection(dataShareId: string) {
    for (const [appId, shares] of Object.entries(this._dataShareSockets)) {
      const share = shares.find((s) => s.dataShareId === dataShareId);
      if (!share) continue;

      Logging.logSilly(`Closing the data sharing ${dataShareId} connection`);
      // destroy() is private in the sio-client types
      (share.socket as unknown as { destroy: () => void }).destroy();
      this._dataShareSockets[appId] = shares.filter((s) => s !== share);
    }
  }
}
