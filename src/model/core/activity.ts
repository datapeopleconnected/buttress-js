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
import { Schema, encode } from '../../helpers/schema.js';
import * as Shared from '../shared.js';

import StandardModel from '../type/standard.js';

/**
 * Constants
 */
const visibility = ['public', 'private'];
const Visibility = {
  PUBLIC: visibility[0],
  PRIVATE: visibility[1],
};

class ActivitySchemaModel extends StandardModel {
  static name = 'Activity';

  constructor(services) {
    const schema = ActivitySchemaModel.Schema;
    super(schema, null, services);
  }

  static get Constants() {
    return {
      Visibility: Visibility,
    };
  }
  get Constants() {
    return ActivitySchemaModel.Constants;
  }

  static get Schema(): Schema {
    return {
      name: 'activities',
      type: 'collection',
      extends: [],
      core: true,
      properties: {
        timestamp: {
          __type: 'date',
          __default: 'now',
          __allowUpdate: false,
        },
        title: {
          __type: 'string',
          __default: '',
          __allowUpdate: false,
        },
        description: {
          __type: 'string',
          __default: '',
          __allowUpdate: false,
        },
        visibility: {
          __type: 'string',
          __default: 'private',
          __enum: visibility,
          __allowUpdate: false,
        },
        path: {
          __type: 'string',
          __default: '',
          __allowUpdate: false,
        },
        verb: {
          __type: 'string',
          __default: '',
          __allowUpdate: false,
        },
        authType: {
          __type: 'string',
          __default: '',
          __allowUpdate: false,
        },
        permissions: {
          __type: 'string',
          __default: '',
          __allowUpdate: false,
        },
        params: {
          id: {
            __type: 'id',
            __default: null,
            __allowUpdate: false,
          },
        },
        body: {
          __type: 'string',
          __default: '',
          __allowUpdate: false,
        },
        _tokenId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
        _appId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
        _userId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
      },
    };
  }

  /**
   * @param {Object} body - body passed through from a POST request
   * @return {Promise} - fulfilled with App Object when the database request is completed
   */
  __parseAddBody(body) {
    const user = body.req.context.authUser;
    const userName = user ? `${user.id}` : 'App';

    body.activityTitle = body.activityTitle.replace('%USER_NAME%', userName);
    body.activityDescription = body.activityDescription.replace('%USER_NAME%', userName);

    const q = Object.assign({}, body.req.query);
    delete q.token;
    delete q.urq;

    const md: any = {
      title: body.activityTitle,
      description: body.activityDescription,
      visibility: body.activityVisibility,
      path: body.path,
      verb: body.verb,
      permissions: body.permissions,
      authType: body.auth,
      params: body.req.params,
      query: q,
      body: encode(body.req.body), // HACK - Due to schema update results.
      timestamp: new Date(),
      _tokenId: body.req.context.token.id,
      _userId: body.req.context.authUser ? body.req.context.authUser.id : null,
      _appId: body.req.context.authApp.id,
    };

    if (body.id) {
      md.id = this.adapter.ID.new(body.id);
    }

    delete body.req;
    delete body.res;

    return Shared.sanitizeSchemaObject(ActivitySchemaModel.Schema, body);
  }

  add(body) {
    body.req.body = encode(body.req.body);

    return super.add(body);
  }
}

/**
 * Exports
 */
export default ActivitySchemaModel;
