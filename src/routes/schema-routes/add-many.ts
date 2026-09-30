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

import { Request, Response } from 'express';

import Route from '../route.js';
import * as Helpers from '../../helpers/index.js';
import { Schema, modelToRoute } from '../../helpers/schema.js';

import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';
import { AdapterDocument } from '../../types/datastore.js';
import type { RequestWithBody } from '../../types/routes.js';
import StandardModel from '../../model/type/standard.js';
import { invalidEntityError, sanitizeSchemaObject } from '../../model/shared.js';
import * as ACM from '../../access-control/models-access.js';

// An entity reuses an id that's stored, or given earlier in the batch
const duplicateIdError = (schemaName: string | undefined, id: unknown, index: number) =>
  Helpers.Errors.badRequest('duplicate_id', `${schemaName}: Duplicate id ${id} at index ${index}`, {
    schema: schemaName,
    id: String(id),
    index,
  });

/**
 * The error for the first reason a batch of new entities can't be stored, naming the index of the entity, or null if
 * it can be.
 */
export const findBatchProblem = async (model: StandardModel, entities: unknown[], schemaName?: string) => {
  const isEntity = (entity: unknown): entity is { id?: unknown } =>
    entity !== null && typeof entity === 'object' && !Array.isArray(entity);

  // Ids are compared ignoring case, as a hex id names the same entity in either case.
  const givenIds = entities.flatMap((entity) => (isEntity(entity) && entity.id != null ? [String(entity.id)] : []));
  const storedIds = new Set(
    (givenIds.length > 0 ? await model.findStoredIds(givenIds) : []).map((id) => id.toLowerCase()),
  );

  const ids = new Set<string>();
  for (const [idx, entity] of entities.entries()) {
    if (!isEntity(entity)) {
      return Helpers.Errors.badRequest(
        'invalid_value',
        `${schemaName}: Invalid entity at index ${idx}, expected an object`,
        {
          schema: schemaName,
          index: idx,
        },
      );
    }

    const validation = model.validate(entity);
    if (!validation.isValid) return invalidEntityError(schemaName, validation, idx);

    const { id } = entity;
    if (id === undefined || id === null) continue;

    // An existing id would fail the insert part way through, after the entities before it were stored.
    const key = String(id).toLowerCase();
    if (ids.has(key) || storedIds.has(key)) return duplicateIdError(schemaName, id, idx);
    ids.add(key);
  }

  return null;
};

/**
 * Refuses a batch of new entities with 403 access_denied if the caller's policies don't let it create one of them,
 * checked as each will be stored.
 */
export const refuseEntitiesOutsidePolicy = (
  model: StandardModel,
  entities: unknown[],
  ac: Request['context']['ac'] | undefined,
  schemaName?: string,
) => {
  if (!ac) return;
  for (const [idx, entity] of entities.entries()) {
    const stored = sanitizeSchemaObject(model.schemaData, entity) as Record<string, unknown>;
    if (!ACM.canCreate(ac, stored)) {
      throw Helpers.Errors.forbidden(
        'access_denied',
        `${schemaName}: the policy does not allow the entity at index ${idx}`,
        {
          schema: schemaName,
          index: idx,
        },
      );
    }
  }
};

/**
 * An id can be taken by another request between the check and the insert. The adapter then removes what it stored of
 * the batch, and this is the error to refuse the batch with, as the check would have refused it.
 */
export const takenIdError = (
  err: InstanceType<typeof Helpers.Errors.DuplicateIdError>,
  entities: unknown[],
  schemaName?: string,
) => {
  const id = (entities[err.index] as { id?: unknown } | undefined)?.id ?? err.id;
  return duplicateIdError(schemaName, id, err.index);
};

/**
 * @class AddMany
 */
export default class AddMany extends Route {
  constructor(schema: Schema, app: App, services: Services) {
    const schemaRoutePath = modelToRoute(schema.name);

    super(`${schemaRoutePath}/bulk/add`, `BULK ADD ${schema.name}`, services, schema, app);
    this.__configureSchemaRoute();

    this.verb = Route.Constants.Verbs.POST;
    this.permissions = Route.Constants.Permissions.ADD;

    this.activityDescription = `BULK ADD ${schema.name}`;
    this.activityBroadcast = true;
  }

  override async _validate(req: RequestWithBody<AdapterDocument[]>, _res: Response) {
    const model = await this.routeModel();
    const entities: AdapterDocument[] = req.body;
    if (entities instanceof Array === false) {
      this.log(`ERROR: You need to supply an array of ${this.schemaName}`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.badRequest('array_required');
    }
    // if (companies.length > 601) {
    //   this.log(`ERROR: No more than 300`, Route.LogLevel.ERR);
    //   reject({statusCode: 400, message: `Invalid data: send no more than 300 ${this.schemaName} at a time`});
    //   return;
    // }

    // All or nothing: nothing is stored unless every entity is valid and new, and the error names the first that isn't.
    const problem = await findBatchProblem(model, entities, this.schemaName);
    if (problem) {
      this.log(`ERROR: ${problem.message}`, Route.LogLevel.ERR, req.context.id);
      throw problem;
    }
    refuseEntitiesOutsidePolicy(model, entities, req.context.ac, this.schemaName);

    return entities;
  }

  override async _exec(req: Request, _res: Response, entities: AdapterDocument[]) {
    try {
      return await (await this.routeModel()).add(entities);
    } catch (err) {
      if (!(err instanceof Helpers.Errors.DuplicateIdError)) throw err;

      const problem = takenIdError(err, entities, this.schemaName);
      this.log(`ERROR: ${problem.message}`, Route.LogLevel.ERR, req.context.id);
      throw problem;
    }
  }
}
