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

import AccessControlPolicyMatch from './policy-match.js';
import { policyLimit } from './helpers.js';

import * as Helpers from '../helpers/index.js';
import Logging from '../helpers/logging.js';
import Model from '../model/index.js';
import PolicySchemaModel, { Policy, PolicySelection } from '../model/core/policy.js';
import TokenSchemaModel, { Token } from '../model/core/token.js';

// How long after one sweep ends the next starts
export const POLICY_EXPIRY_SWEEP_MS = 60 * 1000;

// Whether a policy's limit has passed by `now`. A limit that isn't a date hasn't: the policy grants nothing
// (isPolicyExpired), but it's left for its author to correct.
const limitPassed = (policy: Policy, now: Date) => {
  const limit = policyLimit(policy);
  return limit !== null && limit.getTime() <= now.getTime();
};

/**
 * Removes the policies whose limit has passed (SR-DPC-001 D1). A policy grants nothing from the moment its limit passes,
 * as every use of it checks (isPolicyExpired), so this only tidies up after it: the policy is removed, and so is the
 * policy property named after it, which is how a transient policy selects its tokens (createUserTransientPolicy in
 * buttress-js-api), from the tokens it selects. That property stays while a policy whose limit hasn't passed selects by
 * it too, and a token's other properties are never changed.
 *
 * The SPR primary sweeps, so one process does. A sweep reads the policies as they're stored, so a limit moved or removed
 * before it passes is kept to, and one missed while nothing was sweeping is caught by the next sweep.
 */
export class PolicyExpiry {
  private _timer?: NodeJS.Timeout;
  private _stopped = true;

  constructor(private _intervalMs = POLICY_EXPIRY_SWEEP_MS) {}

  // Sweeps now, and again a while after each sweep ends
  start() {
    this._stopped = false;
    void this._sweepThenWait();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
  }

  private async _sweepThenWait() {
    await this.sweep();
    if (this._stopped) return;

    // A sweep still to come doesn't keep the process running
    this._timer = setTimeout(() => void this._sweepThenWait(), this._intervalMs).unref();
  }

  /**
   * Removes every policy whose limit has passed by `now`. One that can't be removed is logged, and the next sweep tries
   * it again.
   * @param {Date} now
   * @return {Promise}
   */
  async sweep(now = new Date()) {
    let expired: Policy[];
    try {
      // A limit that isn't a date is never before a date to MongoDB
      expired = await Helpers.streamAll<Policy>(
        await Model.getCoreModel(PolicySchemaModel).find({ limit: { $lte: now } }),
      );
    } catch (err: unknown) {
      Logging.logError(`Unable to look for policies whose limit has passed: ${Helpers.getThrownErrorMessage(err)}`);
      return;
    }

    for (const policy of expired.filter((p) => limitPassed(p, now))) {
      try {
        await this._expire(policy, now);
      } catch (err: unknown) {
        Logging.logError(
          `Unable to remove policy ${policy.id}, its limit passed: ${Helpers.getThrownErrorMessage(err)}`,
        );
      }
    }
  }

  // Removes a policy whose limit has passed, and the property named after it from the tokens it selects, unless another
  // of the app's policies whose limit hasn't passed names that property in its selection
  private async _expire(policy: Policy, now: Date) {
    const property = policy.name;
    const selection = policy.selection;
    if (property && selection && AccessControlPolicyMatch.selectionKeys(selection).includes(property)) {
      if (!(await this._namedByOthers(policy, property, now))) {
        await this._removeProperty(policy._appId, selection, property);
      }
    }

    await Model.getCoreModel(PolicySchemaModel).rm(String(policy.id));
    Logging.logDebug(`Removed policy ${policy.id} (${policy.name}), its limit passed`);
  }

  // Whether another of the app's policies, one whose limit hasn't passed, names the property in its selection
  private async _namedByOthers(policy: Policy, property: string, now: Date) {
    const policies = await Helpers.streamAll<Policy>(
      await Model.getCoreModel(PolicySchemaModel).find({ _appId: policy._appId }),
    );

    return policies.some(
      (other) =>
        String(other.id) !== String(policy.id) &&
        !limitPassed(other, now) &&
        !!other.selection &&
        AccessControlPolicyMatch.selectionKeys(other.selection).includes(property),
    );
  }

  // Takes the property off each of the app's tokens the selection selects, as RemoveUserPolicyProperties takes one off
  private async _removeProperty(appId: string, selection: PolicySelection, property: string) {
    const tokens = Model.getCoreModel(TokenSchemaModel);
    const appTokens = await Helpers.streamAll<Token>(await tokens.find({ _appId: appId }));

    for (const token of appTokens) {
      const properties = token.policyProperties;
      if (!properties || !Object.hasOwn(properties, property)) continue;
      if (!AccessControlPolicyMatch.selects(selection, properties)) continue;

      const remaining = { ...properties };
      delete remaining[property];
      await tokens.updatePolicyProperties({ ...token, policyProperties: remaining }, remaining);
    }
  }
}
