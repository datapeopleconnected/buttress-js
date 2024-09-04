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

import AccessControlHelpers from './helpers';

/**
 * @class PolicyMatch
 */
class PolicyMatch {
	constructor() {}

	__getTokenPolicies(policies, token) {
		return policies.reduce((arr, p) => {
			if (!p.selection) return arr;

			const match = this.__checkPolicySelection(p, token);
			if (!match) return arr;

			arr = arr.concat(p);
			return arr;
		}, []);
	}

	__checkPolicySelection(p, token): boolean {
		const selection = p.selection;

		if (!token) return false;

		if (token.type === 'dataSharing') {
			const eq = (part, value) => part && part['@eq'] && part['@eq'].toString() === value.toString();
			return eq(selection['#tokenType'], 'DATA_SHARING') && eq(selection['id'], token.id);
		}

		if (!token.policyProperties) return false;

		const policyProperties = token.policyProperties;
		const matches = Object.keys(selection).reduce((arr: boolean[], key) => {
			if (!(key in policyProperties)) return arr;
			const [selectionCriterionKey] = Object.keys(selection[key]);
			let [rhs] = Object.values(selection[key]);
			let lhs = policyProperties[key];
			lhs = (!Array.isArray(lhs)) ? [lhs] : lhs;
			if (typeof rhs === 'string') rhs = rhs.toUpperCase();
			lhs = lhs.map((s) => {
				if (typeof lhs === 'string') s = s.toUpperCase();
				return s;
			});

			const selectionMatches = lhs.reduce((acc: Array<boolean>, val) => {
				acc.push(AccessControlHelpers.evaluateOperation(val, rhs, selectionCriterionKey));
				return acc;
			}, []);
			arr.push(selectionMatches);

			return arr;
		}, []).flat();
		
		return (matches.length > 0) ? matches.every((v) => v) : false;
	}
}
export default new PolicyMatch();
