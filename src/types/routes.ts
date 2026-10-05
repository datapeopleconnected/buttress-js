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

import type { Request } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';

import type Route from '../routes/route.js';
import type { Services } from '../bootstrap.js';
import type { BjsQuery, QueryParams } from './bjs-query.js';

export type ExtendsRoute<T extends Route> = new (...args: unknown[]) => T;

// A core API route class, each file in routes/api exports a list of them
export type CoreRouteClass = new (services: Services) => Route;

// A request with the body a route expects, which is only as checked as the route's _validate makes it
export type RequestWithBody<TBody, TParams = ParamsDictionary> = Request<TParams, unknown, TBody>;

// The body of a search over documents of type T
export type SearchBody<T extends object> = { query?: BjsQuery<T> };

// The body of a search that pages, sorts or projects its results
export type SearchListBody<T extends object> = SearchBody<T> & {
  skip?: number | string;
  limit?: number | string;
  sort?: QueryParams<T>['sort'];
  project?: QueryParams<T>['project'];
};

// The body of a count, which is either its query or a search body
export type CountBody<T extends object> = SearchBody<T> & BjsQuery<T>;

// An item of a bulk update request, the routes' _validate replaces its body with the validated updates
export type BulkUpdateItem<TBody = unknown> = { id: string; body: TBody };
