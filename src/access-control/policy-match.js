const AccessControlHelpers = require('./helpers');

/**
 * @class PolicyMatch
 */
class PolicyMatch {
	constructor() {}

	__getEntityPolicies(policies, appId, entity) {
		return policies.reduce((arr, p) => {
			if (!p.selection) return arr;

			const match = this.__checkPolicySelection(p, appId, entity);
			if (!match) return arr;

			arr = arr.concat(p);
			return arr;
		}, []);
	}

	__checkPolicySelection(p, appId, entity) {
		let match = false;
		const selection = p.selection;

		const userAppMetaData = (entity._appMetadata) ? entity._appMetadata?.find((md) => md.appId.toString() === appId.toString()) : entity;
		const entityPolicies = entity.policyProperties;
		if ((!userAppMetaData || !userAppMetaData.policyProperties) && !entityPolicies) return;

		const policyProperties = (userAppMetaData) ? userAppMetaData.policyProperties : entityPolicies;

		const matches = Object.keys(selection).reduce((arr, key) => {
			if (!(key in policyProperties)) return arr;
			const [selectionCriterionKey] = Object.keys(selection[key]);
			const [rhs] = Object.values(selection[key]);
			const lhs = policyProperties[key][selectionCriterionKey];
			match = AccessControlHelpers.evaluateOperation(lhs, rhs, selectionCriterionKey);
			arr.push(match);

			return arr;
		}, []);

		return (matches.length > 0)? matches.every((v) => v) : match;
	}
}
module.exports = new PolicyMatch();
