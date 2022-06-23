const AccessControlConditions = require('./conditions');

/**
 * @class PolicyMatch
 */
class PolicyMatch {
	constructor() {}

	__getUserPolicies(policies, user) {
		return policies.reduce((arr, p) => {
			const match = this.__checkPolicySelection(p, user);
			if (!match) return arr;

			arr = arr.concat(p.attributes);
			return arr;
		}, []);
	}

	__checkPolicySelection(p, user) {
		let match = false;
		const selection = p.selection;

		Object.keys(selection).forEach((key) => {
			if (!user.policyProperties || !(key in user.policyProperties)) return;

			const [selectionCriterionKey] = Object.keys(selection[key]);
			const [selectionCriterionValue] = Object.values(selection[key]);

			match = AccessControlConditions.__evaluateOperation(user.policyProperties[key], selectionCriterionValue, selectionCriterionKey);
		});

		return match;
	}
}
module.exports = new PolicyMatch();
