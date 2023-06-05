const AccessControlHelpers = require('./helpers');

/**
 * @class PolicyMatch
 */
class PolicyMatch {
	constructor() {}

	__getTokenPolicies(policies, token) {
		console.log(policies);
		return policies.reduce((arr, p) => {
			if (!p.selection) return arr;

			const match = this.__checkPolicySelection(p, token);
			if (!match) return arr;

			arr = arr.concat(p);
			return arr;
		}, []);
	}

	__checkPolicySelection(p, token) {
		let match = false;
		const selection = p.selection;

		// if (token.type === 'dataSharing') {
		// 	console.log(p);
		// }

		if (!token || !token.policyProperties) return;

		const policyProperties = token.policyProperties;
		const matches = Object.keys(selection).reduce((arr, key) => {
			if (!(key in policyProperties)) return arr;
			const [selectionCriterionKey] = Object.keys(selection[key]);
			let [rhs] = Object.values(selection[key]);
			let lhs = policyProperties[key];
			if (!Number(rhs)) rhs = rhs.toUpperCase();
			if (!Number(lhs)) lhs = lhs.toUpperCase();

			match = AccessControlHelpers.evaluateOperation(lhs, rhs, selectionCriterionKey);
			arr.push(match);

			return arr;
		}, []);

		return (matches.length > 0) ? matches.every((v) => v) : match;
	}
}
module.exports = new PolicyMatch();
