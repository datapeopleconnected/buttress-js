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

import { Timer } from '../helpers/index.js';
import { parsedPolicyConfig } from '../access-control/index.js';

import type { App } from '../model/core/app.js';
import type { AppDataSharing } from '../model/core/app-data-sharing.js';
import type { Lambda } from '../model/core/lambda.js';
import type { Token } from '../model/core/token.js';
import type { User } from '../model/core/user.js';

export type RequestStatusEmitter = (data: Record<string, unknown>, nrp: { emit: (event: string, payload: string) => void }) => void;
export type RequestCloseEmitter = (nrp: { emit: (event: string, payload: string) => void }) => void;

export interface RequestContext {
  id: string;
  timer: Timer;
  authAppDataSharing: AppDataSharing | null;
  authLambda: Lambda | null;
  authUser: User | null;
  authApp: App | null;
  token: Token | null;
  apiPath?: string;
  pathSpec?: string;
  isPluginPath: boolean;
  ac: {
    policyConfigs: parsedPolicyConfig[];
  };
  timings: {
    authenticateToken: number | null;
    configCrossDomain: number | null;
    authenticate: number | null;
    validate: number | null;
    exec: number | null;
    respond: number | null;
    logActivity: number | null;
    boardcastData: number | null;
    close: number | null;
    stream: number[];
  };
  bjsReqStatus: RequestStatusEmitter;
  bjsReqClose: RequestCloseEmitter;
}

declare module 'express-serve-static-core' {
  interface Request {
    context: RequestContext;
  }
}