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

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import { ObjectId } from 'bson';

import BootstrapSocketPolicyRouter from '../../../dist/bootstrap-spr.js';
import Model from '../../../dist/model/index.js';
import TokenSchemaModel from '../../../dist/model/core/token.js';
import UserSchemaModel from '../../../dist/model/core/user.js';

describe('bootstrap-spr:class', () => {
	it(`should create an instance of the BootstrapSocketPolicyRouter class`, () => {
		const boostrapSPR = new BootstrapSocketPolicyRouter();
		assert(boostrapSPR instanceof BootstrapSocketPolicyRouter);
	});

	describe('bootstrapRest:init', () => {
		it(`should have function, init`, () => {
			const boostrapSPR = new BootstrapSocketPolicyRouter();
			assert(typeof boostrapSPR.init === 'function');
		});
	});
});

// These run the SPR's real routing and policy evaluation. Only the policy cache, the models and NRP are faked.
describe('bootstrap-spr:_handleIncomingMessage bulk activity', () => {
	const APP_ID = new ObjectId().toString();
	const CLIENT_SESSION_ID = '11111111-1111-4111-8111-111111111111';

	const owner = { id: new ObjectId() };
	const someoneElse = { id: new ObjectId() };

	const tokens = {
		system: { id: new ObjectId(), type: 'system' },
		fullAccess: { id: new ObjectId(), type: 'app' },
		ownRecords: { id: new ObjectId(), type: 'user', _userId: owner.id.toString() },
		otherOwnRecords: { id: new ObjectId(), type: 'user', _userId: someoneElse.id.toString() },
	};

	const cars = {
		owned: { id: new ObjectId(), name: 'owned', userId: owner.id },
		notOwned: { id: new ObjectId(), name: 'not-owned', userId: someoneElse.id },
		refused: { id: new ObjectId(), name: 'refused', userId: owner.id },
	};

	const fullAccessPolicy = {
		id: 'policy-full-access',
		name: 'full-access',
		_appId: APP_ID,
		env: null,
		config: [{ verbs: ['GET', 'SEARCH'], schema: ['car'], query: { access: '%FULL_ACCESS%' } }],
	};

	// References #env.user, so the SPR has to evaluate it for each connected token.
	const ownRecordsPolicy = {
		id: 'policy-own-records',
		name: 'own-records',
		_appId: APP_ID,
		env: { userId: '#env.user.id' },
		config: [{ verbs: ['GET'], schema: ['car'], query: { userId: { '@eq': '#env.userId' } } }],
	};

	const findIn = (docs) => ({
		createId: (id) => new ObjectId(id),
		find: async (query) => docs.filter((doc) => doc.type === query.type),
		findOne: async (query) => docs.find((doc) => doc.id.equals(query._id)) || null,
		// Like MongodbAdapter.findById, this throws when there's no such document.
		findById: async (id) => {
			const doc = docs.find((d) => d.id.toString() === id.toString());
			if (!doc) throw new Error('Unable to find document');
			return doc;
		},
	});

	function createSPR() {
		const spr = new BootstrapSocketPolicyRouter();

		const emitted = [];
		spr.__nrp = { emit: (event, json) => emitted.push({ event, ...JSON.parse(json) }) };
		spr._policyCache = {
			getPoliciesByRestActivity: async () => [fullAccessPolicy, ownRecordsPolicy],
			getConnectedTokenIdsByPolicyId: async (policyId) =>
				({
					[fullAccessPolicy.id]: [tokens.fullAccess.id.toString()],
					[ownRecordsPolicy.id]: [tokens.ownRecords.id.toString(), tokens.otherOwnRecords.id.toString()],
				})[policyId] || [],
		};

		sinon.stub(Model, 'getAppModel').resolves(findIn(Object.values(cars)));
		sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
			if (modelClass === TokenSchemaModel) return findIn(Object.values(tokens));
			if (modelClass === UserSchemaModel) return findIn([owner, someoneElse]);
			throw new Error(`Unexpected core model ${modelClass.name}`);
		});

		const received = (token) =>
			emitted
				.filter((e) => e.event === 'spr:activity' && e.tokens.includes(token.id.toString()))
				.map((e) => e.activity);

		return { spr, received };
	}

	const activity = (overrides) => ({
		title: 'Private Activity',
		description: 'BULK UPDATE car',
		visibility: 'private',
		broadcast: true,
		path: '/car/bulk/update',
		pathSpec: 'car/bulk/update',
		verb: 'post',
		permissions: 'write',
		params: {},
		timestamp: new Date().toISOString(),
		response: null,
		clientSessionId: CLIENT_SESSION_ID,
		user: '',
		appAPIPath: 'test-app',
		appId: APP_ID,
		isSuper: false,
		isCoreSchema: false,
		schemaName: 'car',
		...overrides,
	});

	const renamed = (car) => ({
		id: car.id.toString(),
		sourceId: APP_ID,
		results: [{ type: 'scalar', path: 'name', value: `${car.name}-renamed` }],
	});

	const bulkUpdateResponse = [
		renamed(cars.owned),
		renamed(cars.notOwned),
		{
			id: cars.refused.id.toString(),
			sourceId: APP_ID,
			results: null,
			validation: { code: 400, message: 'car: Update value is invalid for path name' },
		},
	];

	afterEach(() => sinon.restore());

	it('relays each updated entity to a token with a read policy, as an update-one activity', async () => {
		const { spr, received } = createSPR();

		await spr._handleIncomingMessage(activity({ response: bulkUpdateResponse }));

		const activities = received(tokens.fullAccess);
		assert.deepStrictEqual(
			activities.map((a) => a.params.id),
			[cars.owned.id.toString(), cars.notOwned.id.toString()],
		);

		const [first] = activities;
		assert.strictEqual(first.verb, 'put');
		assert.strictEqual(first.path, `/car/${cars.owned.id}`);
		assert.strictEqual(first.pathSpec, 'car/:id');
		assert.deepStrictEqual(first.response, renamed(cars.owned).results);
		assert.strictEqual(first.clientSessionId, CLIENT_SESSION_ID);
		assert.strictEqual(first.schemaName, 'car');
		assert.strictEqual(first.appAPIPath, 'test-app');
	});

	it('relays only the entities a token-level policy selects', async () => {
		const { spr, received } = createSPR();

		await spr._handleIncomingMessage(activity({ response: bulkUpdateResponse }));

		assert.deepStrictEqual(
			received(tokens.ownRecords).map((a) => a.params.id),
			[cars.owned.id.toString()],
		);
	});

	it('relays nothing for an item that was refused, since it changed nothing', async () => {
		const { spr, received } = createSPR();

		await spr._handleIncomingMessage(activity({ response: bulkUpdateResponse }));

		const refusedId = cars.refused.id.toString();
		for (const token of [tokens.fullAccess, tokens.ownRecords]) {
			assert(!received(token).some((a) => a.params.id === refusedId || JSON.stringify(a).includes(refusedId)));
		}
	});

	it('relays a delete-one activity, although the entity can no longer be found', async () => {
		const { spr, received } = createSPR();

		const deletedId = new ObjectId().toString();
		const deleteOne = activity({
			description: 'DELETE car',
			path: `/car/${deletedId}`,
			pathSpec: 'car/:id',
			verb: 'delete',
			params: { id: deletedId },
			response: true,
		});
		await spr._handleIncomingMessage(deleteOne);
		await spr._handleIncomingMessage({ ...deleteOne, isSuper: true });

		for (const token of [tokens.system, tokens.fullAccess, tokens.ownRecords, tokens.otherOwnRecords]) {
			assert.deepStrictEqual(
				received(token).map((a) => [a.verb, a.params.id]),
				[['delete', deletedId]],
			);
		}
	});

	it('relays a bulk delete as one delete-one activity per id, to each token once', async () => {
		const { spr, received } = createSPR();

		// Deleted entities are gone by the time the SPR sees the activity.
		const deletedIds = [new ObjectId().toString(), new ObjectId().toString()];
		await spr._handleIncomingMessage(
			activity({
				description: 'BULK DELETE car',
				path: '/car/bulk/delete',
				pathSpec: 'car/bulk/delete',
				response: deletedIds.map((id) => ({ id, sourceId: APP_ID })),
			}),
		);

		for (const token of [tokens.fullAccess, tokens.ownRecords, tokens.otherOwnRecords]) {
			const activities = received(token);
			assert.deepStrictEqual(activities.map((a) => a.params.id), deletedIds);
			for (const [idx, a] of activities.entries()) {
				assert.strictEqual(a.verb, 'delete');
				assert.strictEqual(a.path, `/car/${deletedIds[idx]}`);
				assert.strictEqual(a.pathSpec, 'car/:id');
				assert.strictEqual(a.response, true);
				assert.strictEqual(a.clientSessionId, CLIENT_SESSION_ID);
			}
		}
	});

	it('still sends system tokens the bulk activity unchanged', async () => {
		const { spr, received } = createSPR();

		const superActivity = activity({ response: bulkUpdateResponse, isSuper: true });
		await spr._handleIncomingMessage(superActivity);

		assert.deepStrictEqual(received(tokens.system), [superActivity]);
		assert.deepStrictEqual(received(tokens.fullAccess), []);
	});
});
