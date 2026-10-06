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
import { describe, it } from 'mocha';
import assert from 'assert';
import { Readable } from 'node:stream';

import { SortedStreams, parseJsonArrayStream } from '../../../../dist/helpers/stream.js';

const createSource = () => new Readable({ objectMode: true, read() {} });

describe('helpers/stream:SortedStreams', () => {
  it('merges its sources in order', async () => {
    const sources = [createSource(), createSource()];
    const combined = new SortedStreams(sources);
    sources[0].push(1);
    sources[0].push(3);
    sources[0].push(null);
    sources[1].push(2);
    sources[1].push(null);

    assert.deepStrictEqual(await combined.toArray(), [1, 2, 3]);
  });

  it("fails with a source's error and destroys the other sources", async () => {
    const sources = [createSource(), createSource()];
    const combined = new SortedStreams(sources);

    sources[1].destroy(new Error('$in needs an array'));

    await assert.rejects(() => combined.toArray(), /\$in needs an array/);
    assert.ok(sources[0].destroyed);
  });

  it('destroys its sources when it is destroyed', async () => {
    const sources = [createSource(), createSource()];
    const combined = new SortedStreams(sources);

    combined.destroy();
    await new Promise((resolve) => combined.once('close', resolve));

    assert.ok(sources.every((source) => source.destroyed));
  });

  it('ends at its limit, whatever its sources still send', async () => {
    const sources = [createSource(), createSource()];
    const combined = new SortedStreams(sources, undefined, 2);
    [1, 3, 5, null].forEach((n) => sources[0].push(n));
    [2, 4, 6, null].forEach((n) => sources[1].push(n));

    assert.deepStrictEqual(await combined.toArray(), [1, 2]);
  });

  it('skips the first of its merged items', async () => {
    const sources = [createSource(), createSource()];
    const combined = new SortedStreams(sources, undefined, 2, 2);
    [1, 3, 5, null].forEach((n) => sources[0].push(n));
    [2, 4, 6, null].forEach((n) => sources[1].push(n));

    assert.deepStrictEqual(await combined.toArray(), [3, 4]);
  });

  it('tells which source gave each item as it arrives, before it can be read', async () => {
    const sources = [createSource(), createSource()];
    const combined = new SortedStreams(sources, (a, b) => a.n - b.n);
    const arrived = new Map();
    combined.on('chunkReceived', ({ chunk, sourceIdx }) => arrived.set(chunk, sourceIdx));
    const read = [];
    // A reader that looks each item up as it's given, as a route reading the merged records does
    combined.on('data', (item) => read.push([item.n, arrived.get(item)]));
    sources[0].push({ n: 1 });
    sources[1].push({ n: 2 });
    sources.forEach((source) => source.push(null));
    await new Promise((resolve) => combined.once('end', resolve));

    assert.deepStrictEqual(read, [
      [1, 0],
      [2, 1],
    ]);
  });

  it('keeps every item its sources send before it is read', async () => {
    const sources = [createSource(), createSource()];
    const combined = new SortedStreams(sources);
    for (let n = 0; n < 40; n += 2) {
      sources[0].push(n);
      sources[1].push(n + 1);
    }
    sources.forEach((source) => source.push(null));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepStrictEqual(await combined.toArray(), Array.from({ length: 40 }, (_, n) => n));
  });
});


// SR-DPC-001 D5: the rows of a partner's answer, however its bytes are split into chunks
describe('helpers/stream:parseJsonArrayStream', () => {
  const rowsOf = async (chunks) => {
    const parser = parseJsonArrayStream();
    const rows = [];
    const done = new Promise((resolve, reject) => {
      parser.on('data', (row) => rows.push(row));
      parser.on('end', resolve);
      parser.on('error', reject);
    });
    for (const chunk of chunks) parser.write(chunk);
    parser.end();
    await done;
    return rows;
  };
  // A stream as Buttress writes one
  const written = (rows) => `[${rows.map((row) => JSON.stringify(row)).join('\n,')}${rows.length ? '\n' : ''}]`;
  const rows = [{ id: 'a', name: 'first' }, { id: 'b', name: 'second' }, { id: 'c', name: 'third' }];

  it('reads every row, wherever the chunks split them', async () => {
    const text = written(rows);
    for (let at = 1; at < text.length; at++) {
      assert.deepStrictEqual(await rowsOf([Buffer.from(text.slice(0, at)), Buffer.from(text.slice(at))]), rows, `split at ${at}`);
    }
    assert.deepStrictEqual(await rowsOf([...Buffer.from(text)].map((byte) => Buffer.from([byte]))), rows);
  });

  it('reads a character whose bytes the chunks split', async () => {
    const bytes = Buffer.from(written([{ id: 'a', name: 'café ☕' }]));
    const at = bytes.indexOf(0xe2) + 1;

    assert.deepStrictEqual(await rowsOf([bytes.subarray(0, at), bytes.subarray(at)]), [{ id: 'a', name: 'café ☕' }]);
  });

  it('reads no rows from an empty list', async () => {
    assert.deepStrictEqual(await rowsOf([Buffer.from('[]')]), []);
  });

  it('fails on a row that does not parse, rather than leaving it out', async () => {
    await assert.rejects(rowsOf([Buffer.from('[{"id":"a"}\n,{"id":\n]')]), SyntaxError);
    await assert.rejects(rowsOf([Buffer.from('[{"id":"a"}\n,{"id":"b"')]), SyntaxError);
  });
});
