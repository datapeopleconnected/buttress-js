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

const fs = require('fs');
const Config = require('node-env-obj')({
	basePath: __dirname,
	envFile: `.test.env`,
	envPath: '../',
	configPath: '../src',
});

// Load the token from app_data/test/super.json and handle the case where it doesn't exist
const tokenPath = `${Config.paths.appData}/super.json`;
try {
	Config.testToken = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
} catch (e) {
	console.log('');
	console.error(`!🚨! ERROR !🚨! - Unable to perform tests without app_data/test/super.json.`);
	console.log('');
	console.error(`Please DELETE the existing test datastore. This will force Buttress to reinstall and create a new token file.`);
	console.log('');
	process.exit(1);
}

const Logging = require('../dist/logging');

exports.mochaHooks = {
	beforeAll() {
		Logging.init('TEST');
		Logging.captureOutput(true);
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
