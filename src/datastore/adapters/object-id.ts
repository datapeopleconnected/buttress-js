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
import { ObjectId } from 'bson';

/**
 * Whether a value is an ObjectId. bson's ESM and CommonJS builds each have their own ObjectId class, and the MongoDB
 * driver uses the CommonJS one, so `instanceof` can't be used.
 */
export const isObjectId = (value: unknown): value is ObjectId =>
  (value as { _bsontype?: unknown } | null | undefined)?._bsontype === 'ObjectId';

/**
 * The id helper for adapters that use ObjectIds. Outside the adapters an id is an ObjectId's hex string.
 */
export default class ObjectIdHelper {
  static new(id?: string) {
    return new ObjectId(id).toHexString();
  }

  static isValid(id: unknown) {
    return (typeof id === 'string' || isObjectId(id)) && ObjectId.isValid(id);
  }

  static instanceOf(id: unknown) {
    return isObjectId(id);
  }
}
