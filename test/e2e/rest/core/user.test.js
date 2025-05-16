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

import { describe, it, before, after } from 'mocha';
import assert from 'node:assert';

import { createApp, bjsReq, createPolicyUser, deleteApp, BJSReqError, ENDPOINT } from '../../../helpers.js';

import BootstrapRest from '../../../../dist/bootstrap-rest.js';


describe('User API', async () => {
	const testEnv = {
		apps: {},
		users: {},
	};

	let REST_PROCESS = null;

	before(async function () {
		REST_PROCESS = new BootstrapRest();

		await REST_PROCESS.init();

		testEnv.apps.app1 = await createApp(ENDPOINT.REST, 'Test User API', 'test-user-api-1', { someProperty: [ 'value', 'newValue' ] });

		// Create some users
		testEnv.users.user1 = await createPolicyUser(ENDPOINT.REST, testEnv.apps.app1, 'user-test-user1', {});
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
			});

			assert.strictEqual(response, true, 'Response should be true');

			const users = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			});

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
			const query = { email: 'user@example.com' };
			const users = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user`,
				method: 'SEARCH',
				headers: { 'Content-Type': 'application/json' },
				body: { query }
			}, testEnv.apps.app1.token);

			assert.strictEqual(users.length, 1, 'Users length should be 1');
		});
	});

	describe('UserCount', () => {
		it('Should return the count of users', async () => {
			const query = { email: 'user@example.com' };
			const count = await bjsReq({
				url: `${ENDPOINT.REST}/api/v1/user/count`,
				method: 'SEARCH',
				headers: { 'Content-Type': 'application/json' },
				body: { query }
			}, testEnv.apps.app1.token);

			assert.strictEqual(count, 1, 'User count should be 1');
		});
	});
});