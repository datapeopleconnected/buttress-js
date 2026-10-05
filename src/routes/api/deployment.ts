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

import Route from '../route.js';
import { CoreCount, CoreRouteConfig, CoreSearch } from '../core-routes.js';
import DeploymentSchemaModel from '../../model/core/deployment.js';
import type { CoreRouteClass } from '../../types/routes.js';

const routes: CoreRouteClass[] = [];

/**
 * @class SearchDeploymentList
 */
class SearchDeploymentList extends CoreSearch<DeploymentSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'deployment',
    name: 'SEARCH DEPLOYMENT LIST',
    model: DeploymentSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.LIST,
  };
}
routes.push(SearchDeploymentList);

/**
 * @class DeploymentCount
 */
class DeploymentCount extends CoreCount<DeploymentSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'deployment/count',
    name: 'COUNT DEPLOYMENTS',
    model: DeploymentSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.SEARCH,
  };
}
routes.push(DeploymentCount);

/**
 * @type {*[]}
 */
export default routes;
