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

import { pickWriteTarget, sourceOfRecord } from '../../../../../dist/routes/schema-routes/write-target.js';

const request = (sourceId) => ({ appId: 'app-b', schemaName: 'car', id: 'car-1', ...(sourceId ? { sourceId } : {}) });

// A collection with remotes: each record it read, and the agreement it read it through (null for the app's own)
const federated = (read, { unreachable = false } = {}) => {
  const sources = new Map(read);
  return {
    model: { sourceOf: (record) => sources.get(record), hasUnreachablePartner: () => unreachable },
    found: read.map(([record]) => record),
  };
};

describe('routes/schema-routes/write-target', () => {
  describe('a collection without remotes', () => {
    it('writes the record it found, whatever source the request names', () => {
      const car = { id: 'car-1' };

      assert.deepStrictEqual(pickWriteTarget({}, [car], request('app-x')), { entity: car, via: null });
      assert.strictEqual(pickWriteTarget({}, [], request()), null);
    });
  });

  describe('a collection with remotes', () => {
    const own = { id: 'car-1', sourceId: null };
    const fromA = { id: 'car-1', sourceId: 'app-a' };
    const fromC = { id: 'car-1', sourceId: 'app-c' };

    it('writes a record found in one source through the agreement it was read through', () => {
      const { model, found } = federated([[fromA, 'agreement-1']]);

      assert.deepStrictEqual(pickWriteTarget(model, found, request()), { entity: fromA, via: 'agreement-1' });
    });

    it('takes the one the request names by its source, out of several, whatever its case', () => {
      const { model, found } = federated([
        [own, null],
        [fromA, 'agreement-1'],
        [fromC, 'agreement-2'],
      ]);

      assert.deepStrictEqual(pickWriteTarget(model, found, request('APP-C')), { entity: fromC, via: 'agreement-2' });
    });

    it("names the app's own record by the app, as it's returned", () => {
      const { model, found } = federated([
        [own, null],
        [fromA, 'agreement-1'],
      ]);

      assert.deepStrictEqual(pickWriteTarget(model, found, request('app-b')), { entity: own, via: null });
    });

    it("takes the app's own, out of several, when the request names none", () => {
      const { model, found } = federated([
        [fromA, 'agreement-1'],
        [own, null],
      ]);

      assert.deepStrictEqual(pickWriteTarget(model, found, request()), { entity: own, via: null });
    });

    it('refuses to choose between partners when the request names none', () => {
      const { model, found } = federated([
        [fromA, 'agreement-1'],
        [fromC, 'agreement-2'],
      ]);

      assert.throws(() => pickWriteTarget(model, found, request()), {
        status: 409,
        code: 'ambiguous_source',
        details: { schema: 'car', id: 'car-1' },
      });
    });

    // A partner can name any source for its record, so naming another partner's app doesn't take that partner's writes
    it('refuses to choose between partners whose records name the same source', () => {
      const posing = { id: 'car-1', sourceId: 'app-a' };
      const { model, found } = federated([
        [fromA, 'agreement-1'],
        [posing, 'agreement-2'],
      ]);

      assert.throws(() => pickWriteTarget(model, found, request('app-a')), { status: 409, code: 'ambiguous_source' });
    });

    it('writes a record that more than one of the caller\'s policy configs read once', () => {
      const again = { ...fromA };
      const { model, found } = federated([
        [fromA, 'agreement-1'],
        [again, 'agreement-1'],
      ]);

      assert.deepStrictEqual(pickWriteTarget(model, found, request()), { entity: fromA, via: 'agreement-1' });
    });

    it('finds none from the source the request names when no record has it', () => {
      const { model, found } = federated([[fromA, 'agreement-1']]);

      assert.strictEqual(pickWriteTarget(model, found, request('app-c')), null);
    });

    it("answers as unavailable when it finds none and a partner couldn't be reached", () => {
      const { model, found } = federated([], { unreachable: true });

      assert.throws(() => pickWriteTarget(model, found, request()), {
        status: 503,
        code: 'data_sharing_partner_unavailable',
      });
    });
  });

  describe('sourceOfRecord', () => {
    it('gives the agreement a record was read through, or null for the app\'s own and a collection without remotes', () => {
      const fromA = { id: 'car-1' };
      const { model } = federated([[fromA, 'agreement-1']]);

      assert.deepStrictEqual(
        [sourceOfRecord(model, fromA), sourceOfRecord(model, { id: 'other' }), sourceOfRecord({}, fromA)],
        ['agreement-1', null, null],
      );
    });
  });
});
