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
const updateSchema = async (ENDPOINT, schema, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/app/schema`,
	method: 'PUT',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(schema),
}, token);
const registerDataSharing = async (ENDPOINT, agreement, token) => bjsReq({
	url: `${ENDPOINT}/api/v1/appDataSharing`,
	method: 'POST',
	headers: {'Content-Type': 'application/json'},
	body: JSON.stringify(agreement),
}, token);

module.exports = {
	bjsReq,
	createApp,
	updateSchema,
	registerDataSharing,
};
