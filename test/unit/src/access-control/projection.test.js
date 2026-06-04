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

import AccessControlProjection from '../../../../dist/access-control/projection.js';

describe('access-control/projection:filterPoliciesByPolicyProjection', () => {
  const schema = {
    name: 'user',
    properties: {
      name: { __type: 'string' },
      email: { __type: 'string' },
      age: { __type: 'number' },
    },
  };

  it('should pass through policies with null projection', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    }];

    const req = { method: 'GET', body: { query: {} } };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('should pass through policies with valid projection on GET', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name', 'email'] }, condition: null,
      },
    }];

    const req = { method: 'GET', body: { query: { name: { $eq: 'test' } } } };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('should reject GET when query key is not in projection', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name'] }, condition: null,
      },
    }];

    const req = { method: 'GET', body: { query: { email: { $eq: 'test@test.com' } } } };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 0);
  });

  it('should pass POST when body keys are within projection', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['POST'], schema: ['user'], query: {}, projection: { keys: ['name', 'email'] }, condition: null,
      },
    }];

    const req = { method: 'POST', body: { name: 'Test', email: 'test@test.com' } };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('should throw on PUT when update path is not in projection', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['PUT'], schema: ['user'], query: {}, projection: { keys: ['name'] }, condition: null,
      },
    }];

    const req = { method: 'PUT', body: [{ path: 'email' }] };

    await assert.rejects(
      () => AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema),
      /Can not access\/edit properties/,
    );
  });

  it('should pass PUT when update path is in projection', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['PUT'], schema: ['user'], query: {}, projection: { keys: ['name'] }, condition: null,
      },
    }];

    const req = { method: 'PUT', body: [{ path: 'name' }] };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('should handle %ALL% projection (null) without filtering', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    }];

    const req = { method: 'GET', body: { query: { anything: { $eq: 'value' } } } };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('should set projection keys to 1 in the result', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name', 'email'] }, condition: null,
      },
    }];

    const req = { method: 'GET', body: { query: { name: { $eq: 'test' } } } };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.deepStrictEqual(result[0].config.projection, { name: 1, email: 1 });
  });

  it('should handle logical operators in GET query ($and/$or)', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name', 'age'] }, condition: null,
      },
    }];

    const req = {
      method: 'GET',
      body: {
        query: {
          $and: [{ name: { $eq: 'test' } }, { age: { $gt: 18 } }],
        },
      },
    };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('should reject GET when logical operator query uses keys outside projection', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name'] }, condition: null,
      },
    }];

    const req = {
      method: 'GET',
      body: {
        query: {
          $and: [{ name: { $eq: 'test' } }, { email: { $eq: 'test@test.com' } }],
        },
      },
    };
    const result = await AccessControlProjection.filterPoliciesByPolicyProjection(req, policies, schema);
    assert.strictEqual(result.length, 0);
  });
});
