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

const {describe, it, before, after} = require('mocha');
const assert = require('assert');

const {
  createApp,
  updateSchema,
  BJSReqError,
  bjsReq,
  bjsReqPost,
  createUser,
  createPolicy,
  updateUserPolicyProperties
} = require('../../helpers');

const {default: BootstrapRest} = require('../../../dist/bootstrap-rest');

const PolicyTestData = require('../../data/policy/index.js');

// Go over each of the policies and create a list of all the policy selection properties
const PolicyPropertyList = Object.values(PolicyTestData).reduce((list, policy) => {
  if (policy.selection) {
    Object.keys(policy.selection).forEach((key) => {
      if (!list[key]) list[key] = [];
      if (typeof policy.selection[key] === 'object') {
        list[key].push(...Object.values(policy.selection[key]));
      } else {
        list[key].push(policy.selection[key]);
      }
    });
  }
  return list;
}, {});

// Grade 0 is valid but isn't specified in the policy list
if (PolicyPropertyList.grade) {
  PolicyPropertyList.grade.push(0);
}

let REST_PROCESS = null;
const ENDPOINT = `https://test.local.buttressjs.com`;

const testEnv = {
  apps: {},
  users: {},
  agreements: {},
  cars: [],
  policies: [],
  organisations: [],
  switches: [],
};

const createCar = async (app, name, color, number) => {
  const [car] = await bjsReq({
    url: `${ENDPOINT}/${app.apiPath}/api/v1/car`,
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      name,
      color: color || 'red',
      number: number || 123,
    }),
  }, app.token);
  testEnv.cars.push(car);
};

const TestDataOrganisations = [{
  name: 'A&A CLEANING LTD LTD',
  number: '1',
  status: 'ACTIVE',
}, {
  name: 'B&ESM VISION LTD LTD',
  number: '2',
  status: 'DISSOLVED',
}, {
  name: 'C&H CARE SOLUTIONS LTD',
  number: '3',
  status: 'LIQUIDATION',
}];

const TestDataSwitch = {
  id: '62b09ee325c88db16d9da6ca',
  state: 'OFF',
  name: 'Override Switch',
};

const schema = [{
  name: 'organisation',
  type: 'collection',
  properties: {
    name: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true
    },
    number: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true
    },
    status: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true
    }
  }
}, {
  name: 'switch',
  type: 'collection',
  properties: {
    name: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true
    },
    state: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true,
      __enum: [
        'ON',
        'OFF'
      ]
    }
  }
}, {
  name: 'car',
  type: 'collection',
  properties: {
    name: {
      __type: 'string',
      __default: null,
      __required: true,
      __allowUpdate: true,
    },
    color: {
      __type: 'string',
      __default: null,
      __required: false,
      __allowUpdate: true,
    },
    number: {
      __type: 'number',
      __default: null,
      __required: false,
      __allowUpdate: true,
    }
  },
}];

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Policy', async () => {
  before(async function() {
    // this.timeout(20000);

    REST_PROCESS = new BootstrapRest();

    await REST_PROCESS.init();

    testEnv.apps.app1 = await createApp(ENDPOINT, 'Test App 1', 'test-app-1', PolicyPropertyList);
    testEnv.apps.app1.schema = await updateSchema(ENDPOINT, schema, testEnv.apps.app1.token);

    // Populate the schema with some data.
    for (let i = 0; i < 10; i++) {
      await createCar(testEnv.apps.app1, `Car ${i}`, `r${Math.floor(Math.random() * 255)}`, Math.random() * 100);
    }

    // Create the organisations
    for await (const org of TestDataOrganisations) {
      const [bjsOrg]= await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(org),
      }, testEnv.apps.app1.token);

      testEnv.organisations.push(bjsOrg);
    }

    // Create the switch
    const [bjsSwitch] = await bjsReq({
      url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/switch`,
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(TestDataSwitch),
    }, testEnv.apps.app1.token);
    testEnv.switches.push(bjsSwitch);
  });

  after(async function() {
    // Shutdown
    await REST_PROCESS.clean();
  });
  
  describe('Basic', async () => {
    // Test the basic functionality of the policy system
  });

  describe('Ported API tests', async () => {
    before(async function() {
      // Create a user to test with.
      testEnv.users.basic1 = await createUser(ENDPOINT, {
        app: 'test-app',
        appId: `test-123`,
        email: 'test+123@buttressjs.com',
      }, {
        domains: ['test.local.buttressjs.com'],
        policyProperties: {
          adminAccess: true,
        },
      }, testEnv.apps.app1.token);
    });

    it('Should create policies on the app', async function() {
      const TestData = Object.values(PolicyTestData);
      for await (const policy of TestData) {
        testEnv.policies.push(await createPolicy(ENDPOINT, policy, testEnv.apps.app1.token));
      }

      assert(testEnv.policies.length === TestData.length);
    });

    it('Should access app companies using admin access policy', async function() {
      const result = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
        headers: {'Content-Type': 'application/json'},
      }, testEnv.users.basic1.tokens[0].value);

      assert(result.length === 3, `Expected 3 but got ${result.length}`);
    });

    it('Should fail accessing app companies using grade 0 policy', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 0,
      }, testEnv.apps.app1.token);

      try {
        await bjsReq({
          url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
          method: 'GET',
          headers: {'Content-Type': 'application/json'},
        }, testEnv.users.basic1.tokens[0].value);
        throw new Error('Request should have failed but didn\'t');
      } catch (err) {
        if (err instanceof BJSReqError) {
          assert(err.code === 401, `Expected 401 but got ${err.code}`);
          assert(err.message === 'Request does not have any policy associated to it', `Got ${err.message}`);
        } else {
          throw err;
        }
      }
    });

    it('Should access app companies using grade 1 policy', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 1,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
        headers: {'Content-Type': 'application/json'},
      }, testEnv.users.basic1.tokens[0].value);
      assert(res.length === 3);
    });

    it('should fail when accessing data outside working hours', async function() {
      // TODO: The time should be adjusted on the policy or mocked to avoid the test passing at 01:00.
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 2,
      }, testEnv.apps.app1.token);

      try {
        await bjsReq({
          url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
          method: 'GET',
          headers: {'Content-Type': 'application/json'},
        }, testEnv.users.basic1.tokens[0].value);
        throw new Error('Request should have failed but didn\'t');
      } catch (err) {
        if (err instanceof BJSReqError) {
          assert(err.code === 401, `Expected 401 but got ${err.code}`);
          assert(err.message.includes('Access control policy condition is not fulfilled'), `Got ${err.message}`);
        } else {
          throw err;
        }
      }
    });

    it('should only return active companies on get', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 3,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
        headers: {'Content-Type': 'application/json'},
      }, testEnv.users.basic1.tokens[0].value);

      const activeCompanies = res.every((c) => c.status === 'ACTIVE');
      assert(res.length === 1, `Expected 1 but got ${res.length}`);
      assert(activeCompanies, `Expected all companies to be ACTIVE but got ${res.map((c) => c.status).join(', ')}`);
    });

    it('should only return active companies on search', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 3,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'SEARCH',
        headers: {'Content-Type': 'application/json'},
      }, testEnv.users.basic1.tokens[0].value);

      const activeCompanies = res.every((c) => c.status === 'ACTIVE');
      assert(res.length === 1, `Expected 1 but got ${res.length}`);
      assert(activeCompanies, `Expected all companies to be ACTIVE but got ${res.map((c) => c.status).join(', ')}`);
    });

    it('should only return active companies on count', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 3,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation/count`,
        method: 'SEARCH',
        headers: {'Content-Type': 'application/json'},
      }, testEnv.users.basic1.tokens[0].value);

      assert(res === 1, `Expected 1 but got ${res.length}`);
    });

    it ('should fail writing to properties and the policy does not include writing verb', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 3,
      }, testEnv.apps.app1.token);

      try {
        await bjsReq({
          url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation/${testEnv.organisations[0].id}`,
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
	        body: JSON.stringify([{
            path: 'name',
            value: 'Test demo company',
          }]),
        }, testEnv.users.basic1.tokens[0].value)
        throw new Error('Request should have failed but didn\'t');
      } catch (err) {
        if (err instanceof BJSReqError) {
          assert(err.code === 401, `Expected 401 but got ${err.code}`);
          assert(err.message.includes('Request does not have any policy rules matching the request verb'), `Got ${err.message}`);
        } else {
          throw err;
        }
      }
    });

    it('should only return companies name', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 4,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
        headers: {'Content-Type': 'application/json'},
      }, testEnv.users.basic1.tokens[0].value);
      const companiesStatus = res.map((company) => company.status).filter((v) => v);
      const companiesName = res.map((company) => company.name).filter((v) => v);
      const companiesNumber = res.map((company) => company.number).filter((v) => v);

      assert(res.length === 3, `Expected 3 but got ${res.length}`);
      assert(companiesStatus.length === 0, `Filtered companies status should be empty but got ${companiesStatus.length}`);
      assert(companiesName.length === 3, `Filtered companies name should be 3 but got ${companiesName.length}`);
      assert(companiesNumber.length === 0, `Filtered companies number should be empty but got ${companiesNumber.length}`);
    });

    it ('should fail writing to properties and it only has read access to properties', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 5,
      }, testEnv.apps.app1.token);

      try {
        await bjsReq({
          url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation/${testEnv.organisations[0].id}`,
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
	        body: JSON.stringify([{
            path: 'status',
            value: 'LIQUIDATION',
          }]),
        }, testEnv.users.basic1.tokens[0].value);
        throw new Error('Request should have failed but didn\'t');
      } catch (err) {
        if (err instanceof BJSReqError) {
          assert(err.code === 401, `Expected 401 but got ${err.code}`);
          assert(err.message.includes('Can not access/edit properties (status)'), `Got ${err.message}`);
        } else {
          throw err;
        }
      }
    });

    it ('should partially add a company to the database', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 5,
      }, testEnv.apps.app1.token);

      const [result] = await bjsReqPost(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`, {
        name: 'DPC ltd',
        number: '100',
        status: 'ACTIVE',
      }, testEnv.users.basic1.tokens[0].value);
      testEnv.organisations.push(result);

      assert(result.name === 'DPC ltd');
      assert(result.number === '100');
      assert(result.status === null);
    });

    it ('should delete a company from the database', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 5,
      }, testEnv.apps.app1.token);

      const result = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation/${testEnv.organisations[0].id}`,
        method: 'DELETE',
      }, testEnv.users.basic1.tokens[0].value);

      assert(result === true, `Failed to delete company, result should be true but got ${result}`);
    });

    it ('should ignore summer-working-hours policy as its condition is not fulfilled', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        grade: 6,
        securityClearance: 1,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
        headers: {'Content-Type': 'application/json'},
      }, testEnv.users.basic1.tokens[0].value);

      assert(res.length > 0);
      assert(res[0].name !== null);
      assert(res[0].status !== null);
    });

    it ('should fail override-access policy as the override switch is off', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        securityClearance: 100,
      }, testEnv.apps.app1.token);

      try {
        await bjsReq({
          url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
          method: 'GET',
        }, testEnv.users.basic1.tokens[0].value);
        throw new Error('Request should have failed but didn\'t');
      } catch (err) {
        if (err instanceof BJSReqError) {
          assert(err.code === 401, `Expected 401 but got ${err.code}`);
          assert(err.message.includes('Access control policy condition is not fulfilled'), `Got ${err.message}`);
        } else {
          throw err;
        }
      }
    });

    it ('should access data after admin turns on the override switch', async function() {
      // Update switch property to ON which should allow the user to query the data.
      await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/switch/${testEnv.switches[0].id}`,
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify([{
          path: 'state',
          value: 'ON',
        }]),
      }, testEnv.apps.app1.token);

      const results = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
      }, testEnv.users.basic1.tokens[0].value);

      assert(results.length > 0);
    });

    it ('should merge policies projection', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        policyProjection: 2,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
      }, testEnv.users.basic1.tokens[0].value);

      const companiesStatus = res.map((company) => company.status).filter((v) => v);
      const companiesName = res.map((company) => company.name).filter((v) => v);
      const companiesNumber = res.map((company) => company.number).filter((v) => v);

      assert(res.length === 3, `Expected 3 but got ${res.length}`);
      assert(companiesStatus.length === 2, `Property filter status, expected 2 but got ${companiesStatus.length}`);
      assert(companiesName.length === 3, `Property filter name, expected 3 but got ${companiesName.length}`);
      assert(companiesNumber.length === 0, `Property filter number, expected 0 but got ${companiesNumber.length}`);
    });

    it ('should override policies query', async function() {
      await updateUserPolicyProperties(ENDPOINT, testEnv.users.basic1.id, {
        policyMergeQuery: 2,
      }, testEnv.apps.app1.token);

      const res = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/organisation`,
        method: 'GET',
      }, testEnv.users.basic1.tokens[0].value);

      const activeCompanies = res.every((c) => c.status === 'DISSOLVED');
      assert(res.length === 1, `Expected 1 but got ${res.length}`);
      assert(activeCompanies, `Expected all companies to be DISSOLVED but got ${res.map((c) => c.status).join(', ')}`);
    });
  });

  // Policy which has mutiple non-mergable policies can return multiple results
  describe('Multi-Policy results', async () => {
    before(async function() {
      // Create a user to test with.
      testEnv.users.multiPol1 = await createUser(ENDPOINT, {
        app: 'test-app',
        appId: `test-1234`,
        email: 'test-1234@buttressjs.com',
      }, {
        domains: ['test.local.buttressjs.com'],
        policyProperties: {
          role: 'test1',
        },
      }, testEnv.apps.app1.token);
    });
    after(async function() {
      // Delete the user
    });

    it ('Should return multiple results', async function() {
      const [ token ] = testEnv.users.multiPol1.tokens;
      const cars = await bjsReq({
        url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
        method: 'GET',
        headers: {'mode': 'no-cors'},
      }, token.value);

      // The results should contain two items with name "Car 0". One will include colour
      const car0 = cars.filter((car) => car.name === 'Car 0');
      assert(car0.length === 2, `Expected 2 but got ${car0.length}`);
      const car0colourIdx = car0.findIndex((car) => car.color !== undefined);
      assert(car0colourIdx !== -1, `Expected one of the cars to have a colour but got ${car0[car0colourIdx].color}`);
    });
  });
});
