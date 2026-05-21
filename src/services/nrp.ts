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

import * as redis from '@redis/client';

/**
 * Redis client options interface
 */
interface RedisOptions {
  url?: string;
  scope?: string;
  emitter?: redis.RedisClientType;
  receiver?: redis.RedisClientType;
  [key: string]: unknown;
}

/**
 * Initialize a Redis client with the given options
 */
function initClient(options: RedisOptions): redis.RedisClientType {
  const { url: redisUrl } = options;

  return redis.createClient({ url: redisUrl });
}

/**
 * NodeRedisPubsub class for handling Redis publish/subscribe messaging
 */
export class NodeRedisPubsub {
  private emitter: redis.RedisClientType;
  private receiver: redis.RedisClientType;
  private prefix: string;
  private errorHandler?: (error: string) => void;

  /**
   * Create a new NodeRedisPubsub instance that can subscribe to channels and publish messages
   * @param options Options for the client creations:
   *                port - Optional, the port on which the Redis server is launched.
   *                scope - Optional, two NodeRedisPubsubs with different scopes will not share messages
   *                emitter - Optional, a redis client
   *                receiver - Optional, a redis client
   *                url - Optional, a correctly formed redis connection url
   */
  constructor(options: RedisOptions = {}) {
    // accept connections / clients having the same interface as node_redis clients
    // Need to create two Redis clients as one cannot be both in receiver and emitter mode
    if (options.emitter) {
      this.emitter = options.emitter;
    } else {
      this.emitter = initClient(options);
    }

    if (options.receiver) {
      this.receiver = options.receiver;
    } else {
      this.receiver = initClient(options);
      this.receiver.setMaxListeners(0);
    }

    this.prefix = options.scope ? options.scope + ':' : '';
  }

  connect() {
    // Connect both emitter and receiver clients
    return Promise.all([this.emitter.connect(), this.receiver.connect()]);
  }

  /**
   * Return the emitter object to be used as a regular redis client to save resources.
   */
  getRedisClient(): redis.RedisClientType {
    return this.emitter;
  }

  /**
   * Subscribe to a channel
   * @param channel The channel to subscribe to, can be a pattern e.g. 'user.*'
   * @param handler Function to call with the received message.
   * @param callback Optional callback to call once the handler is registered.
   * @returns Function to remove the listener
   */
  async subscribe(
    channel: string,
    handler: (message: string, originalChannel?: string) => void,
  ): Promise<() => Promise<void>> {
    if (channel === 'error') {
      this.errorHandler = handler as (error: string) => void;
      this.emitter.on('error', handler);
      this.receiver.on('error', handler);
      return () => Promise.resolve();
    }

    await this.receiver.pSubscribe(this.prefix + channel, handler);

    return () => {
      return this.receiver.pUnsubscribe(this.prefix + channel, handler);
    };
  }

  /**
   * Alias for subscribe method
   */
  on(channel: string, handler: (message: string, originalChannel?: string) => void): Promise<() => void> {
    return this.subscribe(channel, handler);
  }

  /**
   * Publish a message to a channel
   * @param channel Channel on which to emit the message
   * @param message Message to publish
   * @returns Whether the message was published
   */
  publish(channel: string, message: string): Promise<number> {
    return this.emitter.publish(this.prefix + channel, message);
  }

  /**
   * Alias for publish method
   */
  emit = this.publish;

  /**
   * Safely close the redis connections 'soon'
   */
  quit() {
    return Promise.all([this.emitter.close(), this.receiver.close()]);
  }

  /**
   * Dangerously close the redis connections immediately
   */
  end(): void {
    this.emitter.destroy();
    this.receiver.destroy();
  }
}

export default NodeRedisPubsub;
