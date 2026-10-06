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

import { describe, it, beforeEach, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';
import createConfig from '@dpc/node-env-obj';
import Express from 'express';
import cluster from 'node:cluster';
import { Readable } from 'node:stream';

import BootstrapRest, { parseTrustProxy } from '../../../dist/bootstrap-rest.js';
import DatastoreManager from '../../../dist/datastore/index.js';
import Model from '../../../dist/model/index.js';
import Plugins from '../../../dist/plugins/index.js';
import Routes from '../../../dist/routes/index.js';
import Logging from '../../../dist/helpers/logging.js';

const Config = createConfig();

// Stub out what __initWorker() and clean() use besides the Express app and its server
function stubWorkerServices() {
	sinon.stub(Model, 'initCoreModels').resolves();
	sinon.stub(Model, 'getCoreModel').returns({ setLocalSchema: () => {} });
	sinon.stub(Model, 'initSchema').resolves();
	sinon.stub(Model, 'clean').resolves();
	sinon.stub(Routes.prototype, 'init').resolves();
	sinon.stub(Routes.prototype, 'initRoutes').resolves();
	sinon.stub(Routes.prototype, 'initAppRoutes').resolves();
	sinon.stub(DatastoreManager, 'clean').resolves();
}

describe('bootstrap-rest:class', () => {
	it(`should create an instance of the bootstrapRest class`, () => {
		const bootstrapRest = new BootstrapRest();
		assert(bootstrapRest instanceof BootstrapRest);
	});

	describe('bootstrapRest:init', () => {
		it(`should have function, init`, () => {
			const bootstrapRest = new BootstrapRest();
			assert(typeof bootstrapRest.init === 'function');
		});
	});

	describe('bootstrapRest:_getLocalSchemas', () => {
		it(`should have function, _getLocalSchemas`, () => {
			const bootstrapRest = new BootstrapRest();
			assert(typeof bootstrapRest._getLocalSchemas === 'function');
		});

		it(`should return an array of schemas`, () => {
			const bootstrapRest = new BootstrapRest();
			const result = bootstrapRest._getLocalSchemas();
			assert(Array.isArray(result));
		});
	});

	describe('bootstrapRest:clean', () => {
		let restPort;

		beforeEach(() => {
			// Listen on any free port, not the configured one
			restPort = Config.listenPorts.rest;
			Config.listenPorts.rest = 0;
		});

		afterEach(() => {
			Config.listenPorts.rest = restPort;
			sinon.restore();
		});

		it(`should stop passing plugin requests to its app`, async () => {
			stubWorkerServices();
			const listenerCount = Plugins.listenerCount('request');
			const bootstrapRest = new BootstrapRest();
			await bootstrapRest.__initWorker();

			const handle = sinon.stub(bootstrapRest.routes.app, 'handle');
			const req = {};
			const res = {};
			Plugins.emit('request', req, res);
			assert(handle.calledOnceWith(req, res));

			await bootstrapRest.clean();
			Plugins.emit('request', req, res);

			assert.strictEqual(handle.callCount, 1);
			assert.strictEqual(Plugins.listenerCount('request'), listenerCount);
		});
	});
});

describe('bootstrap-rest:parseTrustProxy', () => {
	it(`should turn an all-digit value into a hop count`, () => {
		assert.strictEqual(parseTrustProxy('1'), 1);
		assert.strictEqual(parseTrustProxy('0'), 0);
		assert.strictEqual(parseTrustProxy(' 2 '), 2);
	});

	it(`should turn true/false into booleans, in any case`, () => {
		assert.strictEqual(parseTrustProxy('true'), true);
		assert.strictEqual(parseTrustProxy('TRUE'), true);
		assert.strictEqual(parseTrustProxy('false'), false);
		assert.strictEqual(parseTrustProxy('FALSE'), false);
	});

	it(`should leave any other value as a string for express to parse`, () => {
		assert.strictEqual(parseTrustProxy('loopback'), 'loopback');
		assert.strictEqual(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12'), '10.0.0.0/8, 172.16.0.0/12');
		assert.strictEqual(parseTrustProxy('10.0.0.1'), '10.0.0.1');
	});

	it(`should make express take req.ip from X-Forwarded-For behind one proxy`, () => {
		// node-env-obj turns the config.json default of 1 into '1', which express would read as the address 0.0.0.1
		const app = Express();
		app.set('trust proxy', parseTrustProxy('1'));

		const req = Object.create(app.request, {
			headers: { value: { 'x-forwarded-for': '203.0.113.7' } },
			socket: { value: { remoteAddress: '10.0.0.5' } },
		});

		assert.strictEqual(req.ip, '203.0.113.7');
	});
});

describe('bootstrap-rest:schema changes waited on', () => {
	const originalSend = process.send;
	afterEach(() => {
		sinon.restore();
		process.send = originalSend;
	});

	// A worker that has its routes, and the send it answers its main with
	const createWorker = (regenerate) => {
		const bootstrapRest = new BootstrapRest();
		bootstrapRest.routes = { regenerateAppRoutes: regenerate };
		sinon.stub(Model, 'initSchema').resolves();
		sinon.stub(cluster, 'isWorker').value(true);
		const send = sinon.stub();
		process.send = send;
		return { bootstrapRest, send };
	};
	const updated = (changeId) => ({ type: 'app-schema:updated', payload: { appId: 'app-1', changeId } });

	it(`should tell its main a worker has the routes of a change that's waited on`, async () => {
		const { bootstrapRest, send } = createWorker(sinon.stub().resolves());

		await bootstrapRest.__handleMessageFromMain(updated('c1'));

		sinon.assert.calledOnceWithExactly(send, { type: 'app-schema:applied', payload: { changeId: 'c1' } });
	});

	it(`should tell its main even when the worker could not build the routes`, async () => {
		const { bootstrapRest, send } = createWorker(sinon.stub().rejects(new Error('bad routes')));

		await assert.rejects(bootstrapRest.__handleMessageFromMain(updated('c1')), /bad routes/);

		sinon.assert.calledOnceWithExactly(send, { type: 'app-schema:applied', payload: { changeId: 'c1' } });
	});

	it(`should say nothing for a change nobody waits on`, async () => {
		const { bootstrapRest, send } = createWorker(sinon.stub().resolves());

		await bootstrapRest.__handleMessageFromMain(updated(undefined));

		sinon.assert.notCalled(send);
	});

	it(`should announce a change once every worker has the routes`, async () => {
		const bootstrapRest = new BootstrapRest();
		bootstrapRest.__nrp = { emit: sinon.stub() };
		bootstrapRest._schemaAcks.start('c1', [0, 1], 'app-1');
		const applied = (idx) =>
			bootstrapRest.__handleMessageFromWorker(idx, { type: 'app-schema:applied', payload: { changeId: 'c1' } });

		await applied(0);
		sinon.assert.notCalled(bootstrapRest.__nrp.emit);

		await applied(1);
		sinon.assert.calledOnce(bootstrapRest.__nrp.emit);
		const [channel, json] = bootstrapRest.__nrp.emit.firstCall.args;
		assert.strictEqual(channel, 'app-schema:applied');
		const message = JSON.parse(json);
		assert.strictEqual(message.changeId, 'c1');
		assert.strictEqual(message.appId, 'app-1');
		assert.strictEqual(message.pid, process.pid);
	});

	it(`should stop waiting on a worker that exits`, () => {
		const bootstrapRest = new BootstrapRest();
		bootstrapRest.__nrp = { emit: sinon.stub() };
		bootstrapRest._schemaAcks.start('c1', [0], 'app-1');

		bootstrapRest.__onWorkerExit(0);

		sinon.assert.calledOnce(bootstrapRest.__nrp.emit);
	});
});

describe('bootstrap-rest:__updateAppSchema', () => {
	afterEach(() => sinon.restore());

	const app = (id, __schema) => ({ id, name: id, __schema });
	const schema = (name) => ({ name, type: 'collection', properties: {} });

	// A REST main over the apps given, with one local schema, noting the schemas it stores
	function createMain(apps, updateSchema = sinon.stub().resolves()) {
		const bootstrapRest = new BootstrapRest();
		sinon.stub(bootstrapRest, '_getLocalSchemas').returns([schema('note')]);
		sinon.stub(Model, 'getCoreModel').returns({
			setLocalSchema: () => {},
			findAll: async () => Readable.from(apps),
			updateSchema,
		});
		return { bootstrapRest, updateSchema };
	}

	for (const [label, stored] of [
		["isn't JSON", '[{"name": "car", '],
		["isn't a list", JSON.stringify({ name: 'car', type: 'collection' })],
		['is null', 'null'],
		['holds null', JSON.stringify([{ name: 'car', type: 'collection', properties: {} }, null])],
		['holds a schema with no type', JSON.stringify([{ name: 'car', properties: {} }])],
	]) {
		it(`should pass over an app whose stored schema ${label}, and add the local schemas to the apps after it`, async () => {
			const warn = sinon.stub(Logging, 'logWarn');
			const { bootstrapRest, updateSchema } = createMain([
				app('app-1', JSON.stringify([schema('boat')])),
				app('app-2', stored),
				app('app-3', JSON.stringify([schema('car')])),
			]);

			await bootstrapRest.__updateAppSchema();

			assert.deepStrictEqual(
				updateSchema.args.map(([appId, schemas]) => [appId, schemas.map((s) => s.name)]),
				[
					['app-1', ['boat', 'note']],
					['app-3', ['car', 'note']],
				],
			);
			sinon.assert.calledOnceWithMatch(warn, 'app-2');
		});
	}

	it(`should add a local schema's properties to an app's schema of that name that leaves its properties out`, async () => {
		const { bootstrapRest, updateSchema } = createMain([
			app('app-1', JSON.stringify([{ name: 'note', type: 'collection' }])),
		]);
		bootstrapRest._getLocalSchemas.returns([{ ...schema('note'), properties: { text: { __type: 'string' } } }]);

		await bootstrapRest.__updateAppSchema();

		sinon.assert.calledOnceWithExactly(updateSchema, 'app-1', [
			{ name: 'note', type: 'collection', properties: { text: { __type: 'string' } } },
		]);
	});

	it(`should still fail on an error that is not about the stored schema`, async () => {
		const { bootstrapRest } = createMain(
			[app('app-1', JSON.stringify([schema('car')]))],
			sinon.stub().rejects(new Error('datastore went away')),
		);

		await assert.rejects(bootstrapRest.__updateAppSchema(), /datastore went away/);
	});
});
