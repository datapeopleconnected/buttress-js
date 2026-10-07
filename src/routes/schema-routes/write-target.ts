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
import * as Helpers from '../../helpers/index.js';
import { partnerUnavailable } from '../../model/type/remote-combined.js';
import { AdapterDocument } from '../../types/datastore.js';

/**
 * The record a write is for, and where the write goes: the agreement the record was read through, or null for the
 * app's own.
 */
export interface WriteTarget {
  entity: AdapterDocument;
  via: string | null;
}

// A collection with remotes (RemoteCombinedModel) knows where each record it read came from
interface SourcedModel {
  sourceOf(record: unknown): string | null | undefined;
  hasUnreachablePartner(): boolean;
}

const isSourced = (model: unknown): model is SourcedModel =>
  typeof (model as Partial<SourcedModel> | null)?.sourceOf === 'function';

/**
 * @param {unknown} model - the route's model
 * @param {unknown} record - a record the model read
 * @return {string|null} - the agreement a collection with remotes read the record through, or null for the app's own
 */
export const sourceOfRecord = (model: unknown, record: unknown): string | null =>
  isSourced(model) ? (model.sourceOf(record) ?? null) : null;

// Ids are compared as strings, whatever their case
const sameId = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The record a write to one id is for, out of those the write's own read found within the caller's policies. The write
 * then goes where that record was read, never by the sourceId a record names, as a partner gives that.
 *
 * A collection without remotes finds one record at most. One with remotes can find the id in more than one source, the
 * parts of one entity: the request picks one by the sourceId it names, or else it's the app's own.
 * @param {unknown} model - the route's model
 * @param {AdapterDocument[]} found - the records the read found for the id
 * @param {object} request - the app the route serves, the schema and id for an error, and the sourceId the request
 * names, if any
 * @return {WriteTarget|null} - null when there's no such record
 */
export function pickWriteTarget(
  model: unknown,
  found: AdapterDocument[],
  request: { appId: string; schemaName: string; id: string; sourceId?: string },
): WriteTarget | null {
  if (!isSourced(model)) return found.length > 0 ? { entity: found[0], via: null } : null;

  // A record more than one of the caller's policy configs reads comes back once for each
  const bySource = new Map<string | null, WriteTarget>();
  found.forEach((entity) => {
    const via = model.sourceOf(entity) ?? null;
    if (!bySource.has(via)) bySource.set(via, { entity, via });
  });

  // The app's own records are returned with its id as their source
  const named = (target: WriteTarget) =>
    (target.entity.sourceId as string | undefined) || (target.via === null ? request.appId : '');
  const candidates = [...bySource.values()].filter(
    (target) => !request.sourceId || sameId(named(target), request.sourceId),
  );

  if (candidates.length < 1) {
    // A partner that couldn't be reached may have it
    if (model.hasUnreachablePartner()) throw partnerUnavailable();
    return null;
  }
  if (candidates.length === 1) return candidates[0];

  const own = candidates.find((target) => target.via === null);
  if (own) return own;

  throw Helpers.Errors.conflict('ambiguous_source', `More than one source has a ${request.schemaName} with this id`, {
    schema: request.schemaName,
    id: request.id,
  });
}
