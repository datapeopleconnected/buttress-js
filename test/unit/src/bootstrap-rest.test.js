/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

const {describe, it} = require('mocha');
const assert = require('assert');

const {default: BootstrapRest} = require('../../../dist/bootstrap-rest');

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
