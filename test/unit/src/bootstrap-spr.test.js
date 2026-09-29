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

	const defaultConnections = {
		[fullAccessPolicy.id]: [tokens.fullAccess],
		[ownRecordsPolicy.id]: [tokens.ownRecords, tokens.otherOwnRecords],
	};

	function createSPR({
		policies = [fullAccessPolicy, ownRecordsPolicy],
		connections = defaultConnections,
		storedCars = Object.values(cars),
	} = {}) {
		const spr = new BootstrapSocketPolicyRouter();

		const emitted = [];
		spr.__nrp = { emit: (event, json) => emitted.push({ event, ...JSON.parse(json) }) };
		spr._policyCache = {
			getPoliciesByRestActivity: async () => policies,
			getConnectedTokenIdsByPolicyId: async (policyId) => (connections[policyId] || []).map((t) => t.id.toString()),
		};

		sinon.stub(Model, 'getAppModel').resolves(findIn(storedCars));
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

	// The route sends the entities a delete removed, as they were, through Redis (so as JSON), for the SPR to check.
	const asSent = (entity) => JSON.parse(JSON.stringify(entity));
	const deleteOne = (car, overrides = {}) =>
		activity({
			description: 'DELETE car',
			path: `/car/${car.id}`,
			pathSpec: 'car/:id',
			verb: 'delete',
			params: { id: car.id.toString() },
			response: true,
			deletedEntities: [asSent(car)],
			...overrides,
		});

	it('relays a delete-one activity to the tokens whose policies could read the entity', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		await spr._handleIncomingMessage(deleteOne(cars.notOwned));
		await spr._handleIncomingMessage(deleteOne(cars.notOwned, { isSuper: true, deletedEntities: undefined }));

		const notOwnedId = cars.notOwned.id.toString();
		for (const token of [tokens.system, tokens.fullAccess, tokens.otherOwnRecords]) {
			assert.deepStrictEqual(received(token).map((a) => [a.verb, a.params.id]), [['delete', notOwnedId]]);
		}
		assert.deepStrictEqual(received(tokens.ownRecords), []);
	});

	it('never sends on the entities a delete removed', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		await spr._handleIncomingMessage(deleteOne(cars.owned));

		for (const token of [tokens.fullAccess, tokens.ownRecords]) {
			assert.strictEqual(received(token).length, 1);
			assert(received(token).every((a) => !('deletedEntities' in a)));
		}
	});

	it('relays an entity delete that comes without the entity to system tokens only', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		await spr._handleIncomingMessage(deleteOne(cars.owned, { deletedEntities: undefined }));
		await spr._handleIncomingMessage(deleteOne(cars.owned, { isSuper: true, deletedEntities: undefined }));

		assert.strictEqual(received(tokens.system).length, 1);
		for (const token of [tokens.fullAccess, tokens.ownRecords, tokens.otherOwnRecords]) {
			assert.deepStrictEqual(received(token), []);
		}
	});

	it('relays a delete of every entity, which names none, to every token the policies reach', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		await spr._handleIncomingMessage(
			activity({ description: 'DELETE ALL car', path: '/car', pathSpec: 'car', verb: 'delete', response: true }),
		);

		for (const token of [tokens.fullAccess, tokens.ownRecords, tokens.otherOwnRecords]) {
			assert.deepStrictEqual(received(token).map((a) => [a.verb, a.path]), [['delete', '/car']]);
		}
	});

	const scopedDeleteAll = (deleted, overrides = {}) =>
		activity({
			description: 'DELETE ALL car',
			path: '/car',
			pathSpec: 'car',
			verb: 'delete',
			response: deleted.map((car) => ({ id: car.id.toString() })),
			deletedEntities: deleted.map(asSent),
			...overrides,
		});

	it('relays a delete of every entity that policies limited as one delete-one activity per entity deleted', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		await spr._handleIncomingMessage(scopedDeleteAll([cars.owned, cars.notOwned]));

		const ids = (...list) => list.map((car) => car.id.toString());
		assert.deepStrictEqual(received(tokens.fullAccess).map((a) => a.params.id), ids(cars.owned, cars.notOwned));
		assert.deepStrictEqual(received(tokens.ownRecords).map((a) => a.params.id), ids(cars.owned));
		assert.deepStrictEqual(received(tokens.otherOwnRecords).map((a) => a.params.id), ids(cars.notOwned));

		for (const a of received(tokens.fullAccess)) {
			assert.strictEqual(a.verb, 'delete');
			assert.strictEqual(a.path, `/car/${a.params.id}`);
			assert.strictEqual(a.pathSpec, 'car/:id');
			assert.strictEqual(a.response, true);
			assert(!('deletedEntities' in a));
		}
	});

	it('relays a delete of every entity that policies limited to system tokens as a delete of each, too', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		await spr._handleIncomingMessage(scopedDeleteAll([cars.owned], { isSuper: true, deletedEntities: undefined }));

		assert.deepStrictEqual(
			received(tokens.system).map((a) => [a.verb, a.path, a.params.id]),
			[['delete', `/car/${cars.owned.id}`, cars.owned.id.toString()]],
		);
	});

	it('relays nothing for a delete of every entity that policies limited to none', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		await spr._handleIncomingMessage(scopedDeleteAll([]));
		await spr._handleIncomingMessage(scopedDeleteAll([], { isSuper: true, deletedEntities: undefined }));

		for (const token of Object.values(tokens)) {
			assert.deepStrictEqual(received(token), []);
		}
	});

	it('relays a bulk delete as one delete-one activity per id, to the tokens that could read each entity', async () => {
		const { spr, received } = createSPR({ storedCars: [] });

		const deleted = [cars.owned, cars.notOwned];
		await spr._handleIncomingMessage(
			activity({
				description: 'BULK DELETE car',
				path: '/car/bulk/delete',
				pathSpec: 'car/bulk/delete',
				response: deleted.map((car) => ({ id: car.id.toString() })),
				deletedEntities: deleted.map(asSent),
			}),
		);

		const ids = (...list) => list.map((car) => car.id.toString());
		assert.deepStrictEqual(received(tokens.fullAccess).map((a) => a.params.id), ids(cars.owned, cars.notOwned));
		assert.deepStrictEqual(received(tokens.ownRecords).map((a) => a.params.id), ids(cars.owned));
		assert.deepStrictEqual(received(tokens.otherOwnRecords).map((a) => a.params.id), ids(cars.notOwned));

		for (const a of received(tokens.fullAccess)) {
			assert.strictEqual(a.verb, 'delete');
			assert.strictEqual(a.path, `/car/${a.params.id}`);
			assert.strictEqual(a.pathSpec, 'car/:id');
			assert.strictEqual(a.response, true);
			assert.strictEqual(a.clientSessionId, CLIENT_SESSION_ID);
			assert(!('deletedEntities' in a));
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

// A policy's projection ({keys}) limits which properties a token may read, and REST applies it to every read.
describe('bootstrap-spr:_handleIncomingMessage projection', () => {
	const APP_ID = new ObjectId().toString();
	const car = { id: new ObjectId(), name: 'car', secret: 'hidden', address: { street: 'A St', city: 'Leeds' } };
	const token = { id: new ObjectId(), type: 'user' };

	const namePolicy = (keys) => ({
		id: 'policy-projected',
		name: 'projected',
		_appId: APP_ID,
		env: null,
		config: [{ verbs: ['GET'], schema: ['car'], query: { access: '%FULL_ACCESS%' }, projection: { keys } }],
	});

	afterEach(() => sinon.restore());

	async function relay(keys, overrides) {
		const spr = new BootstrapSocketPolicyRouter();
		const emitted = [];
		spr.__nrp = { emit: (event, json) => emitted.push(JSON.parse(json)) };
		spr._policyCache = {
			getPoliciesByRestActivity: async () => [namePolicy(keys)],
			getConnectedTokenIdsByPolicyId: async () => [token.id.toString()],
		};
		sinon.stub(Model, 'getAppModel').resolves({ findById: async () => car });

		await spr._handleIncomingMessage({
			broadcast: true,
			path: `/car/${car.id}`,
			pathSpec: 'car/:id',
			verb: 'put',
			params: { id: car.id.toString() },
			response: null,
			appAPIPath: 'test-app',
			appId: APP_ID,
			isSuper: false,
			isCoreSchema: false,
			schemaName: 'car',
			...overrides,
		});
		return emitted.map((e) => e.activity.response);
	}

	it('sends a created entity with only its id and the projected properties', async () => {
		const response = await relay(['name'], {
			path: '/car',
			pathSpec: 'car',
			verb: 'post',
			params: {},
			response: { id: car.id.toString(), sourceId: APP_ID, name: 'car', secret: 'hidden' },
		});

		assert.deepStrictEqual(response, [{ id: car.id.toString(), sourceId: APP_ID, name: 'car' }]);
	});

	it('projects nested keys of a created entity', async () => {
		const response = await relay(['address.street'], {
			path: '/car',
			pathSpec: 'car',
			verb: 'post',
			params: {},
			response: { id: car.id.toString(), name: 'car', address: { street: 'A St', city: 'Leeds' } },
		});

		assert.deepStrictEqual(response, [{ id: car.id.toString(), address: { street: 'A St' } }]);
	});

	it('sends only the update results the projection lets through', async () => {
		const response = await relay(['name'], {
			response: [
				{ type: 'scalar', path: 'secret', value: 'changed' },
				{ type: 'scalar', path: 'name', value: 'renamed' },
			],
		});

		assert.deepStrictEqual(response, [[{ type: 'scalar', path: 'name', value: 'renamed' }]]);
	});

	it('sends nothing for an update that only changed hidden properties', async () => {
		const response = await relay(['name'], { response: [{ type: 'scalar', path: 'secret', value: 'changed' }] });

		assert.deepStrictEqual(response, []);
	});

	it('trims an update of a parent object down to its projected keys', async () => {
		const response = await relay(['address.street'], {
			response: [{ type: 'scalar', path: 'address', value: { street: 'B St', city: 'York' } }],
		});

		assert.deepStrictEqual(response, [[{ type: 'scalar', path: 'address', value: { street: 'B St' } }]]);
	});
});

// A config's condition and query are checked as REST checks them: a token only gets the activity while the condition
// holds and the query reads the entity.
describe('bootstrap-spr:_handleIncomingMessage conditions and queries', () => {
	const APP_ID = new ObjectId().toString();
	const car = { id: new ObjectId(), name: 'car' };
	const user = { id: new ObjectId(), role: 'admin' };
	const token = { id: new ObjectId(), type: 'user', _userId: user.id.toString() };

	// Conditions on the app, which don't depend on the token
	const holds = { '#env.appId': { '@eq': APP_ID } };
	const fails = { '#env.appId': { '@eq': new ObjectId().toString() } };

	const policy = (...conditions) => ({
		id: 'policy-conditioned',
		name: 'conditioned',
		_appId: APP_ID,
		env: null,
		config: conditions.map((condition) => ({
			verbs: ['GET'],
			schema: ['car'],
			query: { access: '%FULL_ACCESS%' },
			condition,
		})),
	});
	const queryPolicy = (query) => ({
		id: 'policy-query',
		name: 'query',
		_appId: APP_ID,
		env: null,
		config: [{ verbs: ['GET'], schema: ['car'], query, condition: null }],
	});

	afterEach(() => sinon.restore());

	async function relay(policies, overrides = {}) {
		sinon.restore();
		const spr = new BootstrapSocketPolicyRouter();
		const emitted = [];
		spr.__nrp = { emit: (event, json) => emitted.push(JSON.parse(json)) };
		spr._policyCache = {
			getPoliciesByRestActivity: async () => policies,
			getConnectedTokenIdsByPolicyId: async () => [token.id.toString()],
		};
		sinon.stub(Model, 'getAppModel').resolves({ findById: async () => car });
		sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
			const docs = modelClass === TokenSchemaModel ? [token] : [user];
			return {
				createId: (id) => new ObjectId(id),
				findOne: async (query) => docs.find((doc) => doc.id.equals(query._id)) || null,
			};
		});

		await spr._handleIncomingMessage({
			broadcast: true,
			path: `/car/${car.id}`,
			pathSpec: 'car/:id',
			verb: 'put',
			params: { id: car.id.toString() },
			response: [{ type: 'scalar', path: 'name', value: 'renamed' }],
			appAPIPath: 'test-app',
			appId: APP_ID,
			isSuper: false,
			isCoreSchema: false,
			schemaName: 'car',
			...overrides,
		});
		return emitted.filter((e) => e.tokens?.includes(token.id.toString()));
	}

	it('relays an activity for a config whose condition holds, or that has none', async () => {
		assert.strictEqual((await relay([policy(holds)])).length, 1);
		assert.strictEqual((await relay([policy(null)])).length, 1);
	});

	it("doesn't relay an activity for a config whose condition doesn't hold", async () => {
		assert.deepStrictEqual(await relay([policy(fails)]), []);
		assert.deepStrictEqual(await relay([policy({})]), []);
	});

	it("doesn't relay a delete for a config whose condition doesn't hold", async () => {
		const deleted = await relay([policy(fails)], {
			verb: 'delete',
			response: true,
			deletedEntities: [JSON.parse(JSON.stringify(car))],
		});

		assert.deepStrictEqual(deleted, []);
	});

	it('relays an activity for a query that, once its access keys are dropped, is empty, as REST reads every entity', async () => {
		for (const query of [{}, { access: '%FULL_ACCESS%' }, { access: '%APP_SCHEMA%' }]) {
			assert.strictEqual((await relay([queryPolicy(query)])).length, 1, JSON.stringify(query));
		}
	});

	it('applies the rest of a query that gives full access, as REST does', async () => {
		const other = { access: '%FULL_ACCESS%', name: { '@eq': 'another car' } };
		const same = { access: '%FULL_ACCESS%', name: { '@eq': car.name } };

		assert.deepStrictEqual(await relay([queryPolicy(other)]), []);
		assert.strictEqual((await relay([queryPolicy(same)])).length, 1);
	});

	it("checks a condition on the token's user against each token", async () => {
		const admin = { '#env.user.role': { '@eq': 'admin' } };
		const editor = { '#env.user.role': { '@eq': 'editor' } };

		assert.strictEqual((await relay([policy(admin)])).length, 1);
		assert.deepStrictEqual(await relay([policy(editor)]), []);
	});
});

describe('bootstrap-spr: deleted tokens', () => {
  it('takes a deleted token off the list of connected tokens', async () => {
    const spr = new BootstrapSocketPolicyRouter();
    const handlers = {};
    spr.__nrp = { on: (event, handler) => (handlers[event] = handler), emit: () => {} };
    const removed = [];
    spr._policyCache = { removeConnectedToken: async (tokenId) => removed.push(tokenId) };

    await spr.__registerNRPPrimaryListeners();
    await handlers['token:deleted'](JSON.stringify({ tokenIds: ['token-1', 'token-2'] }));

    assert.deepStrictEqual(removed, ['token-1', 'token-2']);
  });
});

describe('bootstrap-spr: socket connections', () => {
  afterEach(() => sinon.restore());

  it("works out a token's policies on every connection, even one already connected, before renewing it", async () => {
    const spr = new BootstrapSocketPolicyRouter();
    const token = { id: new ObjectId(), type: 'user' };
    const calls = [];
    spr._policyCache = {
      isTokenConnected: async () => true,
      getPoliciesByToken: async (t) => calls.push(['getPoliciesByToken', t.id.toString()]),
      addConnectedToken: async (id) => calls.push(['addConnectedToken', id]),
    };
    sinon.stub(Model, 'getCoreModel').returns({ findOne: async () => token });

    await spr._socketConnection(token.id.toString());

    assert.deepStrictEqual(calls, [
      ['getPoliciesByToken', token.id.toString()],
      ['addConnectedToken', token.id.toString()],
    ]);
  });
});
