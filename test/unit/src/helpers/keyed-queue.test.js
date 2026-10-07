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

import { KeyedQueue } from '../../../../dist/helpers/keyed-queue.js';

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('helpers/keyed-queue:KeyedQueue', () => {
  it('runs the jobs of one key one after another, in the order they were pushed', async () => {
    const queue = new KeyedQueue();
    const ran = [];

    await Promise.all([
      queue.push('a', async () => {
        await settle(20);
        ran.push('a1');
      }),
      queue.push('a', async () => ran.push('a2')),
    ]);

    assert.deepStrictEqual(ran, ['a1', 'a2']);
  });

  it('runs the jobs of other keys alongside', async () => {
    const queue = new KeyedQueue();
    const ran = [];

    await Promise.all([
      queue.push('a', async () => {
        await settle(20);
        ran.push('a');
      }),
      queue.push('b', async () => ran.push('b')),
    ]);

    assert.deepStrictEqual(ran, ['b', 'a']);
  });

  it("goes on to a key's next job when one fails, and gives the failure to its handler", async () => {
    const failures = [];
    const queue = new KeyedQueue((err, key) => failures.push([key, err.message]));
    const ran = [];

    await Promise.all([
      queue.push('a', async () => {
        throw new Error('broken');
      }),
      queue.push('a', async () => ran.push('a2')),
    ]);

    assert.deepStrictEqual(ran, ['a2']);
    assert.deepStrictEqual(failures, [['a', 'broken']]);
  });

  it('holds nothing for a key once its jobs are done', async () => {
    const queue = new KeyedQueue();

    await queue.push('a', async () => {});

    assert.strictEqual(queue.size, 0);
  });
});
