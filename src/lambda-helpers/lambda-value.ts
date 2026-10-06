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

import ivm from 'isolated-vm';

import Logging from '../helpers/logging.js';

// The most a value a lambda gives a host function can take written out as JSON. The isolate's heap is no bigger, so
// only a value that refers to some of its objects more than once can get past it.
export const MAX_LAMBDA_VALUE_BYTES = 128 * 1024 * 1024;

/**
 * Why a value a lambda gave a host function is refused: it refers to itself, or written out as JSON it would take more
 * than the host can.
 */
export class LambdaValueError extends Error {
  readonly code: 'lambda_value_circular' | 'lambda_value_too_large';

  constructor(code: LambdaValueError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Roughly how many bytes `value` takes written out as JSON, an object counted each time it's reached, as
 * JSON.stringify writes it, but walked once: a value that refers to its objects many times over, which would unfold
 * to more than anyone can hold, is measured in time as it's held. Counting stops past `limit`.
 * @param {unknown} value - a value copied out of the isolate
 * @param {number} limit
 * @return {number} its size, or one more than `limit` for anything bigger
 * @throws {LambdaValueError} for a value that refers to itself
 */
export const unfoldedSize = (value: unknown, limit: number = MAX_LAMBDA_VALUE_BYTES): number => {
  const measured = new Map<object, number>();
  const walking = new Set<object>();

  const measure = (item: unknown): number => {
    if (typeof item === 'string') return item.length + 2;
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'bigint') return String(item).length;
    if (item === null || typeof item !== 'object') return 4;
    if (item instanceof Date) return 26;
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return item.byteLength;

    const known = measured.get(item);
    if (known !== undefined) return known;
    if (walking.has(item)) throw new LambdaValueError('lambda_value_circular', 'The value refers to itself');
    walking.add(item);

    let size = 2;
    const entries: [string | null, unknown][] =
      item instanceof Map
        ? [...item.entries()].map(([key, entry]) => [String(key), entry])
        : Array.isArray(item) || item instanceof Set
          ? [...item].map((entry) => [null, entry])
          : Object.entries(item);
    for (const [key, entry] of entries) {
      size += (key === null ? 0 : key.length + 3) + measure(entry) + 1;
      if (size > limit) break;
    }

    walking.delete(item);
    const capped = Math.min(size, limit + 1);
    measured.set(item, capped);
    return capped;
  };

  try {
    return Math.min(measure(value), limit + 1);
  } catch (err: unknown) {
    // Nested deeper than the stack goes, which JSON.stringify can't write either
    if (err instanceof RangeError) return limit + 1;
    throw err;
  }
};

/**
 * Refuses a value a lambda gave a host function that the host can't take: one that refers to itself, or that would
 * take more than MAX_LAMBDA_VALUE_BYTES written out.
 * @param {unknown} value
 * @throws {LambdaValueError}
 */
export const checkLambdaValue = (value: unknown): void => {
  if (unfoldedSize(value) > MAX_LAMBDA_VALUE_BYTES) {
    throw new LambdaValueError(
      'lambda_value_too_large',
      `The value would take more than ${MAX_LAMBDA_VALUE_BYTES / 1024 / 1024} MB written out`,
    );
  }
};

/**
 * The error a host function's call is rejected with, copied for the isolate, when the lambda gave it a value the host
 * can't take (checkLambdaValue), or null for one it can.
 * @param {unknown} value
 * @return {unknown}
 */
export const refusedValue = (value: unknown) => {
  try {
    checkLambdaValue(value);
    return null;
  } catch (err: unknown) {
    if (!(err instanceof LambdaValueError)) throw err;
    Logging.logWarn(`Refused a lambda's value: ${err.message}`);
    return new ivm.ExternalCopy(new ivm.Reference(err).copySync()).copyInto();
  }
};
