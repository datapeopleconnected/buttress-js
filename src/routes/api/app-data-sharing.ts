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
import {
  CoreBulkUpdate,
  CoreCount,
  CoreGetList,
  CoreGetOne,
  CoreRouteConfig,
  CoreSearch,
  CoreUpdateByPath,
} from '../core-routes.js';
import Model from '../../model/index.js';
import { invalidEntityError, invalidUpdateError } from '../../model/shared.js';
import * as Helpers from '../../helpers/index.js';

import Datastore from '../../datastore/index.js';
import DatastoreFactory from '../../datastore/adapter-factory.js';

import ButtressAdapater from '../../datastore/adapters/buttress.js';
import ObjectIdHelper from '../../datastore/adapters/object-id.js';
import TokenSchemaModel, { Token } from '../../model/core/token.js';
import AppDataSharingSchemaModel, { AppDataSharing, AppDataSharingAddBody } from '../../model/core/app-data-sharing.js';
import PolicySchemaModel from '../../model/core/policy.js';
import { Services } from '../../bootstrap.js';
import { App } from '../../model/core/app.js';
import type { DataShareActivatedMessage } from '../../services/nrp.js';
import { UpdatePathBody } from '../../types/datastore.js';
import type { CoreRouteClass, RequestWithBody } from '../../types/routes.js';
import { dataSharingDestinationProblem, remoteAppUrlsOf } from '../../helpers/egress.js';
import { checkPolicyConfig, invalidPolicy } from '../../access-control/policy-definition.js';

// What the activate route (ActivateAppDataSharing) responds with. A remote whose side of the agreement is already
// active responds `true` instead, which has no `status` so is treated as not activated.
interface DataSharingActivationResult {
  status: boolean;
  token: string;
  // The partner's app, from a Buttress that pairs by app
  appId?: string;
}

/**
 * The data sharing agreement registration process should be as follows:
 * 1. A data sharing agreement is created on App1.
 * 2. App one gives the admin of App2 the registration token.
 * 3. App2 creates a data sharing agreement with remoteApp.token field populated.
 * 4. App2 will send a request to App1 to activate using the registration token to make the request and a new token in the post data.
 * 5. App1 will replace `remoteApp.token` with the new token, activate the data sharing agreement on it's side and return the new token.
 * 6. App2 will replace it's remoteApp.token with the new token & activate the agreement on it's side.
 */
/**
 * @param {object} dataSharing
 * @param {string} dataSharingTokenId
 * @return {object} dataSharing
 */
const activateDataSharing = async (
  dataSharing: AppDataSharing,
  dataSharingTokenId: string,
  models: { agreements: AppDataSharingSchemaModel; tokens: TokenSchemaModel },
) => {
  // Create new token
  const newToken = Model.getCoreModel(TokenSchemaModel).createTokenString();

  let connectionString = Helpers.DataSharing.createDataSharingConnectionString(dataSharing.remoteApp);

  // Create datastore, this will be used to activate the data sharing agreement.
  const buttressAdapter = DatastoreFactory.create(connectionString);
  await buttressAdapter.connect();

  if (buttressAdapter instanceof ButtressAdapater === false) {
    throw new Error('Expected a Buttress Adapter but got something else');
  }

  // Send a request to the remote app to activate the data sharing agreement.
  // @buttress/api doesn't type the response
  const activationResult = (await buttressAdapter.activateDataSharing(
    dataSharing.remoteApp.token,
    newToken,
    String(dataSharing._appId),
  )) as DataSharingActivationResult | null;
  if (!activationResult || !activationResult.status) return dataSharing;

  // Flag our data sharing agreement as active, update the remote app token with the new one, and record the partner's
  // app, where a create that names it goes. A partner from before pairing gave it doesn't, and is asked later.
  const partnerAppId = ObjectIdHelper.isValid(activationResult.appId) ? String(activationResult.appId) : null;
  await models.agreements.activate(dataSharing.id, activationResult.token, partnerAppId);
  dataSharing.remoteApp.token = activationResult.token;
  dataSharing.remoteApp.appId = partnerAppId;

  // Update our data sharing agreement token with the new value.
  await models.tokens.updateById(dataSharingTokenId, { $set: { value: newToken } });

  // Rebuild the connection string with the new token
  connectionString = Helpers.DataSharing.createDataSharingConnectionString(dataSharing.remoteApp);

  // Destroy the current adapter and re-open it again with the new token
  await buttressAdapter.close();

  // Establish a connection using the datastore manager so it's ready for any future requests.
  // TOOD: Handle errors with the new token here.
  const datastore = Datastore.createInstance({ connectionString });
  await datastore.connect();

  dataSharing.active = true;
  return dataSharing;
};

/**
 * Activation of a data sharing agreements should be as follows:
 * 1. App2 will send a request to App1 to activate using the registration token to make the request and a new token in the post data.
 * 2. App1 will replace `remoteApp.token` with the new token, activate the data sharing agreement on it's side and return the new token.
 * 3. App2 will replace it's remoteApp.token with the new token & activate the agreement on it's side.
 */

/**
 * De-Activation of a data sharing agreements should be as follows:
 * 1. App1 will set it's data sharing agreement property `active` to false, shutdown connections and clean up schema/routes.
 * 2. App1 will send a request to App2 to deactivate the data sharing agreement. (Optional)
 * 3. App2 will set it's data sharing agreement property `active` to false, shutdown connections and clean up schema/routes (Optional)
 */

const routes: CoreRouteClass[] = [];

// The operator doesn't let agreements connect there
const destinationRefused = (problem: string) =>
  Helpers.Errors.badRequest(
    `data_sharing_${problem}`,
    "The agreement's remote app is at a destination that isn't allowed",
  );

// Why a system-only route reaches every app
const SYSTEM_ONLY = 'the route takes only system tokens';

/**
 * @class GetAppDataSharingIdentity
 * @description Called by a partner Buttress with the token this app gave it, to learn which app the agreement pairs it
 *   with: an agreement paired before pairing told each side the other's app asks this. It comes before
 *   `app-data-sharing/:id`, which would take `identity` for an id.
 */
class GetAppDataSharingIdentity extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing/identity',
      'GET App Data Sharing Identity',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.DATASHARING;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: Request, _res: Response) {
    if (req.context.token?.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.DATA_SHARING) {
      throw Helpers.Errors.forbidden(
        'invalid_token_type',
        "Only a partner's data sharing token can ask which app it's for",
      );
    }
    if (!req.context.authApp) throw Helpers.Errors.internal('no_authenticated_app');

    return req.context.authApp;
  }

  override async _exec(_req: Request, _res: Response, app: App) {
    return { appId: String(app.id) };
  }
}
routes.push(GetAppDataSharingIdentity);

/**
 * @class GetAppDataSharing
 */
class GetAppDataSharing extends CoreGetOne<AppDataSharingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'app-data-sharing/:id',
    name: 'GET APP DATA SHARING',
    model: AppDataSharingSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.READ,
  };
}
routes.push(GetAppDataSharing);

/**
 * @class AddDataSharing
 */
class AddDataSharing extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing',
      'ADD APP DATA SHARING',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.ADD;
  }

  override async _validate(req: RequestWithBody<AppDataSharingAddBody>, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_app'));
    }

    const validation = Model.getCoreModel(AppDataSharingSchemaModel).validate(req.body);
    if (!validation.isValid) {
      const err = invalidEntityError(this.schemaName, validation);
      this.log(err.message, Route.LogLevel.ERR, req.context.id);
      return Promise.reject(err);
    }

    // If we're not super then set the appId to be the current appId
    if (req.context.token?.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM || !req.body.appId) {
      // ! This line is kind of werid.
      req.body.appId = req.context.token?._appId;
    }

    if (!req.body.policyConfig) {
      this.log(`[${this.name}] Policy Config is required when creating a data sharing agreement`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_policy'));
    }

    // The agreement's policy is made from it, so it's checked as a policy's configs are when it's saved: verbs or a
    // schema given as text, which the policy schema doesn't take, would be stored as it is
    const issues = checkPolicyConfig(req.body.policyConfig).map((issue) => ({
      ...issue,
      path: issue.path.replace(/^config/, 'policyConfig'),
    }));
    if (issues.length > 0) {
      this.log(`[${this.name}] Invalid policy config for ${req.body.name}`, Route.LogLevel.ERR);
      return Promise.reject(invalidPolicy(req.body.name, issues));
    }

    // Only to hosts the operator allows, when they've set a list
    const destination = await dataSharingDestinationProblem([req.body.remoteApp?.endpoint, req.body.remoteApp?.ws]);
    if (destination) return Promise.reject(destinationRefused(destination));

    const result = await this.unscopedModel(
      AppDataSharingSchemaModel,
      'isDuplicate compares the body, app included',
    ).isDuplicate(req.body);
    if (result === true) {
      this.log(`${this.schemaName}: Duplicate entity`, Route.LogLevel.ERR, req.context.id);
      return Promise.reject(Helpers.Errors.badRequest('duplicate'));
    }

    return true;
  }

  override async _exec(req: RequestWithBody<AppDataSharingAddBody>, _res: Response, _validate: boolean) {
    // The app _validate settled on: the caller's, or one a system token names
    const { dataSharing, token } = await this.scoped(req, AppDataSharingSchemaModel).add(req.body, {
      _appId: req.body.appId,
    });
    // let dataSharing = (result.dataSharing) ? result.dataSharing : result;
    this.log(`Added App Data Sharing ${dataSharing.id}`);

    if (dataSharing.remoteApp.token) {
      this.log(`Activating data sharing agreement ${dataSharing.id}`);
      return await activateDataSharing(dataSharing, token.id, {
        agreements: await this.scoped(req, AppDataSharingSchemaModel).owned(dataSharing.id),
        tokens: await this.scoped(req, TokenSchemaModel).owned(token.id),
      });
    }

    return Object.assign(dataSharing, {
      registrationToken: token.value,
    });
  }
}
routes.push(AddDataSharing);

/**
 * @class UpdateAppDataSharing
 */
class UpdateAppDataSharing extends CoreUpdateByPath<AppDataSharingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'app-data-sharing/:dataSharingId',
    name: 'UPDATE APP DATA SHARING AGREEMENT',
    model: AppDataSharingSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.WRITE,
    idParam: 'dataSharingId',
  };

  // The partner it would reach has to be one the operator allows
  protected override async updateProblem(_req: Request, updates: UpdatePathBody[]) {
    const destination = await dataSharingDestinationProblem(remoteAppUrlsOf(updates));
    return destination ? destinationRefused(destination) : null;
  }
}
routes.push(UpdateAppDataSharing);

/**
 * @class BulkUpdateAppDataSharing
 */
class BulkUpdateAppDataSharing extends CoreBulkUpdate<AppDataSharingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'app-data-sharing/bulk/update',
    name: 'BULK UPDATE APP DATA SHARING AGREEMENT',
    model: AppDataSharingSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.WRITE,
  };

  // The partner it would reach has to be one the operator allows
  protected override async updateProblem(_req: Request, updates: UpdatePathBody[]) {
    const destination = await dataSharingDestinationProblem(remoteAppUrlsOf(updates));
    return destination ? destinationRefused(destination) : null;
  }
}
routes.push(BulkUpdateAppDataSharing);

/**
 * @class UpdateAppDataSharingPolicy
 * @description Gives an agreement's partner new access: the body is the configs of the agreement's policy, as
 *   `policyConfig` is given when the agreement is added, and replaces them.
 */
class UpdateAppDataSharingPolicy extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing/:dataSharingId/policy',
      'UPDATE APP DATA SHARING AGREEMENT POLICY',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: RequestWithBody<unknown, { dataSharingId: string }>, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      throw Helpers.Errors.internal('no_authenticated_app');
    }

    const appId = req.context.authApp.id;

    if (!req.params.dataSharingId) {
      this.log('ERROR: No Data Sharing Id', Route.LogLevel.ERR);
      throw Helpers.Errors.badRequest('missing_id', 'An id is required');
    }

    const dataSharingId = req.params.dataSharingId;
    if (!Model.getCoreModel(AppDataSharingSchemaModel).isValidId(dataSharingId)) {
      throw Helpers.Errors.badRequest('invalid_id', 'The id is not valid');
    }

    // Checked as a policy's configs are when they're saved, and read as the policy schema reads them
    const issues = checkPolicyConfig(req.body);
    if (issues.length > 0) {
      this.log(`[${this.name}] Invalid policy config for ${dataSharingId}`, Route.LogLevel.ERR);
      throw invalidPolicy(undefined, issues);
    }
    const { validation, body: updates } = Model.getCoreModel(PolicySchemaModel).validateUpdate({
      path: 'config',
      value: req.body,
    });
    if (!validation.isValid) throw invalidUpdateError(PolicySchemaModel.Schema.name, validation);

    // The caller's app's agreement, which a system token names too
    const agreement = await this.scoped(req, AppDataSharingSchemaModel).findOne({ id: dataSharingId, _appId: appId });
    if (!agreement) {
      this.log(`${this.schemaName}: unknown data sharing`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.entityNotFound('appDataSharing', dataSharingId);
    }

    // The policy made with it. An agreement made before that was recorded, or whose policy was removed, has none.
    const policy = agreement._policyId
      ? await this.scoped(req, PolicySchemaModel).findById(String(agreement._policyId))
      : null;
    if (!policy) {
      this.log(`${this.schemaName}: no policy for data sharing ${dataSharingId}`, Route.LogLevel.ERR, req.context.id);
      throw Helpers.Errors.notFound('not_found', "The agreement's policy was not found", { schema: 'policy' });
    }

    return { policyId: String(policy.id), updates };
  }

  override async _exec(
    req: RequestWithBody<unknown, { dataSharingId: string }>,
    _res: Response,
    validate: { policyId: string; updates: UpdatePathBody[] },
  ) {
    // Through the policy model, which caches the policy again and works out its tokens' policies again, so the
    // partner's requests and realtime go by the new configs
    await this.scoped(req, PolicySchemaModel).updateByPath(validate.updates, validate.policyId);
    return true;
  }
}
routes.push(UpdateAppDataSharingPolicy);

/**
 * @class ActivateAppDataSharing
 * @description This endpoint will be called by remote buttress apps to activate
 *   data sharing agreement. This endpoint will be made Buttres <-> Buttress and
 *   not by a end user.
 */
class ActivateAppDataSharing extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing/activate',
      'POST Activate App Data Sharing',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.POST;
    this.authType = Route.Constants.Type.DATASHARING;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: RequestWithBody<{ newToken: string }>, _res: Response) {
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_app'));
    }

    if (!req.context.token) {
      this.log('ERROR: No authenticated token', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_token'));
    }

    const token = req.context.token;

    if (token.type !== Model.getCoreModel(TokenSchemaModel).Constants.Type.DATA_SHARING) {
      this.log(`ERROR: invalid token type, type was ${token.type}`, Route.LogLevel.ERR);
      return Promise.reject(
        Helpers.Errors.forbidden('invalid_token_type', "Only a partner's data sharing token can activate an agreement"),
      );
    }

    if (!req.body.newToken) {
      this.log('ERROR: missing remote data sharing token', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_data_token'));
    }

    // The partner's app, which a Buttress that pairs by app gives, to record on the agreement
    const partnerAppId = req.query.appId;
    if (partnerAppId !== undefined && !ObjectIdHelper.isValid(partnerAppId)) {
      this.log('ERROR: invalid partner app id', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('invalid_app_id', "The partner app's id is not valid"));
    }

    // The token's app is the agreement's
    return this.scoped(req, AppDataSharingSchemaModel)
      .findById(token._appDataSharingId)
      .then((dataSharing) => {
        if (!dataSharing) {
          this.log(`ERROR: Unable to find dataSharing with token ${token.id}`, Route.LogLevel.ERR, req.context.id);
          throw Helpers.Errors.internal('no_datasharing');
        }

        // The partner completes the handshake once. An agreement that has been active, and so has the partner's
        // token, was deactivated by this app, and only this app can reactivate it.
        if (!dataSharing.active && dataSharing.remoteApp?.token) {
          this.log(`ERROR: Partner tried to activate deactivated agreement ${dataSharing.id}`, Route.LogLevel.ERR);
          throw Helpers.Errors.forbidden('data_sharing_inactive', 'The data sharing agreement is not active');
        }

        return {
          token,
          dataSharing,
          partnerAppId: partnerAppId === undefined ? null : String(partnerAppId),
        };
      });
  }

  override async _exec(
    req: RequestWithBody<{ newToken: string }>,
    res: Response,
    { token, dataSharing, partnerAppId }: { token: Token; dataSharing: AppDataSharing; partnerAppId: string | null },
  ): Promise<DataSharingActivationResult | true> {
    if (dataSharing.active) return true;

    const newLocalToken = Model.getCoreModel(TokenSchemaModel).createTokenString();

    const { newToken } = req.body;
    await (
      await this.scoped(req, AppDataSharingSchemaModel).owned(dataSharing.id)
    ).activate(dataSharing.id, newToken, partnerAppId);

    await (
      await this.scoped(req, TokenSchemaModel).owned(token.id.toString())
    ).updateById(token.id.toString(), {
      $set: { value: newLocalToken },
    });

    return {
      status: true,
      token: newLocalToken,
      // So the partner records which app it's paired with
      appId: String(dataSharing._appId),
    };
  }
}
routes.push(ActivateAppDataSharing);

/**
 * @class ReactivateAppDataSharing
 * @description This endpoint will be called by buttress app admins to reactivate
 *  a data sharing agreement which has been deactivated. It will follow the same
 *  flow as the activate endpoint and cycle tokens.
 */
class ReactivateAppDataSharing extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing/reactivate/:dataSharingId',
      'UPDATE Reactivate App Data Sharing',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: RequestWithBody<unknown, { dataSharingId: string }>, _res: Response) {
    const dataSharingId = req.params.dataSharingId;
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_app'));
    }

    if (!req.params.dataSharingId) {
      this.log('ERROR: missing data sharing id', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const exists = await this.scoped(req, AppDataSharingSchemaModel).findByIdOrFail(dataSharingId);

    return exists;
  }

  override _exec(req: Request, _res: Response, dataSharing: AppDataSharing) {
    return this.scoped(req, AppDataSharingSchemaModel)
      .owned(dataSharing.id)
      .then((agreements) => agreements.activate(dataSharing.id))
      .then(() => true);
  }
}
routes.push(ReactivateAppDataSharing);

/**
 * @class DeactivateAppDataSharing
 */
class DeactivateAppDataSharing extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing/deactivate/:dataSharingId',
      'UPDATE Deactivate App Data Sharing',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.PUT;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(req: RequestWithBody<unknown, { dataSharingId: string }>, _res: Response) {
    const dataSharingId = req.params.dataSharingId;
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_app'));
    }

    if (!req.params.dataSharingId) {
      this.log('ERROR: missing data sharing id', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const exists = await this.scoped(req, AppDataSharingSchemaModel).findByIdOrFail(dataSharingId);

    return exists;
  }

  override _exec(req: Request, res: Response, dataSharing: AppDataSharing) {
    return this.scoped(req, AppDataSharingSchemaModel)
      .owned(dataSharing.id)
      .then((agreements) => agreements.deactivate(dataSharing.id))
      .then(() => true);
  }
}
routes.push(DeactivateAppDataSharing);

class StatusAppDataSharing extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing/:dataSharingId/status',
      'GET App Data Sharing Status',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.GET;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.READ;
  }

  override async _validate(req: RequestWithBody<unknown, { dataSharingId: string }>, _res: Response) {
    const dataSharingId = req.params.dataSharingId;
    if (!req.context.authApp) {
      this.log('ERROR: No authenticated app', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.internal('no_authenticated_app'));
    }

    if (!req.params.dataSharingId) {
      this.log('ERROR: missing data sharing id', Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const exists = await this.scoped(req, AppDataSharingSchemaModel).findByIdOrFail(dataSharingId);

    return exists;
  }

  override async _exec(_req: Request, _res: Response) {
    return {
      connected: false,
    };
  }
}
routes.push(StatusAppDataSharing);

/**
 * @class GetAllAppDataSharing
 */
class GetAllAppDataSharing extends CoreGetList<AppDataSharingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'app-data-sharing',
    name: 'APP DATA SHARING AGREEMENT LIST',
    model: AppDataSharingSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.LIST,
  };
}
routes.push(GetAllAppDataSharing);

/**
 * @class SearchAppDataSharingAgreement
 */
class SearchAppDataSharingAgreement extends CoreSearch<AppDataSharingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'app-data-sharing',
    name: 'SEARCH APP DATA SHARING AGREEMENT LIST',
    model: AppDataSharingSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.LIST,
  };
}
routes.push(SearchAppDataSharingAgreement);

/**
 * @class AppDataSharingAgreementCount
 */
class AppDataSharingAgreementCount extends CoreCount<AppDataSharingSchemaModel> {
  static override config: CoreRouteConfig = {
    path: 'app-data-sharing/count',
    name: 'COUNT APP DATA SHARING AGREEMENT',
    model: AppDataSharingSchemaModel,
    authType: Route.Constants.Type.APP,
    permissions: Route.Constants.Permissions.SEARCH,
  };
}
routes.push(AppDataSharingAgreementCount);

/**
 * @class DeleteDataSharingAgreement
 */
class DeleteDataSharingAgreement extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing/:id',
      'DELETE APP DATA SHARING AGREEMENT',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.APP;
    this.permissions = Route.Constants.Permissions.DELETE;

    this.activityBroadcast = false;
  }

  override async _validate(req: RequestWithBody<unknown, { id: string }>, _res: Response) {
    if (!req.params.id) {
      this.log(`[${this.name}] Missing required App Data Sharing ID`, Route.LogLevel.ERR);
      return Promise.reject(Helpers.Errors.badRequest('missing_id', 'An id is required'));
    }

    const appDataSharing = await this.scoped(req, AppDataSharingSchemaModel).findByIdOrFail(req.params.id);

    const appDataSharingToken = await this.scoped(req, TokenSchemaModel).findById(appDataSharing._tokenId);
    if (!appDataSharingToken) {
      this.log('ERROR: Could not fetch Data Sharing token', Route.LogLevel.ERR);
      return Promise.reject(
        Helpers.Errors.notFound('not_found', "The agreement's token was not found", { schema: 'token' }),
      );
    }

    return {
      appDataSharing,
      token: appDataSharingToken,
    };
  }

  override async _exec(req: Request, res: Response, validate: { appDataSharing: AppDataSharing; token: Token }) {
    await this.scoped(req, AppDataSharingSchemaModel).rm(validate.appDataSharing.id);
    await this.scoped(req, TokenSchemaModel).rm(validate.token.id);
    // The Socket primary closes its connection to the partner
    this._notify(
      'dataShare:deactivated',
      JSON.stringify({ appDataSharingId: validate.appDataSharing.id } satisfies DataShareActivatedMessage),
    );
    return true;
  }
}
routes.push(DeleteDataSharingAgreement);

/**
 * @class DeleteAppPolicies
 */
class DeleteAllDataSharingAgreement extends Route {
  constructor(services: Services) {
    super(
      'app-data-sharing',
      'DELETE ALL DATA SHARING',
      services,
      Model.getCoreModel(AppDataSharingSchemaModel).schemaData,
    );
    this.verb = Route.Constants.Verbs.DEL;
    this.authType = Route.Constants.Type.SYSTEM;
    this.permissions = Route.Constants.Permissions.WRITE;
  }

  override async _validate(_req: Request, _res: Response) {
    const dsFind = await this.unscopedModel(AppDataSharingSchemaModel, SYSTEM_ONLY).find(
      {},
      {},
      0,
      0,
      {},
      { id: 1, _tokenId: 1 },
    );

    return (await Helpers.streamAll<AppDataSharing>(dsFind)).reduce(
      (arr: { dsIds: string[]; tokenIds: string[] }, ds) => {
        arr.dsIds.push(ds.id);
        arr.tokenIds.push(ds._tokenId);
        return arr;
      },
      {
        dsIds: [],
        tokenIds: [],
      },
    );
  }

  override async _exec(req: Request, res: Response, validate: { dsIds: string[]; tokenIds: string[] }) {
    await this.unscopedModel(AppDataSharingSchemaModel, SYSTEM_ONLY).rmBulk(validate.dsIds);
    await this.unscopedModel(TokenSchemaModel, SYSTEM_ONLY).rmBulk(validate.tokenIds);
    // The Socket primary closes their connections to partners
    for (const appDataSharingId of validate.dsIds) {
      this._notify('dataShare:deactivated', JSON.stringify({ appDataSharingId } satisfies DataShareActivatedMessage));
    }

    return true;
  }
}
routes.push(DeleteAllDataSharingAgreement);

/**
 * @type {*[]}
 */
export default routes;
