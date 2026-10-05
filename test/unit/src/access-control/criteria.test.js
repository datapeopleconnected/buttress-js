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
import { ObjectId } from 'bson';

import { matchCriterion } from '../../../../dist/access-control/criteria.js';

// A criterion of the policy language, as selection and conditions test it: the value is the field a query would test
describe('access-control/criteria:matchCriterion', () => {
  const rows = [
    // [value, operator, operand, holds]
    ['hello', '@eq', 'hello', true],
    ['hello', '$eq', 'hello', true],
    ['hello', '@eq', 'HELLO', false],
    [42, '@eq', 42, true],
    [42, '@eq', '42', false],
    [null, '@eq', null, true],
    [undefined, '@eq', null, true],
    ['value', '@eq', null, false],
    [['a', 'b'], '@eq', 'b', true],
    [new ObjectId('6abd02000000000000000001'), '@eq', '6abd02000000000000000001', true],
    ['hello', '@not', 'HELLO', true],
    ['hello', '@not', 'hello', false],
    [['a', 'b'], '@not', 'b', false],
    [5, '@gt', 3, true],
    [3, '@gt', 3, false],
    ['5', '@gt', 3, false],
    [3, '@gte', 3, true],
    [2, '@lt', 3, true],
    [3, '@lte', 3, true],
    ['b', '@gt', 'a', true],
    ['2025-06-01', '@gtDate', '2025-01-01', true],
    ['2025-01-01', '@gtDate', '2025-06-01', false],
    [new Date('2025-06-01'), '@gteDate', '2025-06-01T00:00:00.000Z', true],
    ['2025-01-01', '@ltDate', '2025-06-01', true],
    ['2025-06-01', '@lteDate', '2025-06-01', true],
    ['31/01/2042', '@gtDate', '01/02/2022', true],
    ['tomorrow', '@gtDate', 'yesterday', true],
    ['2025-06-01', '@gtDate', 'not a date', false],
    [{ at: '2025-06-01' }, '@gtDate', '2025-01-01', false],
    ['admin@example.com', '@rex', '^admin@', true],
    ['admin@example.com', '@rex', '^ADMIN@', false],
    ['admin@example.com', '@rexi', '^ADMIN@', true],
    ['admin', '@rex', '(', false],
    ['admin', '@in', ['admin', 'user'], true],
    ['admin', '@in', ['ADMIN', 'user'], false],
    [['guest', 'user'], '@in', ['admin', 'user'], true],
    ['admin', '@in', 'admin', true],
    ['admin', '@nin', ['user', 'guest'], true],
    ['admin', '@nin', ['admin'], false],
    [undefined, '@nin', ['admin'], true],
    ['premium', '@exists', true, true],
    [undefined, '@exists', true, false],
    [undefined, '@exists', false, true],
    ['a.b', '@inProp', '.', true],
    ['ab', '@inProp', '.', false],
    [[{ n: 1 }, { n: 2 }], '@elMatch', { n: 2 }, true],
    ['admin', '@like', 'admin', false],
    ['admin', 'constructor', 'admin', false],
    ['admin', '__proto__', 'admin', false],
  ];

  for (const [value, operator, operand, holds] of rows) {
    it(`${holds ? 'holds' : 'fails'} for ${JSON.stringify(value)} ${operator} ${JSON.stringify(operand)}`, () => {
      assert.strictEqual(matchCriterion(value, operator, operand), holds);
    });
  }
});
