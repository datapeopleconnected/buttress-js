/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2025 Data People Connected LTD.
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

// const fetch = require('cross-fetch');
import Config from './config.js';

export class BJSReqError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'BJSReqError';
		this.code = code;
	}
} 

export const bjsReq = async (opts, token=Config.testToken, text = false) => {
	opts.headers = opts.headers || {};
	opts.headers['Authorization'] = `Bearer ${token}`;

	const response = await fetch(`${opts.url}`, opts);
	if (response.status !== 200) {
		// Log out the body
		if (response.headers.get('content-type')?.includes('application/json')) {
			const body = await response.json();
			throw new BJSReqError(response.status, body.message || body);
		}

		console.error('error', await response.text());
		throw new BJSReqError(response.status, `Received non-200 (${response.status}) from ${opts.url}`);
	}
	return (text) ? await response.text() : await response.json();
};
export const bjsReqPost = async (url, body, token) => await bjsReq({
	url,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(body),
}, token);

export const createApp = async (ENDPOINT, name, apiPath, policyPropertiesList, token) => await bjsReqPost(`${ENDPOINT}/api/v1/app`, {
	name,
	apiPath,
	policyPropertiesList: policyPropertiesList || {},
}, token);
export const createLambda = async (ENDPOINT, lambda, auth, token) => await bjsReqPost(`${ENDPOINT}/api/v1/lambda`, {lambda, auth}, token);
export const createUser = async (ENDPOINT, userData, authData, token) => await bjsReqPost(`${ENDPOINT}/api/v1/user`, {auth: [userData], token: authData, policyProperties: userData.policyProperties}, token);
export const createPolicy = async (ENDPOINT, policy, token) => await bjsReqPost(`${ENDPOINT}/api/v1/policy`, policy, token);

export const createPolicyUser = async (ENDPOINT, app, key, policyProperties) => {
  const user = await createUser(ENDPOINT, {
    app: 'app-test',
    appId: `${key}-${Math.floor(Math.random() * 1000)}`,
    email: `${key}+${Math.floor(Math.random() * 1000)}@buttressjs.com`,
  }, {
    domains: ['test.local.buttressjs.com'],
    policyProperties,
  }, app.token);

	// for await (const token of user.tokens) {
	// 	// Query the token 
	// 	const res = await bjsReq({
	// 		url: `${ENDPOINT}/api/v1/token`,
	// 		method: 'SEARCH',
	// 	}, app.token);
	// }

	// // Fetch the tokenIds. We need it for testing.
	// console.log(user);

  return user;
}

export const deleteApp = async (ENDPOINT, appId, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/${appId}`,
	method: 'DELETE',
}, token);

export const updateSchema = async (ENDPOINT, schema, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/schema`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(schema),
}, token);
export const updatePolicyPropertyList = async (ENDPOINT, list, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/policy-property-list/true`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(list),
}, token);
export const registerDataSharing = async (ENDPOINT, agreement, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app-data-sharing`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(agreement),
}, token);

export const updateUserPolicyProperties = async (ENDPOINT, userId, body, userToken, apiToken) => bjsReq({
	url: `${ENDPOINT}/api/v1/user/${userId}/policy-property/${userToken}`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(body),
}, apiToken);

export const extractPolicyPropertyListFromPolicies = (policies) => {
	return policies.reduce((list, policy) => {
		if (policy.selection) {
			Object.keys(policy.selection).forEach((key) => {
				if (!list[key]) list[key] = [];
				if (typeof policy.selection[key] === 'object') {
					list[key].push(...Object.values(policy.selection[key]));
				} else {
					list[key].push(policy.selection[key]);
				}
			});
		}
		return list;
	}, {});
};

// export default {
// 	BJSReqError,
// 	bjsReq,
// 	bjsReqPost,

// 	extractPolicyPropertyListFromPolicies,

// 	createApp,
// 	createUser,
// 	createPolicy,
// 	createLambda,
// 	createPolicyUser,

// 	updateSchema,
// 	updatePolicyPropertyList,
// 	updateUserPolicyProperties,

// 	registerDataSharing,

// 	deleteApp,
// };
