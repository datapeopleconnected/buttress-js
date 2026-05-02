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

import createConfig from '@dpc/node-env-obj';

import hash from 'object-hash';
import Express from 'express';
import { ObjectId } from 'bson';
import { createClient, RedisClientType } from '@redis/client';
import { v4 as uuidv4 } from 'uuid';
import Sugar from './helpers/sugar.js';

import { Server as sio, Socket as sioSocket } from 'socket.io';
import sioClient, { Socket as sioClientSocket } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';

import Bootstrap from './bootstrap.js';

const Config = createConfig() as unknown as Config;

import Model from './model/index.js';
import * as Helpers from './helpers/index.js';
import Logging from './helpers/logging.js';

import AccessControl from './access-control/index.js';

import * as Schema from './helpers/schema.js';

import Datastore from './datastore/index.js';
import { PolicyCache } from './services/policy-cache.js';

import { RESTActivity, SPRActivity } from './types/bjs-nrp-objects.js';

import TokenSchemaModel, { Token } from './model/core/token.js';
import AppSchemaModel from './model/core/app.js';
import AppDataSharingSchemaModel from './model/core/app-data-sharing.js';
import UserSchemaModel from './model/core/user.js';

export default class BootstrapSocket extends Bootstrap {
  private __namespace: any = {};

  private _dataShareSockets: {
    [key: string]: sioClientSocket[];
  } = {};

  private _policyCloseSocketEvents: any[] = [];

  private _redisClient?: RedisClientType;
  private _redisClientEmitter?: RedisClientType;
  private _redisClientIOPub?: RedisClientType;
  private _redisClientIOSub?: RedisClientType;

  private _processResQueue: any;

  private _requestSockets: Helpers.ExpireMap;

  emitter?: Emitter;
  io?: sio;

  isPrimary: boolean;

  logicalOperator: string[];

  private _socketExpressServer: any;

  private _mainServer: any;

  private _primaryDatastore: any;

  constructor() {
    super();

    this.__namespace = {};

    this._dataShareSockets = {};

    this._policyCloseSocketEvents = [];

    this.isPrimary = Config.sio.app === 'primary';

    this._socketExpressServer = null;

    this._mainServer = null;

    this._processResQueue = {};

    this._primaryDatastore = Datastore.createInstance(Config.datastore, true);

    // A map that holds reference to sockets which have subscribed to a request
    // the map keys will expire after 5 minutes.
    this._requestSockets = new Helpers.ExpireMap(5 * 60 * 1000);

    this.logicalOperator = ['$or', '$and'];
  }

  async init() {
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

  async clean() {
    await super.clean();

    Logging.logSilly('BootstrapSocket:clean');

    if (this.emitter) {
      Logging.logSilly('Closing emitter');
      this.emitter.disconnectSockets(true);
      this.emitter = undefined;
    }

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

    this._requestSockets.destroy();
    // this._requestSockets = null;

    // Close down all socket.io connections / handlers
    if (this.io) {
      Logging.logSilly('Closing socket.io');
      this.io.disconnectSockets(true);
      await new Promise((resolve) => this.io?.close(resolve));
      this.io = undefined;
    }
    if (this._socketExpressServer) {
      Logging.logSilly('Closing socket.io express proxy');
      await new Promise((resolve) => this._socketExpressServer.close(resolve));
      this._socketExpressServer = null;
    }
    if (this._mainServer) {
      Logging.logSilly('Closing main server');
      this._mainServer.closeAllConnections();
      await new Promise((resolve) => this._mainServer.close(resolve));
      this._mainServer = null;
    }
    for await (const sockets of Object.values(this._dataShareSockets)) {
      for await (const socket of sockets) {
        Logging.logSilly('Closing data share socket');
        // @ts-expect-error - Double check the sio-client types
        socket.destroy();
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
  async _messagePrimary(channel: string, message?: any): Promise<any> {
    // Generate an identifier for message
    const id = uuidv4();
    // Notify the primary with our payload
    this.__nrp?.emit(`primary:${channel}`, JSON.stringify({ id, message, date: new Date() }));
    // Await a response from the primary
    return await new Promise((resolve, reject) => (this._processResQueue[id] = { resolve, reject }));
  }

  async __initMain() {
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

      for await (const dataShare of rxsDataShare) {
        await this.__primaryCreateDataShareConnection(dataShare);
      }
    }

    await this.__registerNRPMainListeners();
    await this.__registerNRPProcessListeners();

    await this.__spawnWorkers();

    // Fielding request through to the worker processes. Do we even need this? It feels like
    // express should be handling this like we do on the rest.
    if (this.workerProcesses > 0) {
      this._mainServer = net
        .createServer({ pauseOnConnect: true }, (connection) => {
          const worker = this.workers[this.__indexFromIP(connection.remoteAddress, this.workerProcesses)];
          worker.worker.send('buttress:connection', connection);
        })
        .listen(Config.listenPorts.sock);
    }
  }

  async __initWorker() {
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
    await this.__registerNRPProcessListeners();

    process.on('message', (message: string, input: net.Socket) => {
      if (message === 'buttress:connection') {
        const connection = input;
        this._socketExpressServer.emit('connection', connection);
        connection.resume();
        return;
      }
    });

    Logging.logSilly(`Worker ready`);
  }

  private async _workerHandleSocketConnection(socket: sioSocket, next: (err?: Error) => void) {
    // DEPRECATED: We should phase out accepting token via query and only use the auth headers.
    const rawToken = socket.handshake.auth.token || socket.handshake.query.token;

    Logging.logDebug(`Fetching token with value: ${rawToken}`);
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

    // Join them to a room based on the tokenId.
    socket.join(socket.data.tokenId);

    // Fire off a worker event to notify that a connection has been made with the token.
    this.__nrp?.emit('worker:socket:connection', socket.data.tokenId);

    if (token.type === 'dataSharing') {
      const remoteSchemas = Schema.decode(app.__schema).reduce((obj, item) => {
        if (!item.remotes) return obj;
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
      socket.on('share', (data) => {
        if (!data.schemaName || !remoteSchemas[`${dataShare.name}.${data.schemaName}`]) {
          Logging.log(
            `Skipping data sharing app doesn't use schema ${app.apiPath} ${dataShare.name}.${data.schemaName}, ${socket.id}`,
          );
          return;
        }

        const activity: RESTActivity = {
          ...data,
          appId: app.id,
          appAPIPath: app.apiPath,
          isSameApp: app.apiPath === data.appAPIPath,
        };

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

    socket.on('bjs-request-subscribe', (data) => {
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

      this.__nrp?.emit('worker:socket:disconnect', socket.data.tokenId);
    });

    next();
  }

  async __registerNRPPrimaryListeners() {
    Logging.logDebug(`Primary Main`);

    if (!this.__nrp) throw new Error('No NRP instance');

    // this.__nrp.on('spr:activity', (data) => this._workerOnSPRActivity(JSON.parse(data)));
    this.__nrp.on('clearUserLocalData', (json) => this.__primaryClearUserLocalData(json));
    this.__nrp.on('dataShare:activated', async (json: string) => {
      const data = JSON.parse(json);
      const dataShare = await Model.getCoreModel(AppDataSharingSchemaModel).findById(data.appDataSharingId);
      await this.__primaryCreateDataShareConnection(dataShare);
    });

    this.__nrp.on('app-schema:updated', async (json: string) => {
      const data = JSON.parse(json);
      await Model.initSchema(data.appId);
    });
  }

  async __registerNRPMainListeners() {}

  async __registerNRPWorkerListeners() {
    if (!this.__nrp) throw new Error('No NRP instance');

    this.__nrp.on('spr:activity', (data) => this._workerOnSPRActivity(JSON.parse(data)));

    this.__nrp.on('sock:worker:request-status', async (data: any) => {
      data = JSON.parse(data);
      if (!data.id) return;

      const socket = this._requestSockets.get(data.id);
      if (!socket) return;

      socket.emit('bjs-request-status', data);
    });
    this.__nrp.on('sock:worker:request-end', async (data: any) => {
      data = JSON.parse(data);
      if (!data.id) return;

      const socket = this._requestSockets.get(data.id);
      if (!socket) return;

      socket.emit('bjs-request-status', data);
      this._requestSockets.delete(data.id);
    });
  }

  async __registerNRPProcessListeners() {
    this.__nrp?.on('process:messageQueueResponse', (data: any) => {
      data = JSON.parse(data);

      if (!this._processResQueue[data.id]) return;
      Logging.logSilly(`process:messageQueueResponse ${data.id}`);
      this._processResQueue[data.id].resolve(data.response);
    });
  }

  private async _workerOnSPRActivity(data: { tokens: string[]; activity: SPRActivity }) {
    if (!this.io) throw new Error('No socket.io instance');

    if (!data.tokens || data.tokens.length < 1) {
      Logging.log(
        `[${data.activity.appAPIPath}][${data.activity.verb}] activity in on ${data.activity.path} - No tokens`,
        Logging.Constants.LogLevel.SILLY,
      );
      return;
    }

    const container = {
      id: Datastore.getInstance('core').ID.new(),
      timer: new Helpers.Timer(),
    };
    container.timer.start();
    Logging.logTimer(
      `[${data.activity.appAPIPath}][${data.activity.verb}] activity in on ${data.activity.path}`,
      container.timer,
      Logging.Constants.LogLevel.SILLY,
      container.id,
    );

    const { tokens, activity } = data;

    this.io.of(`/stats`).emit('activity', 1);
    Logging.logTimer(`emitted stats activity`, container.timer, Logging.Constants.LogLevel.SILLY, container.id);

    if (activity.broadcast === false) {
      Logging.log(
        `[${activity.appAPIPath}][${activity.verb}] activity in on ${activity.path} - Early out as it isn't public.`,
        Logging.Constants.LogLevel.SILLY,
      );
      return;
    }

    if (activity.appId && this._dataShareSockets[activity.appId] && activity.isSameApp === undefined) {
      Logging.logTimer(
        `[${activity.appAPIPath}][${activity.verb}] notifying data sharing`,
        container.timer,
        Logging.Constants.LogLevel.SILLY,
        container.id,
      );
      this._dataShareSockets[activity.appId].forEach((sock) => sock.emit('share', data));
    }

    const packet = {
      time: new Date().toISOString(),
      data: {
        response: activity.response,
        path: activity.path,
        pathSpec: activity.pathSpec,
        user: activity.user,
        verb: activity.verb,
        params: activity.params,
        schemaName: activity.schemaName,
        isSameApp: activity.isSameApp,
        isBulkDelete: Object.keys(activity.params).length < 1 && activity.verb === 'delete',
      },
    };

    this.io.of(`/${data.activity.appAPIPath}`).to(tokens).emit('db-activity', packet);
  }

  __primaryClearUserLocalData(json: string) {
    throw new Error('DEPRECATED: call made to __primaryClearUserLocalData');
    // const apiPath = data.appAPIPath;

    // this.__namespace[apiPath].emitter.emit('clear-local-db', {
    // 	data: data,
    // });
  }

  __indexFromIP(ip, spread) {
    let s = '';
    for (let i = 0, _len = ip.length; i < _len; i++) {
      if (!isNaN(ip[i])) {
        s += ip[i];
      }
    }

    return Number(s) % spread;
  }

  async __primaryCreateDataShareConnection(dataShare) {
    let url = `${dataShare.remoteApp.endpoint}/${dataShare.remoteApp.apiPath}`;

    if (dataShare.remoteApp.ws) {
      url = `${dataShare.remoteApp.ws}/${dataShare.remoteApp.apiPath}`;
    }

    Logging.logSilly(`Attempting to connect to ${url} with token ${dataShare.remoteApp.token}`);
    if (!this._dataShareSockets[dataShare._appId]) {
      this._dataShareSockets[dataShare._appId] = [];
    }

    const socket = sioClient(url, {
      auth: {
        token: dataShare.remoteApp.token,
      },
      forceNew: true,
    });

    this._dataShareSockets[dataShare._appId].push(socket);

    socket.on('connect', () => {
      Logging.logSilly(`Data sharing ${dataShare.id} connected to ${url} with id ${socket.id}`);
    });
    socket.on('disconnect', () => {
      Logging.logSilly(`Data sharing ${dataShare.id} disconnected from ${url} with id ${socket.id}`);
    });
  }
}
