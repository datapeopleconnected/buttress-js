/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

const Helpers = require('../../../dist/helpers');

describe('helpers:getFlattenedSchema', () => {
	const schema = {
		name: 'example-schema',
		properties: {
			name: {
				__type: 'string',
			},
			test: {
				name: {
					__type: 'string',
				},
			},
			cars: {
				__type: 'array',
				__schema: {
					make: {
						__type: 'string',
					},
					model: {
						__type: 'string',
					},
					specification: {
						wheels: {
							__type: 'number',
						},
					},
				},
			},
		},
	};

	let result = null;

	it('should have function, getFlattenedSchema', async () => {
		assert(typeof Helpers.getFlattenedSchema === 'function');
	});

	it('should execute the getFlattenedSchema function', async () => {
		result = Helpers.getFlattenedSchema(schema);
		assert(result !== null);
	});

	it('result should have a flattened object property', async () => {
		assert(result['test.name'] && result['test.name'].__type === 'string');
	});

	it('result should have an array property', async () => {
		assert(result['cars'] && result['cars'].__type === 'array');
	});

	it('result should have a array sub schema', async () => {
		assert(result['cars'] && result['cars'].__schema);
	});

	it('result should have a flattened array properties', async () => {
		assert(result['cars'] && result['cars.make'].__type === 'string');
		assert(result['cars'] && result['cars.model'].__type === 'string');
		assert(result['cars'] && result['cars.specification.wheels'].__type === 'number');
	});
});
