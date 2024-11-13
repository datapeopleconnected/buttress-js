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

import { Request } from 'express';

import { Timer } from '../helpers/index';
import { parsedPolicyConfig } from '../access-control';

export interface BjsRequest extends Request {
  id?: string;
  timer?: Timer;
  authAppDataSharing: any;
  authLambda: any;
  authUser: any;
  authApp: any;
  token: any;
  apiPath?: string;
  isPluginPath: boolean;
  originalMethod: string;
  ac: {
    policyConfigs: parsedPolicyConfig[];
  };
  timings: {
    authenticateToken: number | null,
    configCrossDomain: number | null,
    authenticate: number | null,
    validate: number | null,
    exec: number | null,
    respond: number | null,
    logActivity: number | null,
    boardcastData: number | null,
    close: number | null,
    stream: [],
  };
  bjsReqStatus: any;
  bjsReqClose: any;
}