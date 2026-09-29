/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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


import { io } from 'socket.io-client';
import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';

import { bjsReq, createApp, updateSchema, registerDataSharing, ENDPOINT } from '../../helpers.js';
import { runStep, getFreePort, startSocketProcess, stopSocketProcess } from '../helpers.js';

import BootstrapSPR from '../../../dist/bootstrap-spr.js';
import BootstrapRest from '../../../dist/bootstrap-rest.js';
import NRP from '../../../dist/services/nrp.js';

import Config from '../../config.js';

let REST_PROCESS = null;
let SPR_PROCESS = null;
let NRP_INSTANCE = null;

const testEnv = {
	apps: {},
	agreements: {},
	sockProcess: null,
	sockets: {},
};

const connectSocket = async (url, app) => {
	const socket = io(`${url}/${app.apiPath}`, {
		auth: {
			token: app.token,
		},
		forceNew: true,
	});
	await new Promise((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('connect_error', reject);
	});
	return socket;
};

const postCar = async (app, name) => {
	const [car] = await bjsReq({
		url: `${ENDPOINT.REST}/${app.apiPath}/api/v1/car`,
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	}, app.token);
	return car;
};

// Realtime data sharing: an activity on an app is forwarded by the primary Socket instance over its data share
// connections to the remote app, whose Socket process puts it back on `rest:activity` as the remote app's. The
// primary's data share connections live in its main process, so this runs it with workers, as in production, rather
// than in this process.
describe('Realtime Data Sharing', async () => {
	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, 'Realtime Data Sharing setup');

		await runStep('init SPR process', async () => {
			SPR_PROCESS = new BootstrapSPR();
			await SPR_PROCESS.init();
		}, 'Realtime Data Sharing setup');

		await runStep('connect NRP', async () => {
			NRP_INSTANCE = new NRP(Config.redis);
			await NRP_INSTANCE.connect();
		}, 'Realtime Data Sharing setup');

		const port = await getFreePort();
		const ws = `http://localhost:${port}`;

		const carsSchema = {
			name: 'car',
			type: 'collection',
			properties: {
				name: {
					__type: 'string',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
			},
		};

		testEnv.apps.app1 = await runStep('create app1', async () =>
			createApp(ENDPOINT.REST, 'Test DS SOCK 1', 'test-ds-sock-1')
		, 'Realtime Data Sharing setup');
		await runStep('update app1 schema', async () =>
			updateSchema(ENDPOINT.REST, [carsSchema], testEnv.apps.app1.token)
		, 'Realtime Data Sharing setup');

		testEnv.apps.app2 = await runStep('create app2', async () =>
			createApp(ENDPOINT.REST, 'Test DS SOCK 2', 'test-ds-sock-2')
		, 'Realtime Data Sharing setup');

		const policyConfig = [{
			verbs: ['%ALL%'],
			schema: ['%ALL%'],
			query: {
				access: '%FULL_ACCESS%',
			},
		}];

		testEnv.agreements.app1ToApp2 = await runStep('register DSA app1->app2', async () =>
			registerDataSharing(ENDPOINT.REST, {
				name: 'ds-sock-app1-to-app2',
				remoteApp: {
					endpoint: ENDPOINT.REST,
					ws,
					apiPath: testEnv.apps.app2.apiPath,
					token: null,
				},
				policyConfig,
			}, testEnv.apps.app1.token)
		, 'Realtime Data Sharing setup');

		testEnv.agreements.app2ToApp1 = await runStep('register DSA app2->app1', async () =>
			registerDataSharing(ENDPOINT.REST, {
				name: 'ds-sock-app2-to-app1',
				remoteApp: {
					endpoint: ENDPOINT.REST,
					ws,
					apiPath: testEnv.apps.app1.apiPath,
					token: testEnv.agreements.app1ToApp2.registrationToken,
				},
				policyConfig,
			}, testEnv.apps.app2.token)
		, 'Realtime Data Sharing setup');
		assert.strictEqual(testEnv.agreements.app2ToApp1.active, true);

		await runStep('update app2 schema to use app1 cars', async () =>
			updateSchema(ENDPOINT.REST, [{
				name: 'car',
				type: 'collection',
				remotes: [{
					name: 'ds-sock-app2-to-app1',
					schema: 'car',
				}],
			}], testEnv.apps.app2.token)
		, 'Realtime Data Sharing setup');

		// The agreements are active before the Socket process starts, so its main process opens their connections as
		// it starts up.
		testEnv.sockProcess = await runStep('start primary SOCK process with 2 workers', async () =>
			startSocketProcess({ workers: 2, app: 'primary', port })
		, 'Realtime Data Sharing setup');

		// app1's activity only reaches the Socket processes when one of its tokens is connected.
		testEnv.sockets.app1 = await runStep('connect app1 socket', async () =>
			connectSocket(testEnv.sockProcess.url, testEnv.apps.app1)
		, 'Realtime Data Sharing setup');
	});

	after(async function () {
		this.timeout(20000);
		Object.values(testEnv.sockets).forEach((socket) => socket.close());
		if (testEnv.sockProcess) await stopSocketProcess(testEnv.sockProcess.child);
		if (REST_PROCESS) await REST_PROCESS.clean();
		if (SPR_PROCESS) await SPR_PROCESS.clean();
		if (NRP_INSTANCE) await NRP_INSTANCE.quit();
	});

	it("Should forward an app's activity to the app it shares data with, when the primary has workers", async function () {
		this.timeout(20000);

		const received = [];
		const unsubscribe = await NRP_INSTANCE.subscribe('rest:activity', (raw) => {
			const activity = JSON.parse(raw);
			if (activity.appId === testEnv.apps.app2.id) received.push(activity);
		});

		try {
			// The data share connections open in the background once the Socket process is up, so post until one arrives.
			let car = null;
			let forwarded = null;
			for (let attempt = 0; attempt < 10 && !forwarded; attempt++) {
				car = await postCar(testEnv.apps.app1, `data-share-${attempt}`);

				const deadline = Date.now() + 1000;
				while (Date.now() < deadline && !forwarded) {
					forwarded = received.find((activity) => activity.response?.id === car.id);
					if (!forwarded) await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}

			assert(forwarded, `app1's activity wasn't forwarded to app2 (app2 got ${received.length} activities)`);
			assert.strictEqual(forwarded.appAPIPath, testEnv.apps.app2.apiPath);
			assert.strictEqual(forwarded.schemaName, 'car');
			assert.strictEqual(forwarded.verb, 'post');
			// Set by the receiving side, so the activity isn't forwarded back.
			assert.strictEqual(forwarded.isSameApp, false);
			assert.strictEqual(forwarded.response.name, car.name);
		} finally {
			await unsubscribe();
		}
	});
});
