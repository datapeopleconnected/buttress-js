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

const bjsReq = async (opts, token=Config.testToken, floop = false) => {
	const req = await fetch(`${opts.url}?token=${token}`, opts);
	if (req.status !== 200) throw new Error(`Received non-200 (${req.status}) from ${opts.url}`);
	return (floop) ? await req.text() : await req.json();
};
const bjsReqPost = async (url, body, token) => await bjsReq({
	url,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(body),
}, token);

const createApp = async (ENDPOINT, name, apiPath, token) => await bjsReqPost(`${ENDPOINT}/api/v1/app`, {name, apiPath}, token);
const createLambda = async (ENDPOINT, lambda, auth, token) => await bjsReqPost(`${ENDPOINT}/api/v1/lambda`, {lambda, auth}, token);

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

module.exports = {
	bjsReq,
	bjsReqPost,
	createApp,
	createLambda,
	updateSchema,
	updatePolicyPropertyList,
	registerDataSharing,
};
