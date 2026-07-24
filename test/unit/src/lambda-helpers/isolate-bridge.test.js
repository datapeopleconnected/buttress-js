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

// Most of IsolateBridge only makes sense once bound into a live isolated-vm context (every
// method it exposes to lambdas is an `ivm.Reference` closure meant to be invoked from inside
// the isolate), so it isn't practically unit-testable without spinning up a real isolate.
// `registerPlugins()` and `_pushLambdaExecutionLog` are the two pieces of host-side logic that
// run in plain Node and can be exercised directly.

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import fs from 'node:fs';

import IsolateBridge from '../../../../dist/lambda-helpers/isolate-bridge.js';

afterEach(() => {
  sinon.restore();
});

describe('lambda-helpers/IsolateBridge:registerPlugins', () => {
  it('registers no plugins when the configured plugins directory is empty', () => {
    IsolateBridge.registerPlugins();
    assert.deepStrictEqual(IsolateBridge._plugins, {});
  });

  it('does not throw and registers no plugins when the plugins directory cannot be read', () => {
    sinon.stub(fs, 'readdirSync').throws(new Error('ENOENT: no such file or directory'));

    assert.doesNotThrow(() => IsolateBridge.registerPlugins());
    assert.deepStrictEqual(IsolateBridge._plugins, {});
  });
});

describe('lambda-helpers/IsolateBridge:_pushLambdaExecutionLog', () => {
  it('always throws (the execution-id plumbing it needs was never resolved)', () => {
    assert.throws(
      () => IsolateBridge._pushLambdaExecutionLog('a log line', 'debug'),
      /Need to resolve where this\.lambdaExecution\.id is coming from/,
    );
  });
});
