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
		const value = Filter.__getValueByPath(secondFlattenedObj, 'data.value.text');
		assert.strictEqual(value.length, 2);
	});
});
