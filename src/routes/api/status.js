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

const Route = require('../route');
// const Model = require('../../model');
const os = require('os');

const routes = [];

/**
 * @class GetTrackingList
 */
class GetProcessStatus extends Route {
	constructor() {
		super('status', 'GET TRACKING LIST');
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.LIST;
	}

	_validate(req, res, token) {
		return Promise.resolve(true);
	}

	_exec(req, res, validate) {
		const mem = process.memoryUsage().rss;
		const memTotal = os.totalmem();

		return {
			uptime: process.uptime(),
			memory: {
				used: mem,
				total: memTotal,
				percent: Number((mem / memTotal) * 100).toFixed(2),
			},
		};
	}
}
routes.push(GetProcessStatus);

/**
 * @type {*[]}
 */
module.exports = routes;
