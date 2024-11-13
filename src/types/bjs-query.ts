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

type BjsQuery<T extends object> = {
  [K in keyof T]?:
    | T[K]
    | {
        $eq?: T[K];
        $ne?: T[K];
        $gt?: T[K];
        $gte?: T[K];
        $lt?: T[K];
        $lte?: T[K];
        $in?: T[K][];
        $nin?: T[K][];
        $exists?: boolean;
        $type?: number;
        $regex?: RegExp | string;
        $options?: string;
        $mod?: [number, number];
        $size?: number;
        $min?: T[K];
        $max?: T[K];
        $all?: T[K][];
        $elemMatch?: BjsQuery<T[K] extends object ? T[K] : never>;
      };
} & {
  $and?: BjsQuery<T>[];
  $or?: BjsQuery<T>[];
  $nor?: BjsQuery<T>[];
  $not?: BjsQuery<T>;
};

type QueryParams<T extends object> = {
  query: BjsQuery<T>;
  skip?: number;
  limit?: number;
  sort?: Record<string, 1 | -1>;
  project?: Record<string, 1 | -1>;
}