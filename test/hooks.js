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

const fs = require('fs');
const Config = require('node-env-obj')({
	basePath: __dirname,
	envFile: `.test.env`,
	envPath: '../',
	configPath: '../src',
});

if (process.env.TEST_ENV === 'e2e') {
	const tokenPath = `${Config.paths.appData}/super.json`;
	try {
		const {token} = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
		Config.testToken = token;
	} catch (e) {
		console.log('');
		console.error(`!🚨! ERROR !🚨! - Unable to perform tests without app_data/test/super.json.`);
		console.log('');
		console.error(`Please DELETE the existing test datastore. This will force Buttress to reinstall and create a new token file.`);
		console.log('');
		process.exit(1);
	}
} else {
	// Mock Datastore
	const {default: Datastore} = require('../dist/datastore');
	Datastore.createInstance({connectionString: `empty://buttressjs.com`}, true);
}

const {default: Logging} = require('../dist/helpers/logging');

const SHOW_LOG = (!!process.env.SHOW_LOG);

exports.mochaHooks = {
	beforeAll() {
		// TODO: Clear out the db so we can start clean.
		Logging.init('TEST');
		if (!SHOW_LOG) Logging.captureOutput(true);
	},
	afterAll() {
		// Logging.captureOutput(false);
	},
	beforeEach() {
		Logging.clean();
	},
	afterEach() {
		if (this.currentTest.state !== 'passed') Logging.flush();
	},
};
