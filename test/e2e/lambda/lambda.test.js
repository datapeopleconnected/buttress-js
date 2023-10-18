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

const {createApp, updateSchema} = require('../../helpers');

const BootstrapRest = require('../../../dist/bootstrap-rest');
const BootstrapLambda = require('../../../dist/bootstrap-lambda');

let LAMBDA_PROCESS = null;
let REST_PROCESS = null;
const ENDPOINT = `https://test.local.buttressjs.com`;

const testEnv = {
	apps: {},
	cars: [],
};

// This suite of tests will run against the REST API
describe('Schema', async () => {
	before(async function() {
		LAMBDA_PROCESS = new BootstrapLambda();
		REST_PROCESS = new BootstrapRest();

		await REST_PROCESS.init();
		await LAMBDA_PROCESS.init();

		// testEnv.apps.app1 = await createApp(ENDPOINT, 'Test Req App', 'test-req-app');
	});

	after(async function() {
		await LAMBDA_PROCESS.clean();
		await REST_PROCESS.clean();
	});

	describe('Basic', async () => {
		it('Should update the app schema', async () => {
			assert.strictEqual(false, true);
		});
	});
});
