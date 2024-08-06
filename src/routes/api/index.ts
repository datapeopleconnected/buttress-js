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

import Activity from './activity';
import AppDataSharing from './app-data-sharing';
import App from './app';
import Deployment from './deployment';
import Lambda from './lambda';
import LambdaExecution from './lambda-execution';
import Policy from './policy';
import SecureStore from './secure-store';
import status from './status';
import Token from './token';
import Tracking from './tracking';
import User from './user';

export const Routes = [
  Activity,
  AppDataSharing,
  App,
  Deployment,
  Lambda,
  LambdaExecution,
  Policy,
  SecureStore,
  status,
  Token,
  Tracking,
  User,
];