const fetch = require('cross-fetch');
const Config = require('node-env-obj')();

const bjsReq = async (opts, token=Config.testToken, floop = false) => {
	const req = await fetch(`${opts.url}?token=${token}`, opts);
	if (req.status !== 200) throw new Error(`Received non-200 (${req.status}) from POST ${opts.url}`);
	return (floop) ? await req.text() : await req.json();
};

const createApp = async (ENDPOINT, name, apiPath, token) => await bjsReq({
	url: `${ENDPOINT}/api/v1/app`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify({
		name,
		apiPath,
	}),
}, token);
const createLambda = async (ENDPOINT, lambda, auth, token) => await bjsReq({
	url: `${ENDPOINT}/api/v1/lambda`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify({
		lambda, auth,
	}),
}, token);

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
	createApp,
	createLambda,
	updateSchema,
	updatePolicyPropertyList,
	registerDataSharing,
};
