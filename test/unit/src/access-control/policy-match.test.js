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

import PolicyMatch from '../../../../dist/access-control/policy-match.js';

describe('access-control/policy-match:getTokenPolicies', () => {
  it('should return an empty array if no policies are provided', () => {
    const result = PolicyMatch.getTokenPolicies([]);
    assert.deepStrictEqual(result, []);
  });

  it('should return an empty array if no token is provided', () => {
    const policies = [{ selection: { test: { '@eq': 'basic' } } }];
    const result = PolicyMatch.getTokenPolicies(policies);
    assert.deepStrictEqual(result, []);
  });

  it('should return an empty array if policies have no selection', () => {
    const policies = [{ name: 'no-selection' }];
    const token = { policyProperties: { test: 'basic' } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.deepStrictEqual(result, []);
  });
});

describe('access-control/policy-match:getTokenPolicies policyProperties value types', () => {
  it('should match when policy property value equals selection value (string)', () => {
    const policies = [{ selection: { test: { '@eq': 'basic' } } }];
    const token = { policyProperties: { test: 'basic' } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.deepStrictEqual(result, policies);
  });

  it('should match when policy property is an array containing the selection value', () => {
    const policies = [{ selection: { test: { '@eq': 'basic' } } }];
    const token = { policyProperties: { test: ['basic', 'other', 'abc'] } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.deepStrictEqual(result, policies);
  });

  it('compares text exactly, as a query does (D-32)', () => {
    const policies = [{ selection: { role: { '@eq': 'ADMIN' } } }];
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, { policyProperties: { role: 'admin' } }).length, 0);
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, { policyProperties: { role: 'ADMIN' } }).length, 1);
  });

  it('compares values within their type, so 1 is not "1"', () => {
    const policies = [{ selection: { level: { '@eq': 1 } } }];
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, { policyProperties: { level: '1' } }).length, 0);
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, { policyProperties: { level: 1 } }).length, 1);
  });

  it('should return empty array when policy property does not exist on token', () => {
    const policies = [{ selection: { missingKey: { '@eq': 'value' } } }];
    const token = { policyProperties: { otherKey: 'value' } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.deepStrictEqual(result, []);
  });

  it('should return empty array when token has no policyProperties', () => {
    const policies = [{ selection: { test: { '@eq': 'basic' } } }];
    const token = { type: 'user' };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.deepStrictEqual(result, []);
  });
});

describe('access-control/policy-match:getTokenPolicies Operations', () => {
  it('should match using @eq operator', () => {
    const policies = [{ selection: { role: { '@eq': 'admin' } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @eq when values differ', () => {
    const policies = [{ selection: { role: { '@eq': 'admin' } } }];
    const token = { policyProperties: { role: 'user' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @not operator', () => {
    const policies = [{ selection: { role: { '@not': 'admin' } } }];
    const token = { policyProperties: { role: 'user' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @not when values are equal', () => {
    const policies = [{ selection: { role: { '@not': 'admin' } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @gt operator', () => {
    const policies = [{ selection: { age: { '@gt': 18 } } }];
    const token = { policyProperties: { age: 25 } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @gt when value is lower', () => {
    const policies = [{ selection: { age: { '@gt': 18 } } }];
    const token = { policyProperties: { age: 15 } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @lt operator', () => {
    const policies = [{ selection: { age: { '@lt': 18 } } }];
    const token = { policyProperties: { age: 15 } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should match using @gte operator', () => {
    const policies = [{ selection: { age: { '@gte': 18 } } }];
    const token = { policyProperties: { age: 18 } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should match using @lte operator', () => {
    const policies = [{ selection: { age: { '@lte': 18 } } }];
    const token = { policyProperties: { age: 18 } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should match using @gtDate operator', () => {
    const policies = [{ selection: { expires: { '@gtDate': '2025-01-01' } } }];
    const token = { policyProperties: { expires: '2025-06-01' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @gtDate when date is before', () => {
    const policies = [{ selection: { expires: { '@gtDate': '2025-06-01' } } }];
    const token = { policyProperties: { expires: '2025-01-01' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @gteDate operator', () => {
    const policies = [{ selection: { expires: { '@gteDate': '2025-06-01' } } }];
    const token = { policyProperties: { expires: '2025-06-01' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should match using @ltDate operator', () => {
    const policies = [{ selection: { expires: { '@ltDate': '2025-06-01' } } }];
    const token = { policyProperties: { expires: '2025-01-01' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should match using @lteDate operator', () => {
    const policies = [{ selection: { expires: { '@lteDate': '2025-06-01' } } }];
    const token = { policyProperties: { expires: '2025-06-01' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should match using @rex operator (regex)', () => {
    const policies = [{ selection: { email: { '@rex': '^admin@' } } }];
    const token = { policyProperties: { email: 'admin@example.com' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @rex when regex does not match', () => {
    const policies = [{ selection: { email: { '@rex': '^admin@' } } }];
    const token = { policyProperties: { email: 'user@example.com' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @rexi operator (case-insensitive regex)', () => {
    const policies = [{ selection: { email: { '@rexi': '^ADMIN@' } } }];
    const token = { policyProperties: { email: 'admin@example.com' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should match using @in operator', () => {
    const policies = [{ selection: { role: { '@in': ['admin', 'moderator'] } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @in when the value is listed in another case', () => {
    const policies = [{ selection: { role: { '@in': ['ADMIN', 'MODERATOR'] } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match a token property list with @in when one of its values is listed', () => {
    const policies = [{ selection: { role: { '@in': ['admin', 'moderator'] } } }];
    const token = { policyProperties: { role: ['user', 'moderator'] } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @in when value is not in the array', () => {
    const policies = [{ selection: { role: { '@in': ['ADMIN', 'MODERATOR'] } } }];
    const token = { policyProperties: { role: 'user' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @nin operator', () => {
    const policies = [{ selection: { role: { '@nin': ['user', 'guest'] } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @nin when value is in the array', () => {
    const policies = [{ selection: { role: { '@nin': ['admin', 'guest'] } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @exists operator, which reads whether the token has the property', () => {
    const policies = [{ selection: { features: { '@exists': true } } }];
    const token = { policyProperties: { features: 'standard' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @exists false, as a selection only selects a token having each key it names', () => {
    const policies = [{ selection: { role: { '@eq': 'admin' }, features: { '@exists': false } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('needs every operator of a key to hold', () => {
    const policies = [{ selection: { age: { '@gte': 18, '@lt': 65 } } }];
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, { policyProperties: { age: 30 } }).length, 1);
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, { policyProperties: { age: 70 } }).length, 0);
  });

  it('should not match an operator it does not know', () => {
    const policies = [{ selection: { role: { '@like': 'admin' } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });
});

// D-35: a token is selected when every key of the selection holds for it, and only if it has each key named
describe('access-control/policy-match:getTokenPolicies selection with several keys', () => {
  const token = { policyProperties: { a: 1, b: 2, c: 3, d: 4 } };
  const select = (selection) => PolicyMatch.getTokenPolicies([{ selection }], token).length === 1;

  it('selects a token that matches every key', () => {
    assert(select({ a: { '@eq': 1 }, b: { '@eq': 2 } }));
    assert(select({ b: { '@eq': 2 }, c: { '@eq': 3 } }));
  });

  it("doesn't select a token that lacks one of the keys", () => {
    assert(!select({ a: { '@eq': 1 }, b: { '@eq': 2 }, e: { '@eq': 5 } }));
  });

  it("doesn't select a token that fails one of the keys", () => {
    assert(!select({ a: { '@eq': 1 }, b: { '@not': 2 } }));
    assert(!select({ a: { '@eq': 1 }, b: { '@eq': 3 } }));
  });

  it("doesn't select a token through a negation of a key it lacks", () => {
    assert(!select({ a: { '@eq': 1 }, role: { '@not': 'admin' } }));
    assert(!select({ a: { '@eq': 1 }, role: { '@nin': ['admin'] } }));
  });

  it('selects nothing with an empty selection', () => {
    assert(!select({}));
  });
});

describe('access-control/policy-match:getTokenPolicies selection with @and and @or', () => {
  const token = { policyProperties: { a: 1, b: 2, c: 3, d: 4 } };
  const select = (selection) => PolicyMatch.getTokenPolicies([{ selection }], token).length === 1;

  it('selects a token through @or when one branch holds', () => {
    assert(select({ '@or': [{ a: { '@eq': 9 } }, { b: { '@eq': 2 } }] }));
  });

  it("doesn't select a token through @or when no branch holds", () => {
    assert(!select({ '@or': [{ a: { '@eq': 9 } }, { e: { '@eq': 5 } }] }));
  });

  it('needs every key of an @or branch, and the token to have each of them', () => {
    assert(!select({ '@or': [{ a: { '@eq': 1 }, e: { '@eq': 5 } }, { b: { '@eq': 9 } }] }));
    assert(!select({ '@or': [{ a: { '@eq': 1 }, role: { '@not': 'admin' } }] }));
    assert(select({ '@or': [{ a: { '@eq': 1 }, b: { '@eq': 2 } }, { e: { '@eq': 5 } }] }));
  });

  it('needs every branch of @and to hold', () => {
    assert(select({ '@and': [{ a: { '@eq': 1 } }, { b: { '@eq': 2 } }] }));
    assert(!select({ '@and': [{ a: { '@eq': 1 } }, { b: { '@eq': 9 } }] }));
  });

  it('needs the keys beside an @or to hold as well', () => {
    assert(select({ a: { '@eq': 1 }, '@or': [{ b: { '@eq': 9 } }, { c: { '@eq': 3 } }] }));
    assert(!select({ a: { '@eq': 9 }, '@or': [{ b: { '@eq': 2 } }, { c: { '@eq': 3 } }] }));
  });

  it('nests @and within @or', () => {
    assert(select({ '@or': [{ '@and': [{ a: { '@eq': 1 } }, { d: { '@eq': 4 } }] }, { e: { '@eq': 5 } }] }));
  });

  it('selects nothing through an @and or @or that has no branches, or that is not a list', () => {
    assert(!select({ '@or': [] }));
    assert(!select({ '@and': [] }));
    assert(!select({ '@or': { a: { '@eq': 1 } } }));
    assert(!select({ '@or': [{}] }));
  });
});

describe('access-control/policy-match:selectionKeys', () => {
  it('lists every property a selection names, within @and and @or too', () => {
    const selection = { a: { '@eq': 1 }, '@or': [{ b: { '@eq': 2 } }, { '@and': [{ c: { '@eq': 3 } }, { a: { '@gt': 0 } }] }] };
    assert.deepStrictEqual(PolicyMatch.selectionKeys(selection).sort(), ['a', 'b', 'c']);
  });
});

describe('access-control/policy-match:getTokenPolicies dataSharing token', () => {
  it('should match a dataSharing token with correct #tokenType and id', () => {
    const policies = [{ selection: { '#tokenType': { '@eq': 'DATA_SHARING' }, id: { '@eq': 'share123' } } }];
    const token = { type: 'dataSharing', id: 'share123' };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.strictEqual(result.length, 1);
  });

  it('should not match a dataSharing token with wrong id', () => {
    const policies = [{ selection: { '#tokenType': { '@eq': 'DATA_SHARING' }, id: { '@eq': 'share123' } } }];
    const token = { type: 'dataSharing', id: 'other456' };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.strictEqual(result.length, 0);
  });

  it('should not match a non-dataSharing token against dataSharing policy', () => {
    const policies = [{ selection: { '#tokenType': { '@eq': 'DATA_SHARING' }, id: { '@eq': 'share123' } } }];
    const token = { type: 'user', policyProperties: { test: 'value' } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.strictEqual(result.length, 0);
  });
});

describe('access-control/policy-match:getTokenPolicies multiple policies', () => {
  it('should return matching policies only', () => {
    const policies = [
      { selection: { role: { '@eq': 'admin' } } },
      { selection: { role: { '@eq': 'user' } } },
      { selection: { role: { '@eq': 'moderator' } } },
    ];
    const token = { policyProperties: { role: 'admin' } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result, [policies[0]]);
  });

  it('should return multiple matching policies', () => {
    const policies = [
      { selection: { role: { '@eq': 'admin' } } },
      { selection: { department: { '@eq': 'engineering' } } },
    ];
    const token = { policyProperties: { role: 'admin', department: 'engineering' } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.strictEqual(result.length, 2);
  });
});
