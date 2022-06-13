const AccessControlConditions = require('./conditions');

/**
 * @class Shared
 */
class Shared {
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
			const [selectionCriterionKey] = Object.keys(selection[key]);
			const [selectionCriterionValue] = Object.values(selection[key]);

			match = AccessControlConditions.__evaluateOperation(selectionCriterionValue, user.policyProperties[key], selectionCriterionKey);
		});

		return match;
	}
}
module.exports = new Shared();
