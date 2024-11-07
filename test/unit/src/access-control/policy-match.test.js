/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

const {describe, it} = require('mocha');
const assert = require('assert');

const {default: PolicyMatch} = require('../../../../dist/access-control/policy-match');

describe('access-control/policy-match:getTokenPolicies', () => {
  it('should return an empty array if no policies are provided', () => {
    const result = PolicyMatch.getTokenPolicies([]);
    assert.deepStrictEqual(result, []);
  });

  it('should return an empty array if no token is provided', () => {
    const policies = [{ selection: { 'test': { '@eq': 'basic' } } }];
    const result = PolicyMatch.getTokenPolicies(policies);
    assert.deepStrictEqual(result, []);
  });
});

describe('access-control/policy-match:getTokenPolicies policyProperties value types', () => {
  it('should handle a simple equal selection where the policy property value is a string', () => {
    const policies = [{ selection: { 'test': { '@eq': 'basic' } } }];
    const result = PolicyMatch.getTokenPolicies(policies, { policyProperties: { test: 'basic' } });
    assert.deepStrictEqual(result, policies);
  });

  it('should handle a simple equal selection where the policy property value is a array', () => {
    const policies = [{ selection: { 'test': { '@eq': 'basic' } } }];
    const result = PolicyMatch.getTokenPolicies(policies, { policyProperties: { test: ['basic', 'other', 'abc'] } });
    assert.deepStrictEqual(result, policies);
  });
});

describe('access-control/policy-match:getTokenPolicies Operations', () => {
  // TODO: Write tests for the following.
  // @eq
  // @not
  // @gt
  // @lt
  // @gte
  // @lte
  // @gtDate
  // @gteDate
  // @ltDate
  // @lteDate
  // @rex
  // @rexi
  // @in
  // @nin
  // @exists
});