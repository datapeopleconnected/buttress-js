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
