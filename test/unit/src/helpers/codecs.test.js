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

import { decode } from '../../../../dist/helpers/codecs.js';

const HEX_ID = '507f1f77bcf86cd799439011';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

// [type, input, what it decodes to], for values a type takes
const takes = [
  ['boolean', true, true],
  ['boolean', false, false],
  ['boolean', 'true', true],
  ['boolean', 'false', false],
  ['boolean', 'yes', true],
  ['boolean', 'no', false],
  ['boolean', 'TRUE', true],
  ['boolean', 'No', false],
  ['boolean', '1', true],
  ['boolean', '0', false],
  ['boolean', 1, true],
  ['boolean', 0, false],
  ['number', 4, 4],
  ['number', '4.5', 4.5],
  ['string', 'text', 'text'],
  ['string', 4, '4'],
  ['id', HEX_ID, HEX_ID],
  ['uuid', UUID, UUID],
  ['uuid', UUID.toUpperCase(), UUID.toUpperCase()],
  ['array', [1, 'a'], [1, 'a']],
  ['object', { a: 1 }, { a: 1 }],
];

// [type, input], for values a type refuses
const refuses = [
  ['boolean', 'banana'],
  ['boolean', ''],
  ['boolean', 2],
  ['boolean', -1],
  ['boolean', {}],
  ['number', 'four'],
  ['number', true],
  ['string', {}],
  ['string', true],
  ['id', 'not-an-id'],
  ['id', 42],
  ['uuid', 'not-a-uuid'],
  ['uuid', `${UUID}0`],
  ['uuid', 42],
  ['date', 'not a date'],
  ['date', {}],
  ['array', 'a'],
  ['object', 'a'],
  ['strnig', 'a'],
];

describe('helpers/codecs:decode', () => {
  for (const [type, input, value] of takes) {
    it(`takes ${JSON.stringify(input)} as a ${type}`, () => {
      assert.deepStrictEqual(decode(type, input), { value });
    });
  }

  for (const [type, input] of refuses) {
    it(`refuses ${JSON.stringify(input)} as a ${type}, naming the type it expected`, () => {
      assert.deepStrictEqual(decode(type, input), { error: type });
    });
  }

  it('reads a date from a string or a number', () => {
    assert.strictEqual(decode('date', '2026-10-01T00:00:00.000Z').value.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.strictEqual(decode('date', 0).value.toISOString(), '1970-01-01T00:00:00.000Z');
  });

  it('takes a string listed in an enum, or none at all, and refuses another', () => {
    const config = { __enum: ['red', 'blue'] };

    assert.deepStrictEqual(decode('string', 'red', config), { value: 'red' });
    assert.deepStrictEqual(decode('string', '', config), { value: '' });
    assert.deepStrictEqual(decode('string', 'green', config), { error: 'enum' });
  });
});
