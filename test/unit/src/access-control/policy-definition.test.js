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

import { checkPolicyConfig, checkPolicyConfigUpdate } from '../../../../dist/access-control/policy-definition.js';

const VERBS = ['GET', 'QUERY', 'SEARCH', 'POST', 'PUT', 'DELETE', '%ALL%'];
const valid = () => ({ verbs: ['GET', 'SEARCH'], schema: ['note'], query: { access: '%FULL_ACCESS%' } });

describe('access-control/policy-definition:checkPolicyConfig', () => {
  it('takes configs that read, with or without a projection, condition and env', () => {
    assert.deepStrictEqual(
      checkPolicyConfig([
        valid(),
        { ...valid(), verbs: ['%ALL%'], projection: { keys: ['text'] }, condition: { '#env.appId': { '@eq': 'x' } } },
        { ...valid(), projection: null, condition: null, env: null, endpoints: [] },
      ]),
      [],
    );
  });

  it('lists every problem that would leave a config granting nothing, or failing when evaluated', () => {
    assert.deepStrictEqual(
      checkPolicyConfig([
        { schema: ['note'] },
        { verbs: ['GET', 'FETCH'], schema: [], query: null },
        { ...valid(), projection: { keys: 'text' }, condition: 'yes' },
        'all',
      ]),
      [
        { path: 'config.0.verbs', code: 'required' },
        { path: 'config.0.query', code: 'required' },
        { path: 'config.1.verbs.1', code: 'enum', expected: VERBS, received: 'string' },
        { path: 'config.1.schema', code: 'required' },
        { path: 'config.1.query', code: 'required' },
        { path: 'config.2.projection.keys', code: 'type', expected: 'array' },
        { path: 'config.2.condition', code: 'type', expected: 'object' },
        { path: 'config.3', code: 'type', expected: 'object' },
      ],
    );
  });

  it('refuses a config that is not a list, or is empty', () => {
    assert.deepStrictEqual(checkPolicyConfig({}), [{ path: 'config', code: 'type', expected: 'array' }]);
    assert.deepStrictEqual(checkPolicyConfig([]), [{ path: 'config', code: 'required' }]);
  });
});

describe('access-control/policy-definition:checkPolicyConfigUpdate', () => {
  it('checks the configs, one config or one field of a config, that an update writes', () => {
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config', value: [valid()] }), []);
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config', value: [{ schema: ['note'], verbs: ['GET'] }] }), [
      { path: 'config.0.query', code: 'required' },
    ]);
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config.2', value: { verbs: ['GET'], schema: ['note'] } }), [
      { path: 'config.2.query', code: 'required' },
    ]);
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config.2.query', value: null }), [
      { path: 'config.2.query', code: 'required' },
    ]);
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config.2.verbs', value: ['GET'] }), []);
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'name', value: 'x' }), []);
  });
});
