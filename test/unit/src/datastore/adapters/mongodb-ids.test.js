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
import { describe, it, beforeEach } from 'mocha';
import assert from 'assert';

import MongodbIds from '../../../../../dist/datastore/adapters/mongodb-ids.js';

// The converter produces the driver's ObjectIds, a different class to this file's (bson's ESM build)
const isOid = (value) => value?._bsontype === 'ObjectId';

const HEX_A = '507f1f77bcf86cd799439011';
const HEX_B = '507f191e810c19729de860ea';

// A schema's properties, with ids at the top level, in a nested object, in an array's item schema and as an array
const properties = {
	name: { __type: 'string' },
	_appId: { __type: 'id' },
	owner: { userId: { __type: 'id' }, label: { __type: 'string' } },
	auth: { __type: 'array', __schema: { appId: { __type: 'id' }, email: { __type: 'string' } } },
	tagIds: { __type: 'array', __itemtype: 'id' },
};

describe('datastore/adapters/MongodbIds', () => {
	let ids;
	beforeEach(() => {
		ids = new MongodbIds();
		ids.setSchema(properties);
	});

	describe('isIdPath', () => {
		it('matches id properties, ignoring array indexes and operators', () => {
			assert.strictEqual(ids.isIdPath('_appId'), true);
			assert.strictEqual(ids.isIdPath('owner.userId'), true);
			assert.strictEqual(ids.isIdPath('auth.0.appId'), true);
			assert.strictEqual(ids.isIdPath('$set.auth.2.appId'), true);
			assert.strictEqual(ids.isIdPath('tagIds.$in'), true);
			assert.strictEqual(ids.isIdPath('id'), true);
			assert.strictEqual(ids.isIdPath('_id'), true);
		});

		it("doesn't match other properties", () => {
			assert.strictEqual(ids.isIdPath('name'), false);
			assert.strictEqual(ids.isIdPath('owner.label'), false);
			assert.strictEqual(ids.isIdPath('auth.0.email'), false);
			assert.strictEqual(ids.isIdPath('owner.id'), false);
		});

		it('reads the flattened form of an array item schema', () => {
			ids.setSchema({ config: { __type: 'array', __schema: { 'query.ownerId': { __type: 'id' } } } });
			assert.strictEqual(ids.isIdPath('config.1.query.ownerId'), true);
		});
	});

	describe('toStored', () => {
		it('converts ids in a document and moves id to _id', () => {
			const stored = ids.toStored({
				id: HEX_A,
				name: HEX_B,
				_appId: HEX_B,
				owner: { userId: HEX_A, label: 'x' },
				auth: [{ appId: HEX_B, email: 'a@b.c' }],
				tagIds: [HEX_A, HEX_B],
			});

			assert.ok(isOid(stored._id) && stored._id.toHexString() === HEX_A);
			assert.strictEqual(stored.id, undefined);
			assert.strictEqual(stored.name, HEX_B);
			assert.ok(isOid(stored._appId));
			assert.ok(isOid(stored.owner.userId));
			assert.strictEqual(stored.owner.label, 'x');
			assert.ok(isOid(stored.auth[0].appId));
			assert.ok(stored.tagIds.every(isOid));
		});

		it("doesn't modify what it's given", () => {
			const doc = { id: HEX_A, _appId: HEX_B };
			ids.toStored(doc);
			assert.deepStrictEqual(doc, { id: HEX_A, _appId: HEX_B });
		});

		it('converts query operators and logical queries', () => {
			const stored = ids.toStored({
				$and: [{ _appId: { $eq: HEX_A } }, { id: { $in: [HEX_A, HEX_B] } }],
				auth: { $elemMatch: { appId: HEX_B } },
				_id: { $nin: [HEX_B] },
			});

			assert.ok(isOid(stored.$and[0]._appId.$eq));
			assert.ok(stored.$and[1]._id.$in.every(isOid));
			assert.ok(isOid(stored.auth.$elemMatch.appId));
			assert.ok(isOid(stored._id.$nin[0]));
		});

		it('converts update operators by path', () => {
			const stored = ids.toStored({ $set: { 'auth.0.appId': HEX_A, name: HEX_B }, $push: { tagIds: HEX_B } });
			assert.ok(isOid(stored.$set['auth.0.appId']));
			assert.strictEqual(stored.$set.name, HEX_B);
			assert.ok(isOid(stored.$push.tagIds));
		});

		it('leaves invalid ids, regexes and other types alone', () => {
			const stored = ids.toStored({ _appId: 'not-an-id', owner: { userId: { $regex: 'abcdefghijkl' } }, tagIds: null });
			assert.strictEqual(stored._appId, 'not-an-id');
			assert.strictEqual(stored.owner.userId.$regex, 'abcdefghijkl');
			assert.strictEqual(stored.tagIds, null);
		});

		it('throws for an invalid top-level id, as looking one up did before', () => {
			assert.throws(() => ids.toStored({ id: 'not-an-id' }));
		});
	});

	describe('fromStored', () => {
		it('converts every ObjectId to a string and _id to id', () => {
			const date = new Date();
			const doc = ids.fromStored({
				_id: new ObjectId(HEX_A),
				_appId: new ObjectId(HEX_B),
				created: date,
				config: [{ query: { _id: { '@eq': new ObjectId(HEX_A) } } }],
			});

			assert.deepStrictEqual(doc, {
				id: HEX_A,
				_appId: HEX_B,
				created: date,
				config: [{ query: { _id: { '@eq': HEX_A } } }],
			});
		});

		it('round trips with toStored', () => {
			const doc = { id: HEX_A, _appId: HEX_B, auth: [{ appId: HEX_A, email: 'e' }] };
			assert.deepStrictEqual(ids.fromStored(ids.toStored(doc)), { _appId: HEX_B, auth: [{ appId: HEX_A, email: 'e' }], id: HEX_A });
		});
	});
});
