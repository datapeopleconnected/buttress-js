const AccessControlConditions = require('./conditions');

/**
 * @class PolicyMatch
 */
class PolicyMatch {
	constructor() {}

	__getUserPolicies(policies, appId, user) {
		return policies.reduce((arr, p) => {
			const match = this.__checkPolicySelection(p, appId, user);
			if (!match) return arr;

			arr = arr.concat(p.attributes);
			return arr;
		}, []);
	}

	__checkPolicySelection(p, appId, user) {
		let match = false;
		const selection = p.selection;

		const userAppMetaData = user._appMetadata.find((md) => md.appId.toString() === appId.toString());
		if (!userAppMetaData || !userAppMetaData.policyProperties) return;

		const policyProperties = userAppMetaData.policyProperties;
		Object.keys(selection).forEach((key) => {
			if (!(key in policyProperties)) return;

			const [selectionCriterionKey] = Object.keys(selection[key]);
			const [selectionCriterionValue] = Object.values(selection[key]);

			match = AccessControlConditions.__evaluateOperation(policyProperties[key], selectionCriterionValue, selectionCriterionKey);
		});

		return match;
	}
}
module.exports = new PolicyMatch();
