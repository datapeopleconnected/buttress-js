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

import { createHash } from 'crypto';

// import createConfig from 'node-env-obj';
// const Config = createConfig() as unknown as Config;

import Factory from './adapter-factory';

import Logging from '../helpers/logging';

const datastores: {
	[key: string]: Datastore;
} = {};

interface DatastoreConfig {
	connectionString: string;
	options?: string;
}

/**
 * This class is used to manage the lifecycle of an adapter
 */
export class Datastore {
	private _adapter: any;
	private _hash?: string;

	dataSharingId?: string;

	constructor(config: DatastoreConfig) {
		this.setAdapter(config);
	}

	setAdapter(config: DatastoreConfig) {
		this._adapter = Factory.create(config.connectionString, config.options);
	}

	setHash(hash) {
		this._hash = hash;
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

	get hash() {
		return this._hash;
	}
}

export default {
	hashConfig(config: DatastoreConfig) {
		return createHash('sha1').update(Buffer.from(config.connectionString)).digest('base64');
	},
	createInstance(config: DatastoreConfig, core = false) {
		const hash = (core) ? 'core' : this.hashConfig(config);
		if (datastores[hash]) return datastores[hash];

		datastores[hash] = new Datastore(config);
		datastores[hash].setHash(hash);
		return datastores[hash];
	},
	getInstance(hash) {
		return datastores[hash];
	},
	clean: async () => {
		for await (const key of Object.keys(datastores)) {
			if (datastores[key] && datastores[key].adapter && datastores[key].adapter.close) {
				await datastores[key].adapter.close();
			}
			delete datastores[key];
		}
	},
	datastores,
};
