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

// A policy naming an operator nothing knows is refused when it's saved, rather than granting nothing, or failing,
// when it's evaluated (R3 step 7)
describe('access-control/policy-definition:checkPolicyConfig operators', () => {
  it('takes the operators the registry knows, in a query and in a condition, in their @ and $ names', () => {
    assert.deepStrictEqual(
      checkPolicyConfig([
        { ...valid(), query: { age: { '@gte': 18, $lt: 65 }, '@or': [{ name: { '@rexi': 'a' } }], address: { city: 'x' } } },
        { ...valid(), condition: { '@or': [{ '#env.appId': { '@eq': 'x' } }, { '#env.date.now': { $gtDate: '2025-01-01' } }] } },
      ]),
      [],
    );
  });

  it('refuses a query naming an operator nothing knows', () => {
    assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), query: { name: { '@foo': 'x' } } }]), [
      { path: 'config.0.query.name', code: 'unknown_operator', received: '@foo' },
    ]);
    assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), query: { '@or': [{ name: { $regx: 'a' } }] } }]), [
      { path: 'config.0.query.name', code: 'unknown_operator', received: '$regx' },
    ]);
  });

  it("takes an @elMatch whose item query has its own @or, and checks the operators in that", () => {
    assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), query: { lines: { '@elMatch': { '@or': [{ sku: 'a' }, { qty: { '@gt': 1 } }] } } } }]), []);
    assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), query: { lines: { '@elMatch': { '@or': [{ sku: { '@foo': 1 } }] } } } }]), [
      { path: 'config.0.query.sku', code: 'unknown_operator', received: '@foo' },
    ]);
  });

  it('refuses a condition naming an operator nothing knows, or a list conditions don\'t take', () => {
    assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), condition: { '#env.appId': { '@like': 'x' } } }]), [
      { path: 'config.0.condition.#env.appId', code: 'unknown_operator', received: '@like' },
    ]);
    assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), condition: { '@nor': [{ '#env.appId': { '@eq': 'x' } }] } }]), [
      { path: 'config.0.condition', code: 'unknown_operator', received: '@nor' },
    ]);
    assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), condition: { '@and': [{ '#env.appId': { $foo: 'x' } }] } }]), [
      { path: 'config.0.condition.@and.0.#env.appId', code: 'unknown_operator', received: '$foo' },
    ]);
  });

  it('checks the operators an update writes to a config', () => {
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config.0.query', value: { name: { '@foo': 'x' } } }), [
      { path: 'config.0.query.name', code: 'unknown_operator', received: '@foo' },
    ]);
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config.0', value: { ...valid(), condition: { '#env.x': { '@like': 1 } } } }), [
      { path: 'config.0.condition.#env.x', code: 'unknown_operator', received: '@like' },
    ]);
  });
});

// An operand an operator can't take is refused when the policy is saved, as a search giving one is, rather than the
// config granting nothing when it's evaluated (R3 step 7)
describe('access-control/policy-definition:checkPolicyConfig operands', () => {
  it("refuses an operand the operator can't take", () => {
    assert.deepStrictEqual(
      checkPolicyConfig([
        { ...valid(), query: { tags: { '@in': 'red' }, name: { '@rex': '(' }, sku: { '@inProp': 5 }, lines: { '@elMatch': 'x' } } },
      ]),
      [
        { path: 'config.0.query.tags', code: 'type', expected: 'array' },
        { path: 'config.0.query.name', code: 'type', expected: 'pattern' },
        { path: 'config.0.query.sku', code: 'type', expected: 'string' },
        { path: 'config.0.query.lines', code: 'type', expected: 'object' },
      ],
    );
  });

  it('refuses a logical operator not given a list of one or more queries', () => {
    for (const [query, path] of [
      [{ '@or': { a: 1 } }, 'config.0.query.@or'],
      [{ '@and': [] }, 'config.0.query.@and'],
      [{ '@nor': ['x'] }, 'config.0.query.@nor'],
      [{ '@or': [{ '@and': '#env.x' }] }, 'config.0.query.@and'],
    ]) {
      assert.deepStrictEqual(checkPolicyConfig([{ ...valid(), query }]), [{ path, code: 'type', expected: 'array' }], JSON.stringify(query));
    }
  });

  it('checks the operands in an @elMatch, and takes an #env value for any operand, as it is read later', () => {
    assert.deepStrictEqual(
      checkPolicyConfig([
        {
          ...valid(),
          query: {
            scores: { '@elMatch': { '@in': 3 } },
            lines: { '@elMatch': { sku: { '@rex': '(' } } },
            tags: { '@in': '#env.user.tags' },
            name: { '@rex': '#env.pattern' },
          },
        },
      ]),
      [
        { path: 'config.0.query.scores', code: 'type', expected: 'array' },
        { path: 'config.0.query.sku', code: 'type', expected: 'pattern' },
      ],
    );
  });

  it("refuses a condition's criterion that isn't an object of one or more operators, a logical operator without a list, and an operand an operator can't take", () => {
    assert.deepStrictEqual(
      checkPolicyConfig([
        {
          ...valid(),
          condition: {
            '#env.x': {},
            '#env.y': 'z',
            '@or': 'w',
            '#env.role': { '@in': 'admin' },
            '#env.user.role': { '@in': '#env.roles' },
          },
        },
      ]),
      [
        { path: 'config.0.condition.#env.x', code: 'required' },
        { path: 'config.0.condition.#env.y', code: 'type', expected: 'object' },
        { path: 'config.0.condition.@or', code: 'type', expected: 'array' },
        { path: 'config.0.condition.#env.role', code: 'type', expected: 'array' },
      ],
    );
  });

  it('checks the operands an update writes to a config', () => {
    assert.deepStrictEqual(checkPolicyConfigUpdate({ path: 'config.0.query', value: { tags: { '@in': 'x' } } }), [
      { path: 'config.0.query.tags', code: 'type', expected: 'array' },
    ]);
  });

  it('takes the operands each operator can, in a query and in a condition', () => {
    assert.deepStrictEqual(
      checkPolicyConfig([
        {
          ...valid(),
          query: {
            tags: { '@in': ['a'], '@nin': [], '@all': ['b'] },
            name: { '@rexi': '^a', '@inProp': 'a.b' },
            lines: { '@elMatch': { sku: 'x' } },
            '@or': [{ a: 1 }],
          },
        },
        { ...valid(), condition: { '@and': [{ '#env.appId': { '@in': ['x'] } }], '#env.date.now': { '@gtDate': '2025-01-01' } } },
      ]),
      [],
    );
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
