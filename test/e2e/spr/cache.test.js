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

import assert from 'assert';

import * as redis from '@redis/client';

import { io } from 'socket.io-client';
import { describe, it, before, after } from 'mocha';

import NRP from '../../../dist/services/nrp.js';

import Config from '../../config.js';

import {
  bjsReq,
  createApp,
  createLambda,
  createPolicy,
  createPolicyUser,
  updateSchema,
  registerDataSharing,
  updateUserPolicyProperties,
  extractPolicyPropertyListFromPolicies,
  ENDPOINT,
} from '../../helpers.js';

import BootstrapRest from '../../../dist/bootstrap-rest.js';
import BootstrapSocketPolicyRouter from '../../../dist/bootstrap-spr.js';
import BootstrapSocket from '../../../dist/bootstrap-socket.js';

// const { default: PolicyTestData } = await import('../../data/policy/index.js');

import PolicyTestData from '../../data/policy/index.js';

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Cache', async () => {
  const TestPolicies = [
    PolicyTestData['admin-access'],
    PolicyTestData['cache-test-1'],
    PolicyTestData['cache-test-2'],
  ];

  const PolicyPropertyList = extractPolicyPropertyListFromPolicies(TestPolicies);

  let REDIS_CLIENT = null;
  let NRP_INSTANCE = null;

  let REST_PROCESS = null;
  let SPR_PROCESS = null;
  let SOCK_PROCESS = null;

  const testEnv = {
    apps: {},
    users: {},
    sockets: {},
    policies: {},
    tokens: {},
  };

  const subs = {};

  const carsSchema = {
    name: 'car',
    type: 'collection',
    properties: {
      name: {
        __type: 'string',
        __default: null,
        __required: true,
        __allowUpdate: true,
      },
      userId: {
        __type: 'id',
        __default: null,
        __required: true,
        __allowUpdate: true,
      },
      status: {
        __type: 'string',
        __default: "ACTIVE",
        __required: true,
        __allowUpdate: true,
      },
      colour: {
        __type: 'string',
        __default: null,
        __required: false,
        __allowUpdate: true,
      },
      createdAt: {
        __type: 'date',
        __default: "now",
        __required: true,
        __allowUpdate: true,
      }
    },
  };

  const createUserSocket = async (name, app = 'app1') => {
    return await createTokenSocket(name, testEnv.users[name].tokens[0].value, app, testEnv);
  };

  const createTokenSocket = async (name, token, app = 'app1', testEnv) => {
    testEnv.sockets[name] = io(`${ENDPOINT.SOCK}/${testEnv.apps[app].apiPath}`, {
      auth: { token: token },
      forceNew: true
    });

    return await new Promise((resolve) => testEnv.sockets[name].once('connect', () => resolve(testEnv.sockets[name])));
  };

  const createAppWithSchema = async (ref, name, path, policyProps) => {
    testEnv.apps[ref] = await createApp(ENDPOINT.REST, name, path, policyProps);
    testEnv.apps[ref].schema = await updateSchema(ENDPOINT.REST, [
      carsSchema,
      {
        name: 'selector',
        type: 'collection',
        properties: {
          name: {
            __type: 'string',
            __default: null,
            __required: true,
            __allowUpdate: true,
          },
          value: {
            __type: 'string',
            __default: null,
            __required: true,
            __allowUpdate: true,
          },
        },
      }
    ], testEnv.apps[ref].token);
  };

  before(async function () {
    this.timeout(20000);

    REDIS_CLIENT = redis.createClient({ url: Config.redis.url });
    await REDIS_CLIENT.connect();

    NRP_INSTANCE = new NRP(Config.redis);
    await NRP_INSTANCE.connect();

    REST_PROCESS = new BootstrapRest();
    await REST_PROCESS.init();

    SPR_PROCESS = new BootstrapSocketPolicyRouter();
    await SPR_PROCESS.init();

    SOCK_PROCESS = new BootstrapSocket();
    await SOCK_PROCESS.init();

    // Create an app
    await createAppWithSchema('app1', 'Test SPR cache', 'test-spr-cache', PolicyPropertyList);

    for await (const policy of TestPolicies) {
      const pol = await createPolicy(ENDPOINT.REST, policy, testEnv.apps.app1.token);
      testEnv.policies[pol.id] = pol; 
    }

    // Create a user to test with
    testEnv.users['cache-test-1'] = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'cache-test-1', { cacheTest: 1 });

    const usersKeys = Object.keys(testEnv.users);
    const colours = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'brown', 'black', 'white'];
    await bjsReq({
      url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/add`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(new Array(20).fill(0).map((val, idx) => ({
        name: `name-${Math.floor(Math.random() * 100)}`,
        colour: colours[idx % colours.length],
        userId: testEnv.users[usersKeys[idx % usersKeys.length]].id,
      }))),
    }, testEnv.apps.app1.token);

    await bjsReq({
      url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/selector`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `example-selector`,
        value: 'red',
      }),
    }, testEnv.apps.app1.token);
  });

  after(async function () {
    Object.values(testEnv.sockets).forEach((socket) => socket.close());

    Object.values(subs).forEach((fn) => fn());

    await REDIS_CLIENT.quit();

    await NRP_INSTANCE.quit();

    if (REST_PROCESS) await REST_PROCESS.clean();
    if (SPR_PROCESS) await SPR_PROCESS.clean();
    if (SOCK_PROCESS) await SOCK_PROCESS.clean();
  });

  describe('Basic', () => {

    it('Should cache a token, policy and the link if a token is connected', async () => {
      const [token] = testEnv.users['cache-test-1'].tokens;

      const connectedTokensKey = `${Config.redis.scope}connected-tokens`;
      const tokenPoliciesKey = `${Config.redis.scope}token:${token.id}:policies`;

      // Make sure the token is not connected nor cached yet.
      assert.strictEqual(await REDIS_CLIENT.zScore(connectedTokensKey, token.id), null);
      assert.strictEqual(await REDIS_CLIENT.exists(tokenPoliciesKey), 0, 'Token should not be cached yet');

      await createUserSocket('cache-test-1');

      // Wait for the SPR to resolve the token policies
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check that the token is now connected and cached
      assert.notEqual(await REDIS_CLIENT.zScore(connectedTokensKey, token.id), null);
      assert.strictEqual(await REDIS_CLIENT.exists(tokenPoliciesKey), 1, 'Token should be cached now');

      const policyIds = await REDIS_CLIENT.sMembers(tokenPoliciesKey);
      assert(policyIds.length > 0, 'Token should have policies cached');

      // Check that the policies are cached
      for (const policyId of policyIds) {
        assert.strictEqual(await REDIS_CLIENT.hExists(`${Config.redis.scope}policies`, policyId), 1, `Policy ${policyId} should be cached`);

        assert.strictEqual(
          await REDIS_CLIENT.exists(`${Config.redis.scope}policy:${policyId}:tokens`),
          1, `Policy ${policyId} should be cached`);
      }
    });

    it('Should mark a Token as STALE if the policy properties change', async () => {
      const [token] = testEnv.users['cache-test-1'].tokens;

      // Check that the current token cache isn't already stale
      const tokenPoliciesKey = `${Config.redis.scope}token:${token.id}:policies`;
      const policyIdsBefore = await REDIS_CLIENT.sMembers(tokenPoliciesKey);
      assert(policyIdsBefore.length > 0, 'Token should have policies cached');

      // Update the token policy properties to trigger a cache refresh
      await updateUserPolicyProperties(
        ENDPOINT.REST, testEnv.users['cache-test-1'].id, {
          cacheTest: 2,
        }, token.value, testEnv.apps.app1.token
      );

      // The token cache should now be marked as STALE
      const policyIdsAfter = await REDIS_CLIENT.sMembers(tokenPoliciesKey);
      assert(policyIdsAfter.includes('STALE'), 'Token policies should be marked as STALE after properties change');

      // Make any scucessful request to the API to trigger a cache refresh
      const cars = await bjsReq({
        url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, token.value);
      assert(Array.isArray(cars), 'Should be able to fetch cars after policy properties change');
      assert.strictEqual(cars.length, 4, 'Should return 4 cars, 2 green and 2 red');

      const policyIdsRefreshed = await REDIS_CLIENT.sMembers(tokenPoliciesKey);
      assert(!policyIdsRefreshed.includes('STALE'), 'Token policies should no longer be marked as STALE after a successful request');
    });

    it('Should remove a policy from the cache if deleted', async () => {
      const [token] = testEnv.users['cache-test-1'].tokens;

      // Get the policyId from testEnv.policies for cache-test-1
      const policyId = Object.keys(testEnv.policies).find(id => testEnv.policies[id].name === 'cache-test-1');

      // Make sure the policy is cached within redis
      assert.strictEqual(await REDIS_CLIENT.hExists(`${Config.redis.scope}policies`, policyId), 1, `Policy ${policyId} should be cached`);

      // Delete the policy
      const del = await bjsReq({
        url: `${ENDPOINT.REST}/api/v1/policy/${policyId}`,
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }, testEnv.apps.app1.token);
      assert.strictEqual(del, true, 'Policy should be deleted successfully');

      // Make sure the policy is no longer cached within redis
      assert.strictEqual(await REDIS_CLIENT.hExists(`${Config.redis.scope}policies`, policyId), 0, `Policy ${policyId} should no longer be cached`);

      // Make any scucessful request to the API should now return just two cars.
      const cars = await bjsReq({
        url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, token.value);
      assert(Array.isArray(cars), 'Should be able to fetch cars after policy properties change');
      assert.strictEqual(cars.length, 2, 'Should return 2 green cars');
    });

    it('Should link tokens to a new policy, if a new policy is added', async () => {
      const [token] = testEnv.users['cache-test-1'].tokens;

      // Re-adding the policy should trigger the cache to asesss if a link can be made with some tokens.
      const newPolicy = await createPolicy(ENDPOINT.REST, PolicyTestData['cache-test-1'], testEnv.apps.app1.token);

      // Wait 100ms for the SPR to process the new policy.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The user token should now have a stale flag as the policy selection is a close match to it's properties.
      const tokenPoliciesKey = `${Config.redis.scope}token:${token.id}:policies`;
      const policyIds = await REDIS_CLIENT.sMembers(tokenPoliciesKey);
      assert(policyIds.includes('STALE'), 'Token should have been marked as STALE');

      // Making a request with the token should now return 4 cars again as the policy will be matched & cached.
      const cars = await bjsReq({
        url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, token.value);
      assert(Array.isArray(cars), 'Should be able to fetch cars after policy properties change');
      assert.strictEqual(cars.length, 4, 'Should return 4 cars, 2 green and 2 red');

      // The policy should exists within the cache
      assert.strictEqual(await REDIS_CLIENT.hExists(`${Config.redis.scope}policies`, newPolicy.id), 1, `Policy ${newPolicy.id} should be cached`);
    });

    it('Should clean up the old cache / index references if policy properties are changed.', async () => {
      const [token] = testEnv.users['cache-test-1'].tokens;

      // verify that the token:id:policies cache exists
      const tokenPoliciesKey = `${Config.redis.scope}token:${token.id}:policies`;
      assert.strictEqual(await REDIS_CLIENT.exists(tokenPoliciesKey), 1, 'Token policies cache should exist');

      // verify that the policy:id:tokens cache contains the token
      const initalPolicyIds = await REDIS_CLIENT.sMembers(tokenPoliciesKey);
      assert(initalPolicyIds.length > 0, 'Token should have policies cached');
      for (const policyId of initalPolicyIds) {
        assert.strictEqual(await REDIS_CLIENT.sIsMember(`${Config.redis.scope}policy:${policyId}:tokens`, token.id), 1, `Policy ${policyId} should have the token cached`);
      }

      const propertyIndex = `cacheTest`;

      // verify that the token:id:policy-properties contains propertyIndex
      const tokenPolicyPropertiesKey = `${Config.redis.scope}token:${token.id}:policyProperties`;
      assert.strictEqual(await REDIS_CLIENT.sIsMember(tokenPolicyPropertiesKey, propertyIndex), 1, `Token should have policy property ${propertyIndex} cached`);

      // verify that the policy:propertyIndex:<property> index exists for propertyIndex
      const propertyIndexKey = `${Config.redis.scope}policy:propertyIndex:${propertyIndex}`;
      assert.strictEqual(await REDIS_CLIENT.exists(propertyIndexKey), 1, `Policy property index for ${propertyIndex} should exist`);

      await updateUserPolicyProperties(
        ENDPOINT.REST, testEnv.users['cache-test-1'].id, {
          adminAccess: true,
        }, token.value, testEnv.apps.app1.token
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Make a request to trigger the cache refresh
      await bjsReq({
        url: `${ENDPOINT.REST}/${testEnv.apps.app1.apiPath}/api/v1/car`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, token.value);

      // verify that the previous policy properties cache has been cleared
      for (const policyId of initalPolicyIds) {
        assert.strictEqual(await REDIS_CLIENT.sIsMember(`${Config.redis.scope}policy:${policyId}:tokens`, token.id), 0, `Policy ${policyId} should no longer have the token cached`);

        // verify that the token:id:policies cache has been cleared
        assert.strictEqual(await REDIS_CLIENT.sIsMember(tokenPoliciesKey, policyId), 0, `Token should no longer have policy ${policyId} cached`);
      }

      // verify that the token:id:policy-properties no longer contains propertyIndex
      assert.strictEqual(await REDIS_CLIENT.sIsMember(tokenPolicyPropertiesKey, propertyIndex), 0, `Token should no longer have policy property ${propertyIndex} cached`);

      // verify that the policy:propertyIndex:<property> index no longer exists for propertyIndex
      assert.strictEqual(await REDIS_CLIENT.exists(propertyIndexKey), 0, `Policy property index for ${propertyIndex} should no longer exist`);
    });
  });
});
