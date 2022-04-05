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

'use strict';

const Bootstrap = require('./bootstrap');
const Config = require('node-env-obj')('../');
const Logging = require('./logging');

/**
 *
 */
Logging.init('REST');

Bootstrap.rest()
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
