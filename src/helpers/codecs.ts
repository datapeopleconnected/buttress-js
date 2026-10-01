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

import Sugar from './sugar.js';
import Datastore from '../datastore/index.js';

// A value read as its schema type, or why it couldn't be: the type it isn't, or `enum` for a string not listed
export type Decoded = { value: unknown } | { error: string };

// The parts of a property's schema a codec reads
export interface CodecConfig {
  __enum?: unknown[];
}

type Codec = (input: unknown, config: CodecConfig) => Decoded;

const BOOLEANS: Record<string, boolean> = { true: true, yes: true, '1': true, false: false, no: false, '0': false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (type: string): Decoded => ({ error: type });

/**
 * One codec per `__type`. Bodies, updates and query values all read their values through these, so a value is
 * converted, or refused, the same way wherever it's given.
 */
const CODECS: Record<string, Codec> = {
  boolean: (input) => {
    if (typeof input === 'boolean') return { value: input };
    if (input === 1 || input === 0) return { value: input === 1 };
    if (typeof input === 'string' && input.toLowerCase() in BOOLEANS) return { value: BOOLEANS[input.toLowerCase()] };
    return refuse('boolean');
  },
  number: (input) => {
    if (typeof input === 'number') return { value: input };
    if (typeof input === 'string' && !Number.isNaN(Number(input))) return { value: Number(input) };
    return refuse('number');
  },
  string: (input, config) => {
    if (typeof input !== 'string' && typeof input !== 'number') return refuse('string');
    const value = String(input);
    // An empty string is no value, which an enum doesn't have to list
    if (Array.isArray(config.__enum) && value && !config.__enum.includes(value)) return refuse('enum');
    return { value };
  },
  id: (input) => {
    const ID = Datastore.getInstance('core').ID;
    if (typeof input !== 'string' && (typeof input !== 'object' || !ID.isValid(input))) return refuse('id');
    try {
      return { value: ID.new(input as string) };
    } catch (_err) {
      return refuse('id');
    }
  },
  uuid: (input) => (typeof input === 'string' && UUID.test(input) ? { value: input } : refuse('uuid')),
  date: (input) => {
    if (typeof input !== 'string' && typeof input !== 'number' && !(input instanceof Date)) return refuse('date');
    const date = new Date(input);
    return Sugar.Date.isValid(date) ? { value: date } : refuse('date');
  },
  object: (input) => (typeof input === 'object' ? { value: input } : refuse('object')),
  array: (input) => (Array.isArray(input) ? { value: input } : refuse('array')),
};

/**
 * Reads `input` as a value of `type`. A type with no codec refuses everything.
 * @param {string} type - a property's `__type`, or an array's `__itemtype`
 * @param {unknown} input
 * @param {object} [config] - the property's schema, for a string's `__enum`
 * @return {Decoded}
 */
export function decode(type: string | undefined, input: unknown, config: CodecConfig = {}): Decoded {
  const codec = type ? CODECS[type] : undefined;
  return codec ? codec(input, config) : refuse(type ?? 'unknown');
}

export const isDecodeError = (decoded: Decoded): decoded is { error: string } => 'error' in decoded;
