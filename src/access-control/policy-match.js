const AccessControlHelpers = require('./helpers');

/**
 * @class PolicyMatch
 */
class PolicyMatch {
	constructor() {}

	__getEntityPolicies(policies, entity) {
		return policies.reduce((arr, p) => {
			if (!p.selection) return arr;

			const match = this.__checkPolicySelection(p, entity);
			if (!match) return arr;

			arr = arr.concat(p);
			return arr;
		}, []);
	}

	__checkPolicySelection(p, entity) {
		let match = false;
		const selection = p.selection;

		if (!entity || !entity.policyProperties) return;

		const policyProperties = entity.policyProperties;
		const matches = Object.keys(selection).reduce((arr, key) => {
			if (!(key in policyProperties)) return arr;
			const [selectionCriterionKey] = Object.keys(selection[key]);
			const [rhs] = Object.values(selection[key]);
			const lhs = policyProperties[key];
			match = AccessControlHelpers.evaluateOperation(lhs.toUpperCase(), rhs.toUpperCase(), selectionCriterionKey);
			arr.push(match);

			return arr;
		}, []);

		return (matches.length > 0)? matches.every((v) => v) : match;
	}
}
module.exports = new PolicyMatch();
