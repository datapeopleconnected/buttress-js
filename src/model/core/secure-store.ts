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

import StandardModel from '../type/standard.js';

import * as Helpers from '../../helpers/index.js';
import { Schema } from '../../helpers/schema.js';

interface SecureStore {
  id: string;
  name: string;
  storeData: Record<string, unknown>;
  _appId: string;
}

class SecureStoreSchemaModel extends StandardModel<SecureStore> {
  static name = 'SecureStore';

  constructor(services) {
    const schema = SecureStoreSchemaModel.Schema;
    super(schema, null, services);
  }

  static get Schema(): Schema {
    return {
      name: 'secureStore',
      type: 'collection',
      extends: [],
      core: true,
      properties: {
        name: {
          __type: 'string',
          __required: true,
          __allowUpdate: true,
        },
        storeData: {
          __type: 'object',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        _appId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
      },
    };
  }

  /**
   * @param {Object} req - request object
   * @param {Object} body - body passed through from a POST request
   * @return {Promise} - fulfilled with secure store value Object when the database request is completed
   */
  async add(body, appId: string) {
    const data = {
      id: body.id ? body.id : null,
      name: body.name ? body.name : null,
      storeData: body.storeData ? body.storeData : {},
    };

    const rxsSecureStore = await super.add(data, {
      _appId: appId,
    });
    const secureStore = await Helpers.streamFirst(rxsSecureStore);

    return secureStore;
  }
}

/**
 * Exports
 */
export default SecureStoreSchemaModel;
