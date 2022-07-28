const AccessControlConditions = require('./conditions');

/**
 * @class PolicyMatch
 */
class PolicyMatch {
	constructor() {}

	__getUserPolicies(policies, appId, user) {
		return policies.reduce((arr, p) => {
			if (!p.selection) return arr;

			const match = this.__checkPolicySelection(p, appId, user);
			if (!match) return arr;

			arr = arr.concat(p);
			return arr;
		}, []);
	}

	__checkPolicySelection(p, appId, user) {
		let match = false;
		const selection = p.selection;

		const userAppMetaData = user._appMetadata.find((md) => md.appId.toString() === appId.toString());
		if (!userAppMetaData || !userAppMetaData.policyProperties) return;

		const policyProperties = userAppMetaData.policyProperties;

		const matches = Object.keys(selection).reduce((arr, key) => {
			if (!(key in policyProperties)) return arr;
			const [selectionCriterionKey] = Object.keys(selection[key]);
			const [selectionCriterionValue] = Object.values(selection[key]);

			match = AccessControlConditions.evaluateOperation(policyProperties[key], selectionCriterionValue, selectionCriterionKey);
			arr.push(match);

			return arr;
		}, []);

		return (matches.length > 0)? matches.every((v) => v) : match;
	}
}
module.exports = new PolicyMatch();
