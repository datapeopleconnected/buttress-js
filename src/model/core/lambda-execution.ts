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

import AppSchemaModel from './app.js';
import TokenSchemaModel from './token.js';

export interface LambdaExecution {
  id: string;
  lambdaId: string;
  deploymentId: string;
  triggerType: 'CRON' | 'PATH_MUTATION' | 'API_ENDPOINT';
  priority: number;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'ERROR';
  logs: Array<{
    log: string | null;
    type: string | null;
  }>;
  executeAfter: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  nextCronExpression: string | null;
  _appId: string;
  _tokenId: string;
  metadata: Array<{
    key: string | null;
    value: string | null;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

class LambdaExecutionSchemaModel extends StandardModel {
  static override name = 'LambdaExecution';

  constructor(services) {
    const schema = LambdaExecutionSchemaModel.Schema;
    super(schema, null, services);
  }

  static get Schema(): Schema {
    return {
      name: 'lambdaExecution',
      type: 'collection',
      extends: [],
      core: true,
      properties: {
        lambdaId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
        deploymentId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
        triggerType: {
          __type: 'string',
          __default: 'CRON',
          __enum: ['CRON', 'PATH_MUTATION', 'API_ENDPOINT'],
          __required: true,
          __allowUpdate: true,
        },
        status: {
          __type: 'string',
          __default: 'PENDING',
          __enum: ['PENDING', 'RUNNING', 'COMPLETE', 'ERROR'],
          __required: true,
          __allowUpdate: true,
        },
        priority: {
          __type: 'number',
          __default: 0,
          __required: true,
          __allowUpdate: true,
        },
        logs: {
          __type: 'array',
          __allowUpdate: true,
          __schema: {
            log: {
              __type: 'string',
              __default: null,
              __required: true,
              __allowUpdate: true,
            },
            type: {
              __type: 'string',
              __default: null,
              __required: true,
              __allowUpdate: true,
            },
          },
        },
        executeAfter: {
          __type: 'date',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        startedAt: {
          __type: 'date',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        endedAt: {
          __type: 'date',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        nextCronExpression: {
          __type: 'string',
          __default: null,
          __required: false,
          __allowUpdate: true,
        },
        _appId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
        _tokenId: {
          __type: 'id',
          __required: true,
          __allowUpdate: false,
        },
        metadata: {
          __type: 'array',
          __allowUpdate: true,
          __schema: {
            key: {
              __type: 'string',
              __default: null,
              __required: true,
              __allowUpdate: true,
            },
            value: {
              __type: 'string',
              __default: null,
              __required: true,
              __allowUpdate: true,
            },
          },
        },
        createdAt: {
          __type: 'date',
          __default: 'now',
          __required: false,
          __allowUpdate: false,
        },
        updatedAt: {
          __type: 'date',
          __required: false,
          __allowUpdate: true,
        },
      },
    };
  }

  /**
   * @param {Object} body - body passed through from a POST request
   * @param {string} appId - the appId the lambda execution blongs to
   * @param {string} tokenId - the tokenId that should be used to exeucte the lambda
   * @return {Promise} - fulfilled with lambda execution Object when the database request is completed
   */
  override async add(body, appId: string, tokenId: string | null = null) {
    const executionBody = {
      lambdaId: body.lambdaId ? body.lambdaId : null,
      deploymentId: body.deploymentId ? body.deploymentId : null,
      triggerType: body.triggerType ? body.triggerType : null,
      priority: body.priority ? body.priority : 0,
      logs: body.logs ? body.logs : [],
      executeAfter: body.executeAfter ? body.executeAfter : null,
      nextCronExpression: body.nextCronExpression ? body.nextCronExpression : null,
      metadata: body.metadata ? body.metadata : [],
    };

    if (!appId) throw new Error('appId is required to create a lambda execution');

    const internals: any = { _appId: this.__modelManager.getCoreModel(AppSchemaModel).createId(appId) };
    if (tokenId) internals._tokenId = this.__modelManager.getCoreModel(TokenSchemaModel).createId(tokenId);

    const rxsExecution = await super.add(executionBody, internals);
    const execution = await Helpers.streamFirst(rxsExecution);

    return execution;
  }
}

/**
 * Exports
 */
export default LambdaExecutionSchemaModel;
