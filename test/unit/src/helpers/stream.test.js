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

import { SortedStreams } from '../../../../dist/helpers/stream.js';

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
});
