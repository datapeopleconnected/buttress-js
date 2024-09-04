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

const fetch = require('cross-fetch');
const Config = require('node-env-obj')();

class BJSReqError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'BJSReqError';
		this.code = code;
	}
} 

const bjsReq = async (opts, token=Config.testToken, floop = false) => {
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
	return (floop) ? await response.text() : await response.json();
};
const bjsReqPost = async (url, body, token) => await bjsReq({
	url,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(body),
}, token);

const createApp = async (ENDPOINT, name, apiPath, policyPropertiesList, token) => await bjsReqPost(`${ENDPOINT}/api/v1/app`, {
	name,
	apiPath,
	policyPropertiesList: policyPropertiesList || {},
}, token);
const createLambda = async (ENDPOINT, lambda, auth, token) => await bjsReqPost(`${ENDPOINT}/api/v1/lambda`, {lambda, auth}, token);
const createUser = async (ENDPOINT, userData, authData, token) => await bjsReqPost(`${ENDPOINT}/api/v1/user`, {auth: [userData], token: authData, policyProperties: userData.policyProperties}, token);
const createPolicy = async (ENDPOINT, policy, token) => await bjsReqPost(`${ENDPOINT}/api/v1/policy`, policy, token);

const updateSchema = async (ENDPOINT, schema, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/schema`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(schema),
}, token);
const updatePolicyPropertyList = async (ENDPOINT, list, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/policy-property-list/true`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(list),
}, token);
const registerDataSharing = async (ENDPOINT, agreement, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app-data-sharing`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(agreement),
}, token);

const updateUserPolicyProperties = async (ENDPOINT, userId, body, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/user/${userId}/policy-property`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(body),
}, token);

module.exports = {
	BJSReqError,
	bjsReq,
	bjsReqPost,
	createApp,
	createUser,
	createPolicy,
	createLambda,
	updateSchema,
	updatePolicyPropertyList,
	updateUserPolicyProperties,
	registerDataSharing,
};
