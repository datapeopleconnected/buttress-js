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

const Helpers = require('../../../../dist/helpers');

describe('helpers.schema:sanitizeObject', () => {
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

	it('should have function, sanitizeObject', async () => {
		assert(typeof Helpers.Schema.sanitizeObject === 'function');
	});

	it('should execute the sanitizeObject function', async () => {
		result = Helpers.Schema.sanitizeObject(flattenedSchema, []);
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

describe('helpers.schema:getFlattenedBody', () => {
	const body = {
		name: 'example-object',
		age: 31,
		testSubObject: {
			id: '64f092cb7b7d65a36cf64a51',
			node: true,
			fruit: 'orange',
		},
		unstructured: true,
		array: [
			'car',
			'bike',
			{arraySubOject: 'yes', arraySubOjectSubObject: {thisCouldGoOn: true}},
		],
	};

	let result = null;

	it('should have function, getFlattenedBody', async () => {
		assert(typeof Helpers.Schema.getFlattenedBody === 'function');
	});

	it('should execute the getFlattenedBody function', async () => {
		result = Helpers.Schema.getFlattenedBody(body);
		assert(result !== null);
	});

	it('result should have property name which matches body value', async () => {
		const {value} = result.find((r) => r.path === 'name');
		assert(value !== undefined && value === body.name);
	});

	it('result should have property age which matches body value', async () => {
		const {value} = result.find((r) => r.path === 'age');
		assert(value !== undefined && value === body.age);
	});

	it('result should have property unstructured which matches body value', async () => {
		const {value} = result.find((r) => r.path === 'unstructured');
		assert(value !== undefined && value === body.unstructured);
	});

	it('result should have sub object property id flattened', async () => {
		const {value} = result.find((r) => r.path === 'testSubObject.id');
		assert(value !== undefined && value === body.testSubObject.id);
	});

	it('result should have sub object property fruit flattened', async () => {
		const {value} = result.find((r) => r.path === 'testSubObject.fruit');
		assert(value !== undefined && value === body.testSubObject.fruit);
	});

	it('result should have an array with length matching 3', async () => {
		const {value} = result.find((r) => r.path === 'array');
		assert(value !== undefined && value.length === 3);
	});

	it('result array should have matching sub values', async () => {
		const {value} = result.find((r) => r.path === 'array');
		assert(value[0] === 'car');
		assert(value[1] === 'bike');

		// Sub array objects aren't flattened
		assert(value[2].arraySubOject === body.array[2].arraySubOject);
		assert(value[2].arraySubOjectSubObject.thisCouldGoOn === body.array[2].arraySubOjectSubObject.thisCouldGoOn);
	});
});
