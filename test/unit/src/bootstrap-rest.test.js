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

import { describe, it } from 'mocha';
import assert from 'assert';
import Express from 'express';

import BootstrapRest, { parseTrustProxy } from '../../../dist/bootstrap-rest.js';

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
