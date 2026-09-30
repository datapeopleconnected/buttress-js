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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Errors from '../../../../dist/helpers/errors.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../dist');

// Every compiled source file but the errors module itself, with its path from dist/
const sources = () =>
  fs
    .readdirSync(DIST, { recursive: true })
    .filter((file) => file.endsWith('.js') && file !== path.join('helpers', 'errors.js'))
    .map((file) => ({ file, code: fs.readFileSync(path.join(DIST, file), 'utf8') }));

const STATUS_OF_FACTORY = {
  badRequest: 400,
  unauthorised: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  unavailable: 503,
};

// Each `Errors.<factory>('<code>'` in the compiled code, with the status the factory gives. A code built at run time
// (a template) is left out.
const usesOfCodes = () =>
  sources().flatMap(({ file, code }) =>
    [...code.matchAll(/Errors\.(\w+)\(\s*['"`]([a-z][A-Za-z0-9_]*)['"`]/g)]
      .filter(([, factory]) => factory in STATUS_OF_FACTORY)
      .map(([, factory, errorCode]) => ({ file, code: errorCode, status: STATUS_OF_FACTORY[factory] })),
  );

describe('helpers/errors: the codes the API answers with', () => {
  it('finds the codes in the compiled routes, so the checks below have something to check', () => {
    const codes = new Set(usesOfCodes().map((use) => use.code));

    for (const code of ['invalid_id', 'missing_token', 'insufficient_authority', 'not_found', 'invalid_update']) {
      assert.ok(codes.has(code), `${code} isn't used`);
    }
  });

  it('answers each code with one status, wherever it is used', () => {
    const statuses = new Map();
    for (const use of usesOfCodes()) {
      statuses.set(use.code, [...(statuses.get(use.code) ?? []), use]);
    }

    const mixed = [...statuses.entries()]
      .filter(([, uses]) => new Set(uses.map((use) => use.status)).size > 1)
      .map(([code, uses]) => `${code}: ${uses.map((use) => `${use.status} in ${use.file}`).join(', ')}`);
    assert.deepStrictEqual(mixed, []);
  });

  it('answers not_found with 404, as entityNotFound does', () => {
    assert.strictEqual(Errors.entityNotFound('policy', 'x').status, 404);
    const elsewhere = usesOfCodes().filter((use) => use.code === 'not_found' && use.status !== 404);
    assert.deepStrictEqual(elsewhere, []);
  });

  it('leaves no error type but ApiError for a route to answer with', () => {
    assert.strictEqual(Errors.RequestError, undefined);
    const uses = sources().filter(({ code }) => /\bRequestError\b/.test(code)).map(({ file }) => file);
    assert.deepStrictEqual(uses, []);
  });
});
