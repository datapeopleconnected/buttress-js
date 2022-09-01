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

const Readable = require('stream').Readable;

class ReadableStreamClone extends Readable {
	constructor(readableStream, options) {
		super(options);

		readableStream.on('data', (chunk) => this.push(chunk));
		readableStream.on('end', () => this.push(null));
		readableStream.on('error', (err) => this.emit('error', err));
	}

	_read() {}
}

module.exports = {
	ReadableStreamClone,
};

// ISC © Julien Fontanet
const getSymbol =
	typeof Symbol === 'function' ? (name) => {
		const symbol = Symbol[name];
		return symbol !== undefined ? symbol : `@@${name}`;
	} : (name) => `@@${name}`;

const $$asyncIterator = (asyncIteratorToStream.$$asyncIterator = getSymbol('asyncIterator'));
const $$iterator = (asyncIteratorToStream.$$iterator = getSymbol('iterator'));

const resolveToIterator = (value) => {
	let tmp;
	if (typeof (tmp = value[$$asyncIterator]) === 'function') {
		return tmp.call(value); // async iterable
	}
	if (typeof (tmp = value[$$iterator]) === 'function') {
		return tmp.call(value); // iterable
	}
	return value; // iterator
};

// Create a readable stream from a sync/async iterator
//
// If a generator is passed instead of an iterator, a factory is returned
// instead of a plain readable stream.
//
// The generator can be async or can yield promises to wait for them.
//
// `yield` returns the `size` parameter of the next method, the generator can
// ask for it without generating a value by yielding `undefined`.
function asyncIteratorToStream(iterable, options) {
	if (typeof iterable === 'function') {
		return function(...args) {
			return asyncIteratorToStream(iterable.apply(this, args), options);
		};
	}

	const {then} = iterable;
	if (typeof then === 'function') {
		return then.call(iterable, (iterable) => asyncIteratorToStream(iterable, options));
	}

	const iterator = resolveToIterator(iterable);
	const isGenerator = 'return' in iterator;
	const readable =
		options instanceof Readable ? options : new Readable(options);
	if (isGenerator) {
		readable._destroy = async (error, cb) => {
			try {
				await (error != null ? iterator.throw(error) : iterator.return());
			} catch (error) {
				return cb(error);
			}
			cb(error);
		};
	}
	let running = false;
	readable._read = async (size) => {
		if (running) {
			return;
		}
		running = true;
		try {
			let value;
			do {
				let cursor = iterator.next(size);

				// return the next value of the iterator but if it is a promise, resolve it and
				// reinject it
				//
				// this enables the use of a simple generator instead of an async generator
				// (which are less widely supported)
				if (typeof cursor.then === 'function') {
					cursor = await cursor;
				} else {
					while (
						!cursor.done &&
						(value = cursor.value) != null &&
						typeof value.then === 'function'
					) {
						try {
							value = await value;
						} catch (error) {
							cursor = iterator.throw(error);
							continue;
						}
						cursor = iterator.next(value);
					}
				}

				if (cursor.done) {
					return readable.push(null);
				}
				value = cursor.value;
			} while (value === undefined || readable.push(value));
		} catch (error) {
			process.nextTick(readable.emit.bind(readable, 'error', error));
		} finally {
			running = false;
		}
	};
	return readable;
}

asyncIteratorToStream.obj = (iterable, options) =>
	asyncIteratorToStream(iterable, {
		objectMode: true,
		...options,
	});

module.exports.asyncIteratorToStream = asyncIteratorToStream;
