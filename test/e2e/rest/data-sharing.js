/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

const fetch = require('cross-fetch');

const {describe, it, before, after} = require('mocha');
const assert = require('assert');

const Config = require('node-env-obj')();

const BootstrapRest = require('../../../dist/bootstrap-rest');

const REST_PROCESS = new BootstrapRest();

const ENDPOINT = `http://localhost:${Config.listenPorts.rest}`;

const testEnv = {
	apps: {},
};

const bjsReq = async (opts, token=Config.testToken) => {
	const req = await fetch(`${opts.url}?token=${token}`, opts);
	if (req.status !== 200) throw new Error(`Received non-200 from POST ${opts.url}`);
	return await req.json();
};

const createApp = async (name, apiPath, token) => await bjsReq({
	url: `${ENDPOINT}/api/v1/app`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify({
		name,
		apiPath,
	}),
}, token);
const updateSchema = async (schema, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/schema`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(schema),
}, token);
const registerDataSharing = async (agreement, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/appDataSharing`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(agreement),
}, token);

before(async function() {
	this.timeout(20000);

	await REST_PROCESS.init();

	// Create two new apps
	testEnv.apps.app1 = await createApp('Test App 1', 'test-app-1');
	testEnv.apps.app1.schema = await updateSchema([{
		name: 'car',
		type: 'collection',
		properties: {
			name: {
				__type: 'string',
				__default: null,
				__required: true,
				__allowUpdate: true,
			},
		},
	}], testEnv.apps.app1.token);

	testEnv.apps.app2 = await createApp('test-app-2');
});

after(async () => {
	// Shutdown
	await REST_PROCESS.clean();
});

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Data Sharing', async () => {
	it('Should register a data sharing agreement between app2 and app1', async () => {
		const agreement = await registerDataSharing({
			name: 'test-app2',

			remoteApp: {
				endpoint: ENDPOINT,
				apiPath: testEnv.apps.app2.apiPath,
				token: null,
			},

			policy: [{
				endpoints: ['%ALL%'],
				query: [{
					schema: ['%APP_SCHEMA%'],
					access: '%FULL_ACCESS%',
				}],
			}],
		}, testEnv.apps.app1.token);

		assert.strictEqual(agreement.name, 'test-app2');
		assert.strictEqual(agreement.remoteApp.endpoint, ENDPOINT);
		assert.strictEqual(agreement.remoteApp.apiPath, testEnv.apps.app2.apiPath);
		assert.strictEqual(agreement.remoteApp.token, null);
		assert.strictEqual(agreement.active, false);
		assert(agreement.registrationToken !== null && agreement.registrationToken !== undefined);

		const b = await bjsReq({
			url: `${ENDPOINT}/api/v1/app/schema`,
		}, agreement.registrationToken);

		console.log(b);
	});
});

