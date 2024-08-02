#!/usr/bin/env node
'use strict';

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

const env = (process.env.ENV_FILE) ? process.env.ENV_FILE : process.env.NODE_ENV;

const Config = require('node-env-obj')({
	envFile: `.${env}.env`,
	envPath: '../../',
	configPath: '../',
});
const cluster = require('cluster');
const Sugar = require('sugar');

Sugar.Date.setLocale('en-GB');

const Logging = require('../helpers/logging');
const BootstrapSocket = require('../bootstrap-socket');

if (cluster.isMaster) Logging.startupMessage();

Logging.init('SOCK');

const app = new BootstrapSocket();
app.init()
	.then((isMaster) => {
		if (isMaster) {
			Logging.log(`${Config.app.title} Socket Master v${Config.app.version} listening on port ` +
				`${Config.listenPorts.sock} in ${Config.env} mode.`);
		} else {
			Logging.log(`${Config.app.title} Socket Worker v${Config.app.version} in ${Config.env} mode.`);
		}
	})
	.catch(Logging.Promise.logError());
