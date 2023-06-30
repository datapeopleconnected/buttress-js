/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

const {io} = require('socket.io-client');
const {describe, it, before, after} = require('mocha');
const assert = require('assert');
const fetch = require('cross-fetch');

const Config = require('node-env-obj')();

const {createApp, updateSchema, bjsReq} = require('../../helpers');

const BootstrapRest = require('../../../dist/bootstrap-rest');
const BootstrapSocket = require('../../../dist/bootstrap-socket');

const ENDPOINT = `https://test.local.buttressjs.com`;

let REST_PROCESS = null;
let SOCK_PROCESS = null;

const testEnv = {
	apps: {},
	socket: null,
};

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Realtime', async () => {
	before(async function() {
		this.timeout(20000);
		REST_PROCESS = new BootstrapRest();
		await REST_PROCESS.init();

		SOCK_PROCESS = new BootstrapSocket();
		await SOCK_PROCESS.init();

		// Creating test data.
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

		// Create an app
		testEnv.apps.app1 = await createApp(ENDPOINT, 'Test SOCK 1', 'test-sock-1');
		testEnv.apps.app1.schema = await updateSchema(ENDPOINT, [carsSchema], testEnv.apps.app1.token);

		// Add a 'few' cars
		await bjsReq({
			url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car/bulk/add`,
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(new Array(5000).fill(0).map(() => ({name: `name-${Math.floor(Math.random()*100)}`}))),
		}, testEnv.apps.app1.token);
	});

	after(async function() {
		if (testEnv.socket) testEnv.socket.disconnect();
		await REST_PROCESS.clean();
		await SOCK_PROCESS.clean();
	});

	describe('Connections', () => {
		let socket = null;
		it('Should be able to connect to Buttress using socket.io', function(done) {
			socket = io(ENDPOINT);

			socket.once('connect', () => {
				assert.equal(socket.connected, true);
				done();
			});
		});

		it('Should close down the socket.io connection', function(done) {
			socket.once('disconnect', () => {
				assert.equal(socket.id, undefined);
				done();
			});

			socket.disconnect();
		});
	});

	describe('db-activity', async () => {
		it('Should be able to connect to Buttress using the app token', function(done) {
			testEnv.socket = io(`${ENDPOINT}/${testEnv.apps.app1.apiPath}?token=${testEnv.apps.app1.token}`);

			testEnv.socket.once('connect', () => {
				assert.equal(testEnv.socket.connected, true);
				done();
			});
		});

		it('Should make a POST request to buttress and see a realtime activity generated', async () => {
			const name = `name-${Math.floor(Math.random()*100)}`;
			let cars = null;
			const listener = new Promise((resolve) => {
				testEnv.socket.once('db-activity', (ev) => {
					assert.equal(typeof ev.data, 'object');
					assert.equal(ev.data.verb, 'post');
					assert.equal(ev.data.schemaName, 'car');
					assert.equal(ev.data.response.name, name);
					assert.equal(typeof ev.data.response.id, 'string');
					assert.equal(cars[0].id, ev.data.response.id);
					assert.equal(typeof ev.sequence, 'number');
					resolve();
				});
			});

			cars = await bjsReq({
				url: `${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car`,
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({name}),
			}, testEnv.apps.app1.token);

			assert.equal(cars.length, 1);
			assert.equal(cars[0].name, name);

			await listener;
		});

		// TODO: event clear-local-db
		// TODO: event db-connect-room
		// TODO: event db-disconnect-room
	});

	describe('Rooms', async () => {
		// TODO: Super token
		// TODO: App Token
		// TODO: Policy driven rooms
	});

	// This set of tests will test the functionality of tracking the state of a request.
	describe('bjs-requests', async () => {
		let requestId = null;
		it('Should make a request to /cars, responce should contain a x-bjs-request-id header', async () => {
			const req = await fetch(`${ENDPOINT}/${testEnv.apps.app1.apiPath}/api/v1/car?token=${Config.testToken}`);
			if (req.status !== 200) throw new Error(`Received non-200 (${req.status}) from POST ${ENDPOINT}`);
			requestId = req.headers.get('x-bjs-request-id');
			assert(requestId);

			// TEMP - Tests will fail because buttress trys to shutdown before request is closed.
			await req.json();
		});

		// Request Made -> Request ID returned in Headers
		// ...
		// User sends Request ID to server -> User is subscribed to request room
		// ...
		// Data is sent through about the state of the stream
		// ...
		// Room is cleared after request sends EOL or timeout
		// ...
		// User knows when request is finished so room won't be available.
		// ...
		// Might be better to have some way of piping the data directly to the user.
	});
});
