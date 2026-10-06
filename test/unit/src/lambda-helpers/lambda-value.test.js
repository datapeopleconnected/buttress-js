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

import {
  unfoldedSize,
  checkLambdaValue,
  LambdaValueError,
  MAX_LAMBDA_VALUE_BYTES,
} from '../../../../dist/lambda-helpers/lambda-value.js';

// SR-DPC-001 R13
describe('lambda-helpers/lambda-value:unfoldedSize', () => {
  it('measures a plain value about as long as its JSON', () => {
    for (const value of [{ a: 'text', b: [1, 2, 3], c: { d: true, e: null } }, ['x', 'y'], 'text', 42]) {
      const json = JSON.stringify(value).length;
      const size = unfoldedSize(value);
      assert.ok(size >= json && size <= json * 1.5, `${JSON.stringify(value)}: ${size} for ${json}`);
    }
  });

  it('counts an object as often as it is reached, as JSON would write it out', () => {
    const leaf = { text: 'x'.repeat(100) };

    assert.ok(unfoldedSize([leaf, leaf, leaf]) >= 3 * JSON.stringify(leaf).length);
  });

  it('measures one that would unfold to 2^60 leaves at once, as past the limit', () => {
    let n = {};
    for (let i = 0; i < 60; i++) n = { a: n, b: n };

    const started = Date.now();
    assert.strictEqual(unfoldedSize(n), MAX_LAMBDA_VALUE_BYTES + 1);
    assert.ok(Date.now() - started < 100);
  });

  it('stops counting past the limit it is given', () => {
    assert.strictEqual(unfoldedSize({ a: 'x'.repeat(100) }, 10), 11);
  });

  it('refuses a value that refers to itself', () => {
    const value = { list: [] };
    value.list.push(value);

    assert.throws(() => unfoldedSize(value), (err) => err instanceof LambdaValueError && err.code === 'lambda_value_circular');
  });

  it('measures a value nested deeper than the stack goes as past the limit', () => {
    let deep = {};
    for (let i = 0; i < 200000; i++) deep = { deep };

    assert.strictEqual(unfoldedSize(deep, 1000), 1001);
  });
});

describe('lambda-helpers/lambda-value:checkLambdaValue', () => {
  it('takes a value the host can write out', () => {
    checkLambdaValue({ result: ['a', 'b'], when: new Date(), bytes: new Uint8Array(4) });
  });

  it('refuses one that would take more than the limit', () => {
    let n = {};
    for (let i = 0; i < 40; i++) n = { a: n, b: n };

    assert.throws(() => checkLambdaValue(n), (err) => err.code === 'lambda_value_too_large');
  });
});
