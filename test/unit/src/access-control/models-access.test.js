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

import * as ACM from '../../../../dist/access-control/models-access.js';

function readableOf(items) {
  const stream = new Readable({ objectMode: true, read() {} });
  process.nextTick(() => {
    items.forEach((item) => stream.push(item));
    stream.push(null);
  });
  return stream;
}

async function drain(stream) {
  const items = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (item) => items.push(item));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return items;
}

describe('access-control/models-access:find', () => {
  it('streams and merges results from every policy config when all succeed', async () => {
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => query,
      find: (query) => readableOf([{ id: `${query.tag}-a` }, { id: `${query.tag}-b` }]),
    };
    const ac = {
      policyConfigs: [{ appId: 'app-1', query: { tag: 'one' } }, { appId: 'app-1', query: { tag: 'two' } }],
    };

    // An empty raw query means `mergeQueryFiltersWithAccessControl` returns each policy config's
    // own query unchanged (see filter.ts:359), so the mock's flat `query.tag` reads are meaningful.
    const stream = await ACM.find(model, { query: {} }, ac);
    const items = await drain(stream);

    assert.strictEqual(items.length, 4);
  });

  it('rejects instead of silently returning a partial stream when one policy config fails to parse', async () => {
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => {
        if (query.shouldFail) throw new TypeError("Cannot read properties of undefined (reading '__type')");
        return query;
      },
      find: (query) => readableOf([{ id: `${query.tag}-a` }]),
    };
    const ac = {
      policyConfigs: [
        { appId: 'app-1', query: { tag: 'one' } },
        { appId: 'app-1', query: { tag: 'two', shouldFail: true } },
      ],
    };

    await assert.rejects(
      () => ACM.find(model, { query: {} }, ac),
      /Cannot read properties of undefined/,
    );
  });

  it('does not start any datastore find() call when a later policy config fails to parse', async () => {
    const model = {
      flatSchemaData: {},
      parseQuery: (query) => {
        if (query.shouldFail) throw new Error('bad policy query');
        return query;
      },
      find: () => {
        assert.fail('find() should not be called when a sibling policy config fails to parse');
      },
    };
    const ac = {
      policyConfigs: [
        { appId: 'app-1', query: { tag: 'one' } },
        { appId: 'app-1', query: { shouldFail: true } },
      ],
    };

    await assert.rejects(() => ACM.find(model, { query: {} }, ac));
  });
});
