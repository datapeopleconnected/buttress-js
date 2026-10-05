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

import { matchCriterion } from './criteria.js';
import { isPlainObject } from './operators.js';

import { Policy, PolicySelection } from '../model/core/policy.js';
import { PolicyProperties, Token } from '../model/core/token.js';

// A selection's keys that hold a list of selections: all of them must select a token, or any one
const LOGICAL_KEYS = ['@and', '@or'];

/**
 * @class PolicyMatch
 */
class PolicyMatch {
  constructor() {}

  getTokenPolicies(policies: Policy[], token?: Token) {
    return policies.reduce((arr: Policy[], p) => {
      if (!p.selection) return arr;

      const match = this.__checkPolicySelection(p, token);
      if (!match) return arr;

      arr = arr.concat(p);
      return arr;
    }, []);
  }

  __checkPolicySelection(p: Policy, token?: Token): boolean {
    const selection = p.selection;

    if (!token || !selection) return false;

    if (token.type === 'dataSharing') {
      const eq = (part: unknown, value: string) => isPlainObject(part) && matchCriterion(value, '@eq', part['@eq']);
      return eq(selection['#tokenType'], 'DATA_SHARING') && eq(selection['id'], String(token.id));
    }

    if (!token.policyProperties) return false;

    return this.selects(selection, token.policyProperties);
  }

  /**
   * Whether a selection selects a token by its policy properties (D-35): every key of the selection holds, each a
   * property the token has whose value passes every criterion given for it, as a query's field would (D-32).
   * `@and` and `@or` take a list of selections, which all, or any one, must select the token. A selection with no
   * keys, and an `@and` or `@or` with no selections, select nothing.
   * @param {PolicySelection} selection
   * @param {PolicyProperties} properties - the token's
   * @return {boolean}
   */
  selects(selection: PolicySelection, properties: NonNullable<PolicyProperties>): boolean {
    const entries = Object.entries(selection);

    return (
      entries.length > 0 &&
      entries.every(([key, criteria]) => {
        if (LOGICAL_KEYS.includes(key)) {
          if (!Array.isArray(criteria) || criteria.length < 1) return false;
          const holds = (branch: unknown) =>
            isPlainObject(branch) && this.selects(branch as PolicySelection, properties);
          return key === '@and' ? criteria.every(holds) : criteria.some(holds);
        }

        if (!Object.hasOwn(properties, key) || !isPlainObject(criteria)) return false;
        const operators = Object.entries(criteria);
        return operators.length > 0 && operators.every(([op, operand]) => matchCriterion(properties[key], op, operand));
      })
    );
  }

  /**
   * Every policy property a selection names, within its `@and` and `@or` too.
   * @param {PolicySelection} selection
   * @return {string[]}
   */
  selectionKeys(selection: PolicySelection): string[] {
    const keys = Object.entries(selection).flatMap(([key, criteria]) => {
      if (!LOGICAL_KEYS.includes(key)) return [key];
      if (!Array.isArray(criteria)) return [];
      return criteria.flatMap((branch) => (isPlainObject(branch) ? this.selectionKeys(branch as PolicySelection) : []));
    });
    return [...new Set(keys)];
  }

  /**
   * The policy properties a selection takes a token by: every key it needs, within its `@and` too, and the keys of each
   * `@or` branch that holds for the token's properties. Not those of an `@or` branch that doesn't hold.
   * @param {PolicySelection} selection
   * @param {PolicyProperties} properties - the token's
   * @return {string[]}
   */
  selectedKeys(selection: PolicySelection, properties: NonNullable<PolicyProperties>): string[] {
    const keys = Object.entries(selection).flatMap(([key, criteria]) => {
      if (!LOGICAL_KEYS.includes(key)) return [key];
      if (!Array.isArray(criteria)) return [];
      const branches = criteria.filter((branch) => isPlainObject(branch)) as PolicySelection[];
      const taken = key === '@or' ? branches.filter((branch) => this.selects(branch, properties)) : branches;
      return taken.flatMap((branch) => this.selectedKeys(branch, properties));
    });
    return [...new Set(keys)];
  }
}
export default new PolicyMatch();
