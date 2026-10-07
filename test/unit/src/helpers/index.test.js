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

import { ObjectId } from 'bson';
import { describe, it } from 'mocha';
import assert from 'assert';

import * as Helpers from '../../../../dist/helpers/index.js';
import FilterInstance from '../../../../dist/access-control/filter.js';

const Filter = FilterInstance;

describe('helpers.compareByProps', () => {
	it('should handle one of the values being undefined', () => {
		const a = { name: 'Alex', age: 10 };
		const b = { name: 'Jordan', age: undefined };
		assert.strictEqual(Helpers.compareByProps(new Map([['age', 1]]), a, b), 1);
	});

	it('should return 1 if a is greater than be when sorting by age', () => {
		const a = { name: 'Alex', age: 10 };
		const b = { name: 'Jordan', age: 5 };
		assert.strictEqual(Helpers.compareByProps(new Map([['age', 1]]), a, b), 1);
	});

	it('should return 0 if a is equal to be when sorting by age', () => {
		const a = { name: 'Alex', age: 10 };
		const b = { name: 'Jordan', age: 10 };
		assert.strictEqual(Helpers.compareByProps(new Map([['age', 1]]), a, b), 0);
	});

	it('should return 1 if a is greater than be when sorting by age desc', () => {
		const a = { name: 'Alex', age: 10 };
		const b = { name: 'Jordan', age: 5 };
		assert.strictEqual(Helpers.compareByProps(new Map([['age', -1]]), a, b), -1);
	});

	it('should order by ObjectId rather than treating them as tied', () => {
		const lower = new ObjectId('000000000000000000000001');
		const higher = new ObjectId('000000000000000000000002');
		const a = { id: higher };
		const b = { id: lower };
		assert.strictEqual(Helpers.compareByProps(new Map([['id', 1]]), a, b), 1);
		assert.strictEqual(Helpers.compareByProps(new Map([['id', 1]]), b, a), -1);
		assert.strictEqual(Helpers.compareByProps(new Map([['id', 1]]), a, a), 0);
	});
});

describe('helpers.checkAppPolicyProperty', () => {
	it('should pass when the submitted numeric value is exactly in the allow-list', async () => {
		const result = await Helpers.checkAppPolicyProperty({ level: [5, 10, 15] }, { level: 10 });
		assert.strictEqual(result.passed, true);
	});

	it('should fail when the submitted numeric value is not in the allow-list', async () => {
		// 7 isn't one of the allowed values - regression check for the `<` vs `!==` bug.
		const result = await Helpers.checkAppPolicyProperty({ level: [5, 10, 15] }, { level: 7 });
		assert.strictEqual(result.passed, false);
	});

	it('should fail when the submitted numeric value is higher than every allowed value', async () => {
		const result = await Helpers.checkAppPolicyProperty({ level: [5, 10, 15] }, { level: 20 });
		assert.strictEqual(result.passed, false);
	});

	it("refuses a value of another type than the app's listed values, rather than failing", async () => {
		for (const properties of [{ role: 5 }, { role: { '@eq': 5 } }, { role: { '@eq': { nested: 'admin' } } }]) {
			const result = await Helpers.checkAppPolicyProperty({ role: ['admin', 'user'] }, properties);
			assert.strictEqual(result.passed, false, JSON.stringify(properties));
		}
	});

	it('takes an array of values when every one of them is listed', async () => {
		const list = { role: ['admin', 'user'] };

		assert.strictEqual((await Helpers.checkAppPolicyProperty(list, { role: { '@in': ['admin', 'user'] } })).passed, true);
		assert.strictEqual((await Helpers.checkAppPolicyProperty(list, { role: { '@in': ['admin', 'other'] } })).passed, false);
	});

	// D-34: a token can only be given the values the app lists, as they're listed
	it('refuses text listed in another case', async () => {
		const list = { role: ['admin', 'user'] };

		assert.strictEqual((await Helpers.checkAppPolicyProperty(list, { role: 'ADMIN' })).passed, false);
		assert.strictEqual((await Helpers.checkAppPolicyProperty(list, { role: { '@in': ['ADMIN', 'user'] } })).passed, false);
	});
});

describe('helpers.checkAppPolicyProperty, SR-DPC-001 S5', () => {
	const list = { role: ['admin'] };
	const check = async (properties) => (await Helpers.checkAppPolicyProperty(list, properties)).passed;

	it('checks every value of an array given as the value', async () => {
		assert.strictEqual(await check({ role: ['admin'] }), true);
		assert.strictEqual(await check({ role: ['admin', 'superadmin'] }), false);
		assert.strictEqual(await check({ role: [] }), false);
	});

	it('checks the values of every operator an operator object names', async () => {
		assert.strictEqual(await check({ role: { '@eq': 'admin', '@in': ['admin'] } }), true);
		assert.strictEqual(await check({ role: { '@eq': 'admin', '@in': ['superadmin'] } }), false);
		assert.strictEqual(await check({ role: {} }), false);
	});

	it('refuses a null value rather than failing', async () => {
		assert.strictEqual(await check({ role: null }), false);
		assert.strictEqual(await check({ role: { '@eq': null } }), false);
	});
});

describe('helpers.checkPolicySelection', () => {
	const list = { role: ['admin', 'user'], team: ['a', 'b'] };
	const check = async (selection) => (await Helpers.checkPolicySelection(list, selection)).passed;

	it('takes keys the app lists, with values it lists', async () => {
		assert.strictEqual(await check({ role: { '@eq': 'admin' }, team: { '@in': ['a', 'b'] } }), true);
		assert.strictEqual(await check({ role: { '@eq': 'owner' } }), false);
		assert.strictEqual(await check({ level: { '@eq': 1 } }), false);
	});

	it('takes @and and @or, each a list of selections the app lists', async () => {
		assert.strictEqual(await check({ '@or': [{ role: { '@eq': 'admin' } }, { team: { '@eq': 'a' } }] }), true);
		assert.strictEqual(
			await check({ role: { '@eq': 'user' }, '@and': [{ team: { '@eq': 'a' } }, { '@or': [{ role: { '@eq': 'admin' } }] }] }),
			true,
		);
	});

	it('refuses a key or value the app does not list within @and or @or', async () => {
		assert.strictEqual(await check({ '@or': [{ role: { '@eq': 'admin' } }, { level: { '@eq': 1 } }] }), false);
		assert.strictEqual(await check({ '@and': [{ '@or': [{ team: { '@eq': 'c' } }] }] }), false);
	});

	it('refuses an @and or @or that is not a list of selections, or is empty', async () => {
		for (const selection of [
			{ '@or': [] },
			{ '@and': [] },
			{ '@or': { role: { '@eq': 'admin' } } },
			{ '@or': [{}] },
			{ '@or': ['admin'] },
		]) {
			assert.strictEqual(await check(selection), false, JSON.stringify(selection));
		}
	});

	it('refuses a criterion naming an operator nothing knows, even for a listed value', async () => {
		assert.strictEqual(await check({ role: { '@like': 'admin' } }), false);
		assert.strictEqual(await check({ '@or': [{ role: { '@eq': 'admin' } }, { team: { $foo: 'a' } }] }), false);
		assert.strictEqual(await check({ role: { $eq: 'admin' }, team: { '@in': ['a', 'b'] } }), true);
	});

	it('takes a selection with no keys, as before, which selects nothing', async () => {
		assert.strictEqual(await check({}), true);
	});
});

describe('helpers.flattenedObject', () => {
	it ('should return a flattened object', () => {
		const invitation = {
			"_id" : new ObjectId("6a2ac4c20a35c2d9335147cf"),
			"status" : "ACCEPTED",
			"type" : "COMPANY",
			"invitationToken" : "hpU4ZhZhwtcEBNswUYhEE9pBEsFdkY00FhVA",
			"registrationCode" : "100000",
			"inviter" : {
					"personId" : new ObjectId("6a2ac46a7ac94a35fa8d7eff"),
					"email" : "no-reply@nodestream.co.uk",
					"companyId" : new ObjectId("69ba66495f8f479e3aec78d0")
			},
			"invitee" : {
					"personId" : new ObjectId("6a2ac4f8b23f0ed12a2864fe"),
					"name" : "Mahmoud Abou",
					"jobTitle" : "Engineer",
					"canInvite" : false,
					"email" : "mahmoud@wearelighten.co.uk",
					"company" : {
							"id" : new ObjectId("6a2ac530d902777c360a8b4c"),
							"registrarIdentifier" : "07025392",
							"name" : "Data People Connected Limited"
					}
			},
			"sendAsUser" : false,
			"stageNumber" : 6,
			"expiryDate" : new Date("2026-06-12T14:22:58.520Z"),
			"sourceId" : null,
			"createdAt" : new Date("2026-06-11T14:22:58.561Z"),
			"updatedAt" : new Date("2026-06-11T14:24:48.953Z")
		};

		const firstFlattenedObj = Helpers.flattenedObject(invitation);

		const email = {
			"_id" : new ObjectId("6a2ac4e92306d55c9f192950"),
			"assimilated" : false,
			"parentId" : null,
			"threadId" : new ObjectId("6a2ac4e92306d55c9f19294f"),
			"from" : "no-reply@nodestream.co.uk",
			"to" : [
				"mahmoud@wearelighten.co.uk"
			],
			"headers" : [
				{
					"key" : "From",
					"value" : "no-reply@nodestream.co.uk"
				},
				{
					"key" : "To",
					"value" : "mahmoud@wearelighten.co.uk"
				}
			],
			"data" : [
				{
					"key" : "code",
					"value" : [{
						"text": ["100000"]
					}]
				},
				{
					"key" : "footerImageLink",
					"value" : [{
						"text": ["https://staging.nodestream.co.uk/images/ns-email-footer.gif"]
					}]
				}
			],
			"attachment" : {
				"driveIds" : [],
				"type" : null
			},
			"template" : "emails/auth-email-code",
			"subject" : "Your access code: 100000",
			"status" : "OUTBOUND",
			"dispatch" : {
				"status" : "SENT",
				"sendAsSystem" : true,
				"dispatchAfter" : new Date("2026-06-11T14:23:37.494Z"),
				"dispatchedAt" : new Date("2026-06-11T14:23:43.514Z"),
				"attempt" : {
					"count" : 0,
					"lastAttemptAt" : null
				}
			},
			"provider" : {
				"name" : "GOOGLE",
				"subject" : null,
				"personId" : null,
				"id" : [
					"19eb711471641e31"
				],
				"threadId" : [
					"19eb711471641e31"
				],
				"messageId" : null,
				"inReplyTo" : null
			},
			"sourceId" : null,
			"createdAt" : new Date("2026-06-11T14:23:37.518Z"),
			"updatedAt" : new Date("2026-06-11T14:23:43.533Z")
		}

		const secondFlattenedObj = Helpers.flattenedObject(email);

		const firstObjCheck = Object.values(firstFlattenedObj).reduce((passed, value) => {
			if (value instanceof Date || ObjectId.isValid(value)) return passed;

			if (value && typeof value === 'object' && Array.isArray(value) && value.length > 0) passed = false;
			if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) passed = false;

			return passed;
		}, true);
		const secondObjCheck = Object.values(secondFlattenedObj).reduce((passed, value) => {
			if (value instanceof Date || ObjectId.isValid(value)) return passed;

			if (value && typeof value === 'object' && Array.isArray(value) && value.length > 0) passed = false;
			if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) passed = false;

			return passed;
		}, true);

		assert.strictEqual(firstObjCheck, true, 'First object is not completely flattened');
		assert.strictEqual(secondObjCheck, true, 'Second object is not completely flattened');
	});

	it ('should return a two items in the array', () => {
		const email = {
			"_id" : new ObjectId("6a2ac4e92306d55c9f192950"),
			"assimilated" : false,
			"parentId" : null,
			"threadId" : new ObjectId("6a2ac4e92306d55c9f19294f"),
			"from" : "no-reply@nodestream.co.uk",
			"to" : [
				"mahmoud@wearelighten.co.uk"
			],
			"headers" : [
				{
					"key" : "From",
					"value" : "no-reply@nodestream.co.uk"
				},
				{
					"key" : "To",
					"value" : "mahmoud@wearelighten.co.uk"
				}
			],
			"data" : [
				{
					"key" : "code",
					"value" : [{
						"text": ["100000"]
					}]
				},
				{
					"key" : "footerImageLink",
					"value" : [{
						"text": ["https://staging.nodestream.co.uk/images/ns-email-footer.gif"]
					}]
				}
			],
			"attachment" : {
				"driveIds" : [],
				"type" : null
			},
			"template" : "emails/auth-email-code",
			"subject" : "Your access code: 100000",
			"status" : "OUTBOUND",
			"dispatch" : {
				"status" : "SENT",
				"sendAsSystem" : true,
				"dispatchAfter" : new Date("2026-06-11T14:23:37.494Z"),
				"dispatchedAt" : new Date("2026-06-11T14:23:43.514Z"),
				"attempt" : {
					"count" : 0,
					"lastAttemptAt" : null
				}
			},
			"provider" : {
				"name" : "GOOGLE",
				"subject" : null,
				"personId" : null,
				"id" : [
					"19eb711471641e31"
				],
				"threadId" : [
					"19eb711471641e31"
				],
				"messageId" : null,
				"inReplyTo" : null
			},
			"sourceId" : null,
			"createdAt" : new Date("2026-06-11T14:23:37.518Z"),
			"updatedAt" : new Date("2026-06-11T14:23:43.533Z")
		}

		const secondFlattenedObj = Helpers.flattenedObject(email);
		// Each item of an array has a key of its own, so both texts are there
		const texts = Object.keys(secondFlattenedObj).filter((key) => key.replace(/\.\d+/g, '') === 'data.value.text');
		assert.strictEqual(texts.length, 2);
	});
});

describe('helpers.serverTimingHeader', () => {
	it('should report each stage and the time until the response, in milliseconds', () => {
		const timings = {
			authenticateToken: 0,
			accessControl: 0.001,
			configCrossDomain: 0.003,
			authenticate: 0.0031,
			validate: 0.0032,
			exec: 0.004,
			respond: 0.0105,
			logActivity: null,
			stream: [],
		};

		assert.strictEqual(
			Helpers.serverTimingHeader(timings),
			'auth;dur=1.000;desc="token", ac;dur=2.000;desc="access control", validate;dur=0.800, exec;dur=6.500, ' +
				'total;dur=10.500;desc="until response"',
		);
	});

	it('should leave out stages missing a mark, e.g. when a request fails before validation', () => {
		const timings = { authenticateToken: 0, accessControl: 0.001, configCrossDomain: 0.002, validate: null };

		assert.strictEqual(
			Helpers.serverTimingHeader(timings),
			'auth;dur=1.000;desc="token", ac;dur=1.000;desc="access control"',
		);
	});

	it('should return an empty string when there are no marks', () => {
		assert.strictEqual(Helpers.serverTimingHeader({ stream: [] }), '');
	});
});

describe('helpers.getThrownErrorDetails', () => {
	it('should extract message only from a plain Error', () => {
		const details = Helpers.getThrownErrorDetails(new Error('plain failure'));
		assert.strictEqual(details.message, 'plain failure');
		assert.strictEqual(details.code, undefined);
		assert.strictEqual(details.httpStatus, undefined);
		assert.strictEqual(details.retryable, undefined);
		assert.strictEqual(details.errors, undefined);
	});

	it('should extract code, httpStatus, retryable and errors from an UpstreamApiError', () => {
		const errors = [{ code: 'FIELD_A', message: 'bad field A' }];
		const err = new Helpers.Errors.UpstreamApiError('Multiple errors', 'BAD_REQUEST', 400, { retryable: false, errors });
		const details = Helpers.getThrownErrorDetails(err);
		assert.strictEqual(details.message, 'Multiple errors');
		assert.strictEqual(details.code, 'BAD_REQUEST');
		assert.strictEqual(details.httpStatus, 400);
		assert.strictEqual(details.retryable, false);
		assert.deepStrictEqual(details.errors, errors);
	});

	it('should ignore a numeric code (e.g. from CodedError) rather than misreport it as a string', () => {
		const details = Helpers.getThrownErrorDetails(new Helpers.Errors.CodedError('Lambda error', 500));
		assert.strictEqual(details.message, 'Lambda error');
		assert.strictEqual(details.code, undefined);
	});

	it('should extract fields stashed on a plain object (e.g. lambda.setResult({err:true, ...}))', () => {
		const details = Helpers.getThrownErrorDetails({
			errMessage: 'set-result failure',
			code: 'SOME_CODE',
			httpStatus: 503,
			retryable: true,
		});
		assert.strictEqual(details.message, 'set-result failure');
		assert.strictEqual(details.code, 'SOME_CODE');
		assert.strictEqual(details.httpStatus, 503);
		assert.strictEqual(details.retryable, true);
	});
});
