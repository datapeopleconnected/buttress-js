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
/**
 * Creates and checks ids. Outside the adapters an id is a string: it's only a datastore's own type (e.g. an ObjectId)
 * inside the adapter for that datastore.
 */
export interface AdapterIdHelper {
  // A new id, or the canonical string form of the given one. Throws if it isn't a valid id.
  new: (id?: string) => string;
  isValid: (id: unknown) => boolean;
  instanceOf: (id: unknown) => boolean;
}

/**
 * A document as it's stored in, or returned from, a datastore. Adapters return `id` rather than a
 * datastore specific key such as MongoDB's `_id`.
 */
export type AdapterDocument = Record<string, unknown>;

/**
 * A datastore query, written in the MongoDB query language.
 */
export type AdapterQuery = Record<string, unknown>;

/**
 * Applied to each document before it's added, e.g. to set defaults from the schema.
 */
export type AdapterAddModifier = (item: AdapterDocument) => AdapterDocument;

/**
 * How an update-by-path operation should be applied, see `extendPathContext` in `model/shared.ts`.
 */
export interface UpdatePathContext {
  type: 'scalar' | 'scalar-increment' | 'vector-add' | 'vector-rm';
  values: unknown[];
}

/**
 * Update-by-path contexts, keyed on a regular expression matching the paths they apply to.
 */
export type UpdatePathContexts = Record<string, UpdatePathContext>;

/**
 * A single update-by-path operation, as sent in the body of an update request.
 */
export interface UpdatePathBody {
  path: string;
  value: unknown;
  // Set during validation, to the key of the matching path context (false until one's found).
  contextPath?: string | false;
  contextParams?: string[];
  sourceId?: string;
}

/**
 * The outcome of applying an update-by-path operation.
 */
export interface UpdatePathResult {
  type: UpdatePathContext['type'];
  path: string;
  value: unknown;
}
