#!/usr/bin/env node

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

import cluster from 'node:cluster';
import createConfig from 'node-env-obj';

const env = (process.env.ENV_FILE) ? process.env.ENV_FILE : process.env.NODE_ENV;

const Config = createConfig({
	envFile: `.${env}.env`,
	envPath: '../../',
	configPath: '../',
}) as unknown as Config;

import Logging from '../helpers/logging';
import BootstrapLambda from '../bootstrap-lambda';

Logging.init('LAMBDA');

if (cluster.isMaster) Logging.startupMessage();

(async () => {
	try {
		const app = new BootstrapLambda();
		const isMaster = await app.init();

		if (isMaster) {
			Logging.log(`${Config.app.title}:${Config.app.code} Lambda Server Master v${Config.app.version} in ${Config.env} mode.`);
			Logging.log(`Configured Main Endpoint: ${Config.app.protocol}://${Config.app.host}`);
		} else {
			Logging.log(`${Config.app.title}:${Config.app.code} Lambda Server Worker v${Config.app.version} ` +
				`in ${Config.env} mode.`);
		}
	} catch (err) {
		if (err instanceof Error || typeof err === 'string') {
			Logging.logError(err);
		} else {
			console.error(err);
		}

		process.exit(1);
	}
})();
