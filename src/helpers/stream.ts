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
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

interface SourceHolder {
  source: Readable;
  closed: boolean;
  queued: number;
}

interface QueuedChunk<T> {
  chunk: T;
  sourceIdx: number;
}

/**
 * Payload of the `chunkSent` event, emitted once a chunk has been pushed downstream.
 */
export type ChunkSentEvent<T> = QueuedChunk<T>;

/**
 * Payload of the `chunkReceived` event, emitted as a source's chunk arrives, before it's queued, so a listener knows
 * which source gave a chunk before anything can read it.
 */
export type ChunkReceivedEvent<T> = QueuedChunk<T>;

export class SortedStreams<T = unknown> extends Readable {
  private _sources: SourceHolder[];

  private _sourcesClosed: boolean;

  private _queue: QueuedChunk<T>[];

  private _compareFn: (a: T, b: T) => number;

  private _pauseUntilRead: boolean;

  // private _lastChunkSent: any;

  public sent: number;

  public limit: number;

  // How many of the merged chunks to drop before sending any, so a page of the merged list can be read from sources
  // that each give their first skip + limit chunks
  public skip: number;

  private _skipped: number;

  private _ended: boolean;

  constructor(sources: Readable[], compareFn?: (a: T, b: T) => number, limit: number = 0, skip: number = 0) {
    super({ objectMode: true });

    this._compareFn = compareFn || this._defaultCompare;

    this._sources = sources.map((source) => {
      return {
        source,
        closed: false,
        queued: 0,
      };
    });
    this._sourcesClosed = false;

    // A sorted queue of items which are ready to be sent down the wire.
    this._queue = [];

    this._pauseUntilRead = false;

    this.sent = 0;
    this.limit = limit;
    this.skip = skip;
    this._skipped = 0;
    this._ended = false;

    // this._lastChunkSent = null;

    // Listen on the sources for data and end events.
    this._setupListeners();
  }

  _setupListeners() {
    this._sources.forEach((holder, idx) => {
      holder.source.on('data', (chunk: T) => this._handleSourceChunk(chunk, idx));
      holder.source.on('end', () => this._handleSourceEnd(holder));
      // A source's error fails the combined stream, rather than going unheard and bringing the process down
      holder.source.on('error', (err: Error) => this.destroy(err));
      if (holder.source.isPaused()) holder.source.resume();
    });
  }

  // Readable stream event handlers
  override _read() {
    this._pauseUntilRead = false;

    this._tryToSendIt();
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void) {
    this._sources.forEach((holder) => {
      holder.source.destroy();
    });

    this._queue = [];

    callback(err);
  }

  _tryToSendIt() {
    while (!this._ended && !this._pauseUntilRead) {
      const holder = this._dequeue();

      // If dequeue returns null, it means our queue isn't ready yet.
      if (holder === null) {
        // If the queue is empty and all sources are closed, then we're done.
        if (this._queue.length === 0 && this._sourcesClosed) this._end();
        return;
      }

      this._sources[holder.sourceIdx].queued--;

      if (this._skipped < this.skip) {
        this._skipped++;
        continue;
      }

      // A push past the reader's buffer is still taken, it only asks us to wait for the next read before another.
      if (!this.push(holder.chunk)) this._pauseUntilRead = true;

      this.emit('chunkSent', { chunk: holder.chunk, sourceIdx: holder.sourceIdx } satisfies ChunkSentEvent<T>);
      this.sent++;

      // We've reached out send limit, we'll close out.
      if (this.limit && this.sent >= this.limit) this._end();
    }
  }

  // Ends the stream once. Chunks its sources send after that are dropped.
  _end() {
    this._ended = true;
    this.push(null);
  }

  // Source event handlers
  _handleSourceChunk(chunk: T, sourceIdx: number) {
    this.emit('chunkReceived', { chunk, sourceIdx } satisfies ChunkReceivedEvent<T>);
    this._enqueue({ chunk, sourceIdx });
    this._sources[sourceIdx].queued++;

    this._tryToSendIt();
  }
  _handleSourceEnd(holder: SourceHolder) {
    holder.closed = true;
    this._sourcesClosed = this._sources.every((holder) => holder.closed);

    this._tryToSendIt();
  }

  // Queue management
  _enqueue(chunk: QueuedChunk<T>) {
    // TODO: Add a cap on the queu
    // TODO: Handle the case where the queue is full and way may need to discard some items.
    this._queue.push(chunk);
    this._queue = this._queue.sort((a, b) => this._compareFn(a.chunk, b.chunk));
  }
  _dequeue(): QueuedChunk<T> | null {
    if (this._queue.length === 0) return null;

    // If any of the sources are still open, and have less than x items then we want to wait.
    if (this._sources.some((holder) => !holder.closed && holder.queued < 1)) return null;

    // The length check above guarantees there's an item to shift.
    return this._queue.shift() as QueuedChunk<T>;
  }
  _defaultCompare(a: T, b: T) {
    if (typeof a === 'number' && typeof b === 'number') {
      return a - b;
    } else {
      const aStr = (a as object).toString();
      const bStr = (b as object).toString();

      if (aStr == bStr) return 0;

      return aStr > bStr ? 1 : -1;
    }
  }
}

/**
 * Reads a JSON array as Buttress streams one, a row to a line (`[row`, `,row`... `]`), into its rows. A row can arrive
 * split across chunks, and a character across their bytes: what follows a chunk's last newline waits for the next
 * chunk, and the decoder keeps a character's bytes until the rest arrive. A row that doesn't parse fails the stream
 * rather than being left out.
 */
export const parseJsonArrayStream = () => {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const parseLine = (stream: Transform, line: string) => {
    let trimmedLine = line.trim();
    if (trimmedLine.startsWith('[')) trimmedLine = trimmedLine.slice(1);
    if (trimmedLine.endsWith(']')) trimmedLine = trimmedLine.slice(0, -1);
    if (trimmedLine.startsWith(',')) trimmedLine = trimmedLine.slice(1);
    if (trimmedLine.endsWith(',')) trimmedLine = trimmedLine.slice(0, -1);
    if (trimmedLine !== '') stream.push(JSON.parse(trimmedLine));
  };

  return new Transform({
    objectMode: true,
    transform(chunk: Buffer | string, encoding, callback) {
      const lines = (pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split('\n');
      pending = lines.pop() ?? '';
      try {
        for (const line of lines) parseLine(this, line);
      } catch (err: unknown) {
        return callback(err as Error);
      }
      callback();
    },
    flush(callback) {
      try {
        parseLine(this, pending + decoder.end());
      } catch (err: unknown) {
        return callback(err as Error);
      }
      callback();
    },
  });
};
