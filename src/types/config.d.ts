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

interface Config {
  env: string;
  app: {
    title: string;
    description: string;
    code: string;
    version: string;
    protocol: string;
    host: string;
    apiPrefix: string;
    workers: string;
  }
  lambda: {
    apiWorkers: string;
    pathMutationWorkers: string;
    cronWorkers: string;
    developmentEmailAddress: string;
  }
  logging: {
    level: string;
    slow: string;
    slowTime: string;
  }
  listenPorts: {
    rest: string;
    sock: string;
  }
  datastore: {
    connectionString: string;
    options: string;
  }
  timeout: {
    lambda: string;
    lambdasRunner: string;
    lambdaManager: string;
  }
  redis: {
    port: string;
    host: string;
    scope: string;
  }
  sio: {
    app: string;
  }
  rest: {
    app: string;
  }
  paths: {
    logs: string;
    appData: string;
    plugins: string;
    lambda: {
      code: string;
      plugins: string;
      bundles: string;
    }
  }
}
