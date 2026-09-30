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

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';
import http from 'node:http';

import { createApp, bjsReq, createUser, createPolicyUser, deleteApp, BJSReqError, ENDPOINT } from '../../../helpers.js';
import { runStep } from '../../helpers.js';
import Config from '../../../config.js';

import BootstrapRest from '../../../../dist/bootstrap-rest.js';


describe('User API', async () => {
	const testEnv = {
		apps: {},
		users: {},
	};

	let REST_PROCESS = null;

	before(async function () {
		this.timeout(60000);

		await runStep('init REST process', async () => {
			REST_PROCESS = new BootstrapRest();
			await REST_PROCESS.init();
		}, 'User API setup');

		testEnv.apps.app1 = await runStep('create app1', async () =>
			createApp(ENDPOINT.REST, 'Test User API', 'test-user-api-1', { someProperty: [ 'value', 'newValue' ] })
		, 'User API setup');

		// Create some users
		testEnv.users.user1 = await runStep('create user-test-user1', async () =>
			createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'user-test-user1', {})
		, 'User API setup');
	});

	after(async function () {
		// await deleteApp(ENDPOINT, testEnv.apps.app1.id);

		// Shutdown
		await REST_PROCESS.clean();
	});

	describe('GetUserList', () => {
		it('Should list all users with a system token', async () => {
			const users = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			});

			assert.strictEqual(users.length, 1, 'Users length should be 1');
		});

		it('Should list users for a specific app with an app token', async () => {
			const users = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(users.length, 1, 'Users length should be 1 for the app');
		});
	});

	describe('GetUser', () => {
		it('Should get a user by ID with a system token', async () => {
			const user = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			});

			assert.strictEqual(user.id, testEnv.users.user1.id, 'User ID should match');
		});

		// TODO: need to introduce policy to allow the user to access their own data.
		// it('Should get the current user with \'me\' as ID and an app token', async () => {
		// 	const user = await bjsReq({
		// 		url: `${ENDPOINT}/api/v1/user/me`,
		// 		method: 'GET',
		// 		headers: { 'Content-Type': 'application/json' }
		// 	}, testEnv.users.user1.tokens[0].value);

		// 	assert.strictEqual(user.id, testEnv.apps.app1.userId, 'User ID should match the current user');
		// });
	});

	describe('FindUser', () => {
		it('Should find a user by auth app ID with a app token', async () => {
			const user = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.auth[0].app}/${testEnv.users.user1.auth[0].appId}`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(user.id, testEnv.users.user1.id, 'User ID should match');
		});
	});

	describe('GetUserByToken', () => {
		it('Should get a user by token', async () => {
			const user = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/get-by-token`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: testEnv.users.user1.tokens[0].value })
			});

			assert.strictEqual(user.id, testEnv.users.user1.id, 'Unable to fetch user by token');
		});
	});

	describe('CreateUserAuthToken', () => {
		it('Should create a user auth token', async () => {
			const tokenData = {
				policyProperties: { someProperty: 'value' },
				domains: ['example.com']
			};
			const token = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/token`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(tokenData)
			}, testEnv.apps.app1.token);

			assert.strictEqual(token.policyProperties.someProperty, 'value', 'Token policy property should match');
		});

		it('Should refuse a token whose domains aren\'t all domain names', async () => {
			try {
				await bjsReq({
					url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/token`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ policyProperties: { someProperty: 'value' }, domains: [null] })
				}, testEnv.apps.app1.token);
				throw new Error('Should refuse a null domain');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.strictEqual(error.code, 400, 'Error status code should be 400');
				assert.match(error.message, /invalid_domains/);
			}
		});
	});

	describe('AddUser', () => {
		it('Should add a new user with no token', async () => {
			const userData = {
				auth: [{ app: 'test-app-name', appId: '1', email: 'newuser+1@example.com' }]
			};
			const user = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(userData)
			}, testEnv.apps.app1.token);

			assert.strictEqual(user.auth[0].appId, userData.auth[0].appId, 'User auth appId should match');
			assert.strictEqual(user.auth[0].email, userData.auth[0].email, 'User auth email should match');
			assert.strictEqual(user.tokens.length, 0, 'User should not have any tokens');
		});

		it('Should create a user with a token', async () => {
			const userData = {
				auth: [{ app: 'test-app-name', appId: '2', email: 'newuser+2@example.com' }],
				token: {
					domains: ['example.com'],
					policyProperties: { someProperty: 'value' }
				}
			};
			const user = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(userData)
			}, testEnv.apps.app1.token);

			assert.strictEqual(user.auth[0].appId, userData.auth[0].appId, 'User auth appId should match');
			assert.strictEqual(user.auth[0].email, userData.auth[0].email, 'User auth email should match');
			assert.strictEqual(user.tokens.length, 1, 'User should have one token');
		});

		it('Should refuse a user whose token domains aren\'t all domain names', async () => {
			const userData = {
				auth: [{ app: 'test-app-name', appId: '3', email: 'newuser+3@example.com' }],
				token: {
					domains: [null],
					policyProperties: { someProperty: 'value' }
				}
			};
			try {
				await bjsReq({
					url: `${ENDPOINT.REST}/api/v1/user`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(userData)
				}, testEnv.apps.app1.token);
				throw new Error('Should refuse a null domain');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.strictEqual(error.code, 400, 'Error status code should be 400');
				assert.match(error.message, /invalid_domains/);
			}
		});

		describe('Duplicates', () => {
			const add = (auth) => bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ auth }),
			}, testEnv.apps.app1.token);
			const refused = async (auth) => {
				try {
					await add(auth);
					return false;
				} catch (error) {
					if (!(error instanceof BJSReqError)) throw error;
					assert.match(error.message, /user_already_exists_with_that_name/);
					return true;
				}
			};

			before(async () => {
				await add([
					{ app: 'dup-google', appId: 'dup-g-1', email: 'dup-a@example.com' },
					{ app: 'dup-github', appId: 'dup-h-1', email: 'dup-b@example.com' },
				]);
			});

			it('Should refuse a user whose auth has the app and email, or app and id, of one auth entry of an existing user', async () => {
				assert.strictEqual(await refused([{ app: 'dup-google', appId: 'dup-g-2', email: 'dup-a@example.com' }]), true);
				assert.strictEqual(await refused([{ app: 'dup-github', appId: 'dup-h-1', email: 'dup-new@example.com' }]), true);
			});

			it("Should add a user whose auth matches an existing user's app in one auth entry and email in another", async () => {
				assert.strictEqual(await refused([{ app: 'dup-google', appId: 'dup-g-3', email: 'dup-b@example.com' }]), false);
			});

			it('Should add a user whose auth gives no email, beside an existing user with none', async () => {
				await add([{ app: 'dup-noemail', appId: 'dup-n-1' }]);
				assert.strictEqual(await refused([{ app: 'dup-noemail', appId: 'dup-n-2' }]), false);
			});
		});
	});

	describe('KeepAlive', () => {
		// A request over the agent, resolving with the response and the socket it used. It goes straight to the REST
		// process, rather than to ENDPOINT.REST, which may be a proxy with connections of its own.
		const agentReq = (agent, method, path, token, body) => new Promise((resolve, reject) => {
			const req = http.request(`http://localhost:${Config.listenPorts.rest}${path}`, {
				agent,
				method,
				headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
			}, (res) => {
				let data = '';
				res.on('data', (chunk) => data += chunk);
				res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, socket: req.socket }));
			});
			req.on('error', reject);
			req.end(body ? JSON.stringify(body) : undefined);
		});

		it('Should add a user over the connection a failed user lookup used', async () => {
			const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
			const auth = { app: 'test-keep-alive', appId: 'keep-alive-1', email: 'keep-alive+1@example.com' };

			try {
				// As @buttress/api's findOrCreateUser does for a new user
				const lookup = await agentReq(agent, 'GET', `/api/v1/user/${auth.app}/${auth.appId}`, testEnv.apps.app1.token);
				assert.strictEqual(lookup.status, 404, 'The user lookup should 404');
				assert.notStrictEqual(lookup.headers.connection, 'close', 'The 404 should keep the connection open');

				// Give the server time to act on the finished request, so a socket it closes is seen as closed
				await new Promise((resolve) => setTimeout(resolve, 50));

				const added = await agentReq(agent, 'POST', '/api/v1/user', testEnv.apps.app1.token, { auth: [auth] });
				assert.strictEqual(added.status, 200, 'The user should be added');
				assert.strictEqual(JSON.parse(added.body).auth[0].appId, auth.appId, 'User auth appId should match');
				assert.strictEqual(added.socket, lookup.socket, 'The add should reuse the connection of the lookup');
			} finally {
				agent.destroy();
			}
		});
	});

	describe('UpdateUser', () => {
		it('Should update a user', async () => {
			const data = {
				path: 'auth.0.email',
				value: 'updateduser@example.com'
			};
			const [update] = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}`,
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify([data])
			}, testEnv.apps.app1.token);

			assert.strictEqual(update.type, 'scalar', 'Update type should be scalar');
			assert.strictEqual(update.path, data.path, `Updated path should be ${data.path}`);
			assert.strictEqual(update.value, data.value, `Update value should be ${data.value}`);
		});
	});

	describe('SetUserPolicyProperties', () => {
		it('Should set user policy properties', async () => {
			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/policy-property/${testEnv.users.user1.tokens[0].id}`,
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ someProperty: 'value' })
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, 'Response should be true');
		});

		it('Should not set user policy properties if the policy property doesn\'t exist', async () => {
			try {
				await bjsReq({
					url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/policy-property/${testEnv.users.user1.tokens[0].id}`,
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ someProperty: 'randomValue' })
				}, testEnv.apps.app1.token);
				throw new Error('Should not update the policy properties if the policy property doesn\'t exist');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.strictEqual(error.code, 400, 'Error status code should be 400');
			}
		});
	});

	describe('UpdateUserPolicyProperties', () => {
		it('Should update user policy properties', async () => {
			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/update-policy-property/${testEnv.users.user1.tokens[0].id}`,
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ someProperty: 'newValue' })
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, 'Response should be true');
		});

		it('Should not update the policy properties if the policy property doesn\'t exist', async () => {
			try {
				await bjsReq({
					url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/update-policy-property/${testEnv.users.user1.tokens[0].id}`,
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ someProperty: 'randomValue' })
				}, testEnv.apps.app1.token);
				throw new Error('Should not update the policy properties if the policy property doesn\'t exist');
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.strictEqual(error.code, 400, 'Error status code should be 400');
			}
		});
	});

	describe('RemoveUserPolicyProperties', () => {
		it('Should remove user policy properties', async () => {
			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/remove-policy-property/${testEnv.users.user1.tokens[0].id}`,
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ someProperty: 'newValue' })
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, 'Response should be true');
		});
	});

	describe('ClearUserPolicyProperties', () => {
		it('Should clear user policy properties', async () => {
			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user1.id}/clear-policy-property/${testEnv.users.user1.tokens[0].id}`,
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, 'Response should be true');
		});
	});

	describe('DeleteAllUsers', () => {
		it('Should delete all users', async () => {
			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, 'Response should be true');

			const users = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(users.length, 0, 'Users length should be 0 after deletion');
		});
	});

	describe('DeleteUser', () => {
		it('Should delete a user', async () => {
			// Add in a new user to be deleted.
			testEnv.users.user2 = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'user-test-user2', {});

			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user2.id}`,
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, 'Response should be true');

			try {
				await bjsReq({
					url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user2.id}`,
					method: 'GET',
					headers: { 'Content-Type': 'application/json' }
				}, testEnv.apps.app1.token);
			} catch (error) {
				if (!(error instanceof BJSReqError)) throw error;

				assert.strictEqual(error.code, 404, 'Error status code should be 404');
			}
		});
	});

	describe('clearUserLocalData', () => {
		it('Should clear user local data', async () => {
			testEnv.users.user3 = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'user-test-user3', {});

			const response = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/${testEnv.users.user3.id}/clear-local-data`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			}, testEnv.apps.app1.token);

			assert.strictEqual(response, true, 'Response should be true');
		});
	});

	describe('SearchUserList', () => {
		it('Should search and return a list of users', async () => {
			testEnv.users.user4 = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'user-test-user4', {});

			const query = { 'auth.email': testEnv.users.user4.auth[0].email };
			const users = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'SEARCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query })
			}, testEnv.apps.app1.token);

			assert.strictEqual(users.length, 1, 'Users length should be 1');
		});
	});

	describe('UserCount', () => {
		it('Should return the count of users', async () => {
			const query = { 'auth.email': testEnv.users.user4.auth[0].email };
			const count = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/count`,
				method: 'SEARCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query })
			}, testEnv.apps.app1.token);

			assert.strictEqual(count, 1, 'User count should be 1');
		});
	});
});