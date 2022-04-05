#!/usr/bin/env node
'use strict';

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

const env = (process.env.ENV_FILE) ? process.env.ENV_FILE : process.env.NODE_ENV;

const Config = require('node-env-obj')({
	envFile: `.${env}.env`,
	envPath: '../',
	configPath: '../src',
});

const BootstrapRest = require('../src/bootstrap-rest');
const Logging = require('../src/logging');
const Sugar = require('sugar');
Sugar.Date.setLocale('en-GB');

/**
 *
 */
Logging.init('REST');

const app = new BootstrapRest();
app.init()
	.then((isMaster) => {
		if (isMaster) {
			Logging.log(`${Config.app.title}:${Config.app.code} REST Server Master v${Config.app.version} listening on port ` +
				`${Config.listenPorts.rest} in ${Config.env} mode.`);
			Logging.log(`Configured Main Endpoint: ${Config.app.protocol}://${Config.app.host}`);
		} else {
			Logging.log(`${Config.app.title}:${Config.app.code} REST Server Worker v${Config.app.version} ` +
				`in ${Config.env} mode.`);
		}
	})
	.catch(Logging.Promise.logError());
