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

import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;

import Errors from '../helpers/errors';

import MongoDB from './adapters/mongodb';
import Buttress from './adapters/buttress';
import Empty from './adapters/empty';


export default class Datastore {
	static create(connectionString: string, optsString?: string) {
		const uri = new URL(connectionString);

		if (!uri.pathname) {
			uri.pathname = `${Config.app.code}-${Config.env}`;
		}

		const options = new URLSearchParams(optsString);

		const Adapter = (() => {
			switch (uri.protocol) {
			case 'mongodb:':
				return MongoDB;
			case 'butt:':
			case 'butts:':
				return Buttress;
			case 'empty:':
				return Empty;
			default:
				return null;
			}
		})();

		if (Adapter === null) throw new Errors.UnsupportedDatastore(`Unknown datastore '${uri.protocol}'`);

		return new Adapter(uri, options);
	}

	static connect(connectionString: string, options: string) {
		const adatper = this.create(connectionString, options);

		return adatper.connect()
			.then(() => adatper);
	}
};
