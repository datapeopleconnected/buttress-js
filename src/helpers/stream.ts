/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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
import {Readable} from 'stream';

interface SourceHolder {
	source: Readable;
	closed: boolean;
	queued: number;
}

export class SortedStreams extends Readable {
	private _sources: SourceHolder[];

	private _sourcesClosed: boolean;

	private _queue: any[];

	private _compareFn: Function;

	private _pauseUntilRead: boolean;

	// private _lastChunkSent: any;

	public sent: number;

	public limit: number;

	constructor(sources: Readable[], compareFn: Function, limit: number) {
		super({objectMode: true});

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

		// this._lastChunkSent = null;

		// Listen on the sources for data and end events.
		this._setupListeners();
	}

	_setupListeners() {
		this._sources.forEach((holder, idx) => {
			holder.source.on('data', (chunk) => this._handleSourceChunk(chunk, idx));
			holder.source.on('end', () => this._handleSourceEnd(holder));
		});
	}

	// Readable stream event handlers
	_read() {
		this._pauseUntilRead = false;

		this._tryToSendIt();
	}

	_destroy() {
		this._sources.forEach((holder) => {
			holder.source.destroy();
		});

		this._queue = [];
	}

	_tryToSendIt() {
		const holder = this._dequeue();

		if (this._pauseUntilRead) return;

		// If dequeue returns null, it means our queue isn't ready yet.
		if (holder === null) {
			// If the queue is empty and all sources are closed, then we're done.
			if (this._queue.length === 0 && this._sourcesClosed) return this.push(null);

			return;
		}

		// TODO:
		//  - Check the current value with the last, if it's greater than our current index.
		//    - Set flag to check next value from all open sources.
		//    ... When all open sources send the next value ...
		//    - Set another flag that check has been complete.
		//    - Pick the next value from the list.

		// const pos = (this._lastChunkSent === null) ? 0 : this._compareFn(holder.chunk, this._lastChunkSent);
		// console.log(pos, holder.chunk.name || null, this._lastChunkSent || null);

		// Try to send it down the wire, if we can't, pause the stream until next read.
		if (!this.push(holder.chunk)) {
			this._pauseUntilRead = true;

			return;
		}

		this._sources[holder.sourceIdx].queued--;
		this.sent++;

		// this._lastChunkSent = holder.chunk;

		// We've reached out send limit, we'll close out.
		if (this.limit && this.sent >= this.limit) return this.push(null);
	}

	// Source event handlers
	_handleSourceChunk(chunk: any, sourceIdx: number) {
		this._enqueue({chunk, sourceIdx});
		this._sources[sourceIdx].queued++;

		this._tryToSendIt();
	}
	_handleSourceEnd(holder: SourceHolder) {
		holder.closed = true;
		this._sourcesClosed = this._sources.every((holder) => holder.closed);

		this._tryToSendIt();
	}

	// Queue management
	_enqueue(chunk: any) {
		// TODO: Add a cap on the queu
		// TODO: Handle the case where the queue is full and way may need to discard some items.
		this._queue.push(chunk);
		this._queue = this._queue.sort((a, b) => this._compareFn(a.chunk, b.chunk));
	}
	_dequeue() {
		if (this._queue.length === 0) return null;

		// If any of the sources are still open, and have less than x items then we want to wait.
		if (this._sources.some((holder) => !holder.closed && holder.queued < 1)) return null;

		return this._queue.shift();
	}
	_defaultCompare(a: any, b: any) {
		if (typeof a === 'number' && typeof b === 'number') {
			return a - b;
		} else {
			a = a.toString();
			b = b.toString();

			if (a == b) return 0;

			return (a > b) ? 1 : -1;
		}
	}
}
