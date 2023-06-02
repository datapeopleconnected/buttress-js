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

const Helpers = require('../../../../dist/helpers');

describe('helpers.schema:populateObject', () => {
	const schema = {
		name: 'example-schema',
		properties: {
			name: {
				__type: 'string',
				__default: null,
			},
			test: {
				name: {
					__type: 'string',
					__default: 'default name',
				},
			},
			cars: {
				__type: 'array',
				__schema: {
					make: {
						__type: 'string',
						__default: '',
					},
					model: {
						__type: 'string',
						__default: 'not set',
					},
					specification: {
						wheels: {
							__type: 'number',
						},
					},
				},
			},
			specification: {
				env: {
					__type: 'object',
					__default: null,
					__required: true,
					__allowUpdate: true,
				},
			},
		},
	};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);
	let result = null;

	it('should have function, populateObject', async () => {
		assert(typeof Helpers.Schema.populateObject === 'function');
	});

	it('should execute the populateObject function', async () => {
		result = Helpers.Schema.populateObject(flattenedSchema, []);
		assert(result !== null);
	});

	it('result should have property name with value null', async () => {
		assert(result['name'] === null);
	});

	it('result should have default value on sub property of object', async () => {
		assert(result['test']['name'] === 'default name');
	});

	it('result should have default value for sub property of object that is object type', async () => {
		assert(result['specification']['env'] === null);
	});

	it('result should a cars property with an empty array', async () => {
		assert(Array.isArray(result['cars']));
		assert(result['cars'].length === 0);
	});
});
