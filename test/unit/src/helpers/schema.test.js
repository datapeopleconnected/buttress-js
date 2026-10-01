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

import * as Helpers from '../../../../dist/helpers/index.js';
import { parseDocument } from '../../../../dist/model/parse-document.js';

describe('model/parse-document:parseDocument', () => {
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

	it('should parse an empty body', async () => {
		result = parseDocument(flattenedSchema, {}).value;
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

describe('model/parse-document:parseDocument - array sub-schema field name collision', () => {
	// Regression test: a top-level field (`status`) and an array-of-objects field's own sub-schema
	// field of the same name (`parties[].status`) must be read independently: each item is read
	// on its own, so the sub-schema field's default never overwrites the top-level field of the
	// same name, whether or not the sub-schema value equals its own default.
	const schema = {
		name: 'example-relationship',
		properties: {
			status: {
				__type: 'string',
				__default: 'ACTIVE',
				__required: true,
			},
			parties: {
				__type: 'array',
				__schema: {
					status: {
						__type: 'string',
						__default: 'ACCEPTED',
						__required: true,
					},
				},
			},
		},
	};

	const flattenedSchema = Helpers.getFlattenedSchema(schema);

	it("does not let an array sub-schema field's default clobber a same-named top-level field", () => {
		const body = {
			status: 'ACTIVE',
			parties: [{ status: 'ACCEPTED' }],
		};
		const { value, issues } = parseDocument(flattenedSchema, body);

		assert.deepStrictEqual(issues, []);
		assert.strictEqual(value.status, 'ACTIVE');
		assert.strictEqual(value.parties[0].status, 'ACCEPTED');
		assert.deepStrictEqual(body, { status: 'ACTIVE', parties: [{ status: 'ACCEPTED' }] });
	});
});

describe('helpers.Schema:extend', () => {
	it('should pull in a property from the extended schema that the child does not define', () => {
		const schemas = [
			{ name: 'timestamps', properties: { createdAt: { __type: 'date', __default: 'parent-default' } } },
			{ name: 'thing', extends: ['timestamps'], properties: {} },
		];

		const result = Helpers.Schema.extend(schemas, schemas[1]);

		assert.strictEqual(result.properties.createdAt.__default, 'parent-default');
	});

	it("should keep the child's own property instead of the extended schema's same-named property", () => {
		const schemas = [
			{ name: 'timestamps', properties: { createdAt: { __type: 'date', __default: 'parent-default' } } },
			{
				name: 'thing',
				extends: ['timestamps'],
				properties: { createdAt: { __type: 'date', __default: 'child-default' } },
			},
		];

		const result = Helpers.Schema.extend(schemas, schemas[1]);

		assert.strictEqual(result.properties.createdAt.__default, 'child-default');
	});
});

describe('helpers.schema:stripPrivate', () => {
  const user = () => ({
    id: 'u1',
    auth: [
      { app: 'google', password: 'secret', token: 't1' },
      { app: 'github', token: 't2' },
    ],
    profile: { password: 'kept, not private here' },
  });

  it('leaves out the private paths, through arrays, keeping everything else', () => {
    assert.deepStrictEqual(Helpers.Schema.stripPrivate(user(), [['auth', 'password']]), {
      id: 'u1',
      auth: [
        { app: 'google', token: 't1' },
        { app: 'github', token: 't2' },
      ],
      profile: { password: 'kept, not private here' },
    });
  });

  it('strips each of a list of results, and changes none of what it was given', () => {
    const given = [user(), user()];

    const stripped = Helpers.Schema.stripPrivate(given, [['auth', 'password']]);

    assert.strictEqual(stripped[1].auth[0].password, undefined);
    assert.deepStrictEqual(given, [user(), user()]);
  });

  it('gives a value with no private paths back as it is', () => {
    const value = user();
    assert.strictEqual(Helpers.Schema.stripPrivate(value, []), value);
  });
});
