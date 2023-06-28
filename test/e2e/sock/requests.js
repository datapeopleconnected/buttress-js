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

const { io } = require('socket.io-client');
const {describe, it, before, after} = require('mocha');

const BootstrapRest = require('../../../dist/bootstrap-rest');
const BootstrapSocket = require('../../../dist/bootstrap-socket');

const ENDPOINT = `https://test.local.buttressjs.com`;

let REST_PROCESS = null;
let SOCK_PROCESS = null;

const testEnv = {

};

// This suite of tests will run against the REST API and will
// test the cababiliy of data sharing between different apps.
describe('Requests', async () => {
	before(async function() {
		this.timeout(20000);
		REST_PROCESS = new BootstrapRest();
		await REST_PROCESS.init();

		SOCK_PROCESS = new BootstrapSocket();
		await SOCK_PROCESS.init();
	});

	after(async function() {
		await REST_PROCESS.clean();
		await SOCK_PROCESS.clean();
	});

	describe('Connections', () => {
		it('Should be able to connect to Buttress using socket.io', function(done) {
			this.timeout(999999999);
			// client-side
			const socket = io(`ENDPOINT`);
			console.log(socket.connected);

			socket.on('connect', () => {
				console.log('FOO');
				console.log(socket.id); // x8WIv7-mJelg7on_ALbx
				done();
			});
			socket.on('close', (reason) => {
				console.log(reason);
				// called when the underlying connection is closed
			});
		});
	});

	describe('Realtime data', async () => {
		it('Should make a POST request to buttress and see a realtime activity generated', async () => {
			// const response = await fetch(`${ENDPOINT}/api/v1/requests?token=`, {
			// 	method: 'POST',
			// 	headers: {
			// 		'Content-Type': 'application/json',
			// 	},
			// 	body: JSON.stringify({
			// 		'foo': 'bar'
			// 	})
			// });

			// const json = await response.json();

			// assert.equal(response.status, 200);
			// assert.equal(json.success, true);
			// assert.equal(json.data.foo, 'bar');
		});
	});
});
