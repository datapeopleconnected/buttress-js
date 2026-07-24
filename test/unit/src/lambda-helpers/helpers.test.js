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

// `_createIsolateContext` wires every lambda-facing capability (fetch, crypto, email templates,
// PDF generation, ...) as `ivm.Reference` closures meant to run inside a live isolated-vm
// context; none of that is reachable without actually booting an isolate (which is what
// LambdaRunner's own tests intentionally avoid for speed). The only host-side state this module
// owns outside of that isolate boundary is the shared `lambdaResult` used by LambdaRunner.execute()
// to read back a lambda's `setResult()` call, so that's what's covered here.

import { describe, it } from 'mocha';
import assert from 'assert';

import LambdaHelpers from '../../../../dist/lambda-helpers/helpers.js';

describe('lambda-helpers/Helpers:initial state', () => {
  it('starts with no lambda result recorded', () => {
    assert.strictEqual(LambdaHelpers.lambdaResult, null);
  });

  it('treats 200/201/202 as the successful HTTP status codes for lambda fetch()', () => {
    assert.deepStrictEqual(LambdaHelpers.successfulHTTPScode, [200, 201, 202]);
  });
});
