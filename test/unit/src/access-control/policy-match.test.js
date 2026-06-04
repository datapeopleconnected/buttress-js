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

  it('should match case-insensitively for string values', () => {
    const policies = [{ selection: { role: { '@eq': 'ADMIN' } } }];
    const token = { policyProperties: { role: 'admin' } };
    const result = PolicyMatch.getTokenPolicies(policies, token);
    assert.deepStrictEqual(result, policies);
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

  it('should match using @in operator (selection values must be uppercase since lhs is uppercased)', () => {
    const policies = [{ selection: { role: { '@in': ['ADMIN', 'MODERATOR'] } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @in when value is not in the array', () => {
    const policies = [{ selection: { role: { '@in': ['ADMIN', 'MODERATOR'] } } }];
    const token = { policyProperties: { role: 'user' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @nin operator', () => {
    const policies = [{ selection: { role: { '@nin': ['USER', 'GUEST'] } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @nin when value is in the array', () => {
    const policies = [{ selection: { role: { '@nin': ['ADMIN', 'GUEST'] } } }];
    const token = { policyProperties: { role: 'admin' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
  });

  it('should match using @exists operator', () => {
    const policies = [{ selection: { features: { '@exists': 'premium' } } }];
    const token = { policyProperties: { features: 'premium,standard' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 1);
  });

  it('should not match with @exists when value is not contained', () => {
    const policies = [{ selection: { features: { '@exists': 'premium' } } }];
    const token = { policyProperties: { features: 'standard' } };
    assert.strictEqual(PolicyMatch.getTokenPolicies(policies, token).length, 0);
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
