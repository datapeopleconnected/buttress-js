/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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

import { ConnectionString } from 'mongodb-connection-string-url';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

import Errors from '../helpers/errors.js';

import MongoDB from './adapters/mongodb.js';
import Buttress from './adapters/buttress.js';
import Empty from './adapters/empty.js';

export default class Datastore {
  static create(connectionString: string, optsString?: string) {
    const options = new URLSearchParams(optsString);
    const defaultDatabase = `${Config.app.code}-${Config.env}`;

    // A MongoDB connection string is read as the driver reads it. A URL can't hold a replica set's seed list with each
    // host's port (h1:27017,h2:27017), since it takes everything after the first host's colon as the port. It's read
    // loosely, as a URL reads one: without the spaces an env file can leave around it, with special characters in its
    // user info percent-encoded rather than refused, and its scheme in any case. The driver checks what it's given.
    const trimmed = connectionString.trim();
    if (/^mongodb:/i.test(trimmed)) {
      const uri = new ConnectionString(trimmed, { looseValidation: true });
      // One that names no database gets the default, whether it ends in '/' or not (MongoDB's docs give options without
      // a database as host/?authSource=admin): the driver's reading gives both the path '/'.
      if (uri.pathname === '/') uri.pathname = defaultDatabase;

      return new MongoDB(uri, options);
    }

    const uri = new URL(connectionString);

    // A connection string without a path gets the default database. A Buttress one's path is the partner app's api
    // path, so a bare '/' is left there.
    if (!uri.pathname) uri.pathname = defaultDatabase;

    const Adapter = (() => {
      switch (uri.protocol) {
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

    return adatper.connect().then(() => adatper);
  }
}
