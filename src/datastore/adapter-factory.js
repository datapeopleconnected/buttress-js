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

const Errors = require('../helpers/errors');
const Config = require('node-env-obj')();

module.exports = class Datastore {
	static create(connectionString, optsString) {
		const uri = new URL(connectionString);

		if (!uri.pathname) {
			uri.pathname = `${Config.app.code}-${Config.env}`;
		}

		const options = new URLSearchParams(optsString);

		const Adapter = (() => {
			switch (uri.protocol) {
			case 'mongodb:':
				return require('./adapters/mongodb.js');
			case 'butt:':
			case 'butts:':
				return require('./adapters/buttress.js');
			case 'empty:':
				return require('./adapters/empty.js');
			default:
				return null;
			}
		})();

		if (Adapter === null) throw new Errors.UnsupportedDatastore(`Unknown datastore '${uri.protocol}'`);

		return new Adapter(uri, options);
	}

	static connect(connectionString, options) {
		const adatper = this.create(connectionString, options);

		return adatper.connect()
			.then(() => adatper);
	}
};
