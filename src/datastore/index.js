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

// const Config = require('node-env-obj')();
const Factory = require('./adapter-factory');

const Logging = require('../logging');

let mainDatastore = null;

/**
 * This class is used to manage the lifecycle of an adapter
 */
class Datastore {
	constructor(config) {
		this.setAdapter(config);
	}

	setAdapter(config) {
		this._adapter = Factory.create(config.connectionString, config.options);
	}

	connect() {
		Logging.logSilly(`Attempting to connect to datastore ${this._adapter.uri}`);
		return this.adapter.connect();
	}

	get ID() {
		return this.adapter.ID;
	}

	get adapter() {
		return this._adapter;
	}
}

module.exports = {
	Class: Datastore,
	createInstance(config) {
		if (mainDatastore) throw new Error('Datastore already exists');
		mainDatastore = new Datastore(config);
		return mainDatastore;
	},
	getInstance() {
		return mainDatastore;
	},
};
