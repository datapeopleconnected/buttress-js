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

describe('access-control/projection:filterGrantsByRequest', () => {
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
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
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
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
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
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
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
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
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
      () => AccessControlProjection.filterGrantsByRequest(req, policies, schema),
      /Can not access\/edit properties/,
    );
  });

  it('should throw on PUT when the update path only starts with a projected key', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['PUT'], schema: ['user'], query: {}, projection: { keys: ['name', 'address'] }, condition: null,
      },
    }];

    for (const path of ['nameSecret', 'addressHistory', 'address_street']) {
      await assert.rejects(
        () => AccessControlProjection.filterGrantsByRequest({ method: 'PUT', body: [{ path }] }, policies, schema),
        /Can not access\/edit properties/,
        path,
      );
    }

    const req = { method: 'PUT', body: [{ path: 'name' }, { path: 'address.street' }] };
    assert.strictEqual((await AccessControlProjection.filterGrantsByRequest(req, policies, schema)).length, 1);
  });

  it('should pass PUT when update path is in projection', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['PUT'], schema: ['user'], query: {}, projection: { keys: ['name'] }, condition: null,
      },
    }];

    const req = { method: 'PUT', body: [{ path: 'name' }] };
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('should handle %ALL% projection (null) without filtering', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: { verbs: ['GET'], schema: ['user'], query: {}, projection: null, condition: null },
    }];

    const req = { method: 'GET', body: { query: { anything: { $eq: 'value' } } } };
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
    assert.strictEqual(result.length, 1);
  });

  it('passes a grant it lets through on as it is', async () => {
    const policies = [{
      id: 'p1', name: 'test', appId: 'app1', env: null,
      config: {
        verbs: ['GET'], schema: ['user'], query: {}, projection: { keys: ['name', 'email'] }, condition: null,
      },
    }];

    const req = { method: 'GET', body: { query: { name: { $eq: 'test' } } } };
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
    assert.strictEqual(result[0], policies[0]);
    assert.deepStrictEqual(result[0].config.projection, { keys: ['name', 'email'] });
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
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
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
    const result = await AccessControlProjection.filterGrantsByRequest(req, policies, schema);
    assert.strictEqual(result.length, 0);
  });
});

// A policy projection limits which properties a request can write, whatever route or body shape writes them
describe('access-control/projection: writes limited by a policy projection', () => {
  const schema = {
    name: 'user',
    properties: {
      name: { __type: 'string', __default: null },
      role: { __type: 'string', __default: 'USER' },
      phone: {
        landline: { __type: 'string', __default: null },
        mobile: { __type: 'string', __default: null },
      },
    },
  };
  const policies = (keys, verbs = ['POST']) => [{
    id: 'p1', name: 'test', appId: 'app1', env: null,
    config: { verbs, schema: ['user'], query: {}, projection: { keys }, condition: null },
  }];
  const apply = (keys, body) =>
    AccessControlProjection.filterGrantsByRequest({ method: 'POST', body }, policies(keys), schema);

  it('refuses a bulk update of a property outside the projection', async () => {
    for (const body of [
      [{ id: 'u1', body: { path: 'role', value: 'ADMIN' } }],
      [{ id: 'u1', body: [{ path: 'name', value: 'x' }, { path: 'role', value: 'ADMIN' }] }],
      [{ id: 'u1', body: { path: 'phone.landline', value: '1' } }],
    ]) {
      await assert.rejects(apply(['name'], body), /Can not access\/edit properties/, JSON.stringify(body));
    }
  });

  it('allows a bulk update of the projected properties', async () => {
    const body = [{ id: 'u1', body: [{ path: 'name', value: 'x' }, { path: 'phone.mobile', value: '2' }] }];

    assert.strictEqual((await apply(['name', 'phone'], body)).length, 1);
  });

  it('resets the properties outside the projection on each entity a bulk add creates', async () => {
    const body = [{ name: 'a', role: 'ADMIN' }, { name: 'b', role: 'ADMIN' }];

    await apply(['name'], body);

    assert.deepStrictEqual(body, [{ name: 'a', role: 'USER' }, { name: 'b', role: 'USER' }]);
  });

  it('resets the properties of a nested group outside the projection on a created entity', async () => {
    const outside = { name: 'a', phone: { landline: '1', mobile: '2' } };
    const partly = { name: 'a', phone: { landline: '1', mobile: '2' } };
    const inside = { name: 'a', phone: { landline: '1', mobile: '2' } };

    await apply(['name'], outside);
    await apply(['name', 'phone.mobile'], partly);
    await apply(['name', 'phone'], inside);

    assert.deepStrictEqual(outside, { name: 'a', phone: { landline: null, mobile: null } });
    assert.deepStrictEqual(partly, { name: 'a', phone: { landline: null, mobile: '2' } });
    assert.deepStrictEqual(inside, { name: 'a', phone: { landline: '1', mobile: '2' } });
  });

  it('leaves a bulk delete, a list of ids, alone', async () => {
    const body = ['u1', 'u2'];

    assert.strictEqual((await apply(['name'], body)).length, 1);
    assert.deepStrictEqual(body, ['u1', 'u2']);
  });
});
