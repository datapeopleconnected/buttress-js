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

import BootstrapRest from '../../../dist/bootstrap-rest.js';
import DatastoreManager from '../../../dist/datastore/index.js';
import Model from '../../../dist/model/index.js';
import Plugins from '../../../dist/plugins/index.js';
import Routes from '../../../dist/routes/index.js';

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
