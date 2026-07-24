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

import LambdaManager from '../../../../dist/lambda/lambda-manager.js';

function createManager() {
  const nrp = { on: () => {}, emit: () => {} };
  const services = { get: (key) => (key === 'nrp' ? nrp : undefined) };
  return new LambdaManager(services);
}

// Stub out the parts of execution creation that would otherwise hit the real
// model/DB layer, and record what was "created" so tests can assert on it.
function stubExecutionCreation(manager) {
  const createdExecutions = [];
  manager._createLambdaExecution = async (_triggerType, lambdaId) => {
    const id = `exec-${createdExecutions.length + 1}`;
    createdExecutions.push({ id, lambdaId });
    return { id };
  };
  manager._processQueue = async () => {};
  return createdExecutions;
}

// The debounce timer is just scheduling — fire the underlying handler directly
// instead of waiting out the real 1s debounce window in every test.
async function fireDebounceTimer(manager, id) {
  const record = manager._debouncedPathMutations.find((r) => r.id === id);
  if (record?.timer) clearTimeout(record.timer);
  await manager._createLambdaPathMutationExecution(id);
}

describe('lambda/LambdaManager path-mutation debounce', () => {
  const cr = { paths: ['schema.field'], values: ['x'], schema: 'schema' };

  it('debounces and executes every lambda matching a write, not just the first', async () => {
    const manager = createManager();
    const createdExecutions = stubExecutionCreation(manager);

    const lambdaA = { id: 'lambda-a', gitHash: 'hash-a', type: 'PATH_MUTATION', appId: 'app-1' };
    const lambdaB = { id: 'lambda-b', gitHash: 'hash-b', type: 'PATH_MUTATION', appId: 'app-1' };

    await manager._debounceLambdaTriggers([lambdaA, lambdaB], cr);

    assert.strictEqual(
      manager._debouncedPathMutations.length,
      2,
      'both matching lambdas should get their own debounce record',
    );

    for (const id of manager._debouncedPathMutations.map((r) => r.id)) {
      await fireDebounceTimer(manager, id);
    }

    assert.strictEqual(createdExecutions.length, 2);
    assert.deepStrictEqual(createdExecutions.map((e) => e.lambdaId).sort(), ['lambda-a', 'lambda-b']);
  });

  it('lets a later identical write trigger a new execution once the previous debounce has completed', async () => {
    const manager = createManager();
    const createdExecutions = stubExecutionCreation(manager);
    const lambdaA = { id: 'lambda-a', gitHash: 'hash-a', type: 'PATH_MUTATION', appId: 'app-1' };

    await manager._debounceLambdaTriggers([lambdaA], cr);
    assert.strictEqual(manager._debouncedPathMutations.length, 1);

    await fireDebounceTimer(manager, manager._debouncedPathMutations[0].id);

    assert.strictEqual(createdExecutions.length, 1);
    assert.strictEqual(
      manager._debouncedPathMutations.length,
      0,
      'the completed debounce record must be removed, not left behind',
    );

    // The exact same change (same lambda, same change hash) arrives again later.
    await manager._debounceLambdaTriggers([lambdaA], cr);
    assert.strictEqual(
      manager._debouncedPathMutations.length,
      1,
      'a repeat write must start a fresh debounce record rather than being silently dropped',
    );

    await fireDebounceTimer(manager, manager._debouncedPathMutations[0].id);

    assert.strictEqual(createdExecutions.length, 2, 'the repeat write must produce a second execution');
  });
});
