'use strict';

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

const crypto = require('crypto');
const Helpers = require('./helpers');

const Plugins = require('./plugins');

class Schema {
	constructor(data) {
		this.data = data;

		this.name = data.name;

		this.digest = null;

		this.__flattened = null;
		this.__flattenedPermissionProperties = null;

		this.init();
	}

	init() {
		if (this.data) {
			const hash = crypto.createHash('sha1');
			hash.update(Schema.encode(this.data));
			this.digest = hash.digest('hex');

			this.__flattened = Helpers.getFlattenedSchema(this.data);
		}
	}

	getFlat() {
		return this.__flattened;
	}

	getFlatPermissionProperties() {
		if (this.__flattenedPermissionProperties) {
			return this.__flattenedPermissionProperties;
		}

		const properties = this.getFlat();
		const permissions = {};

		for (const property in properties) {
			if ({}.hasOwnProperty.call(properties, property)) {
				if (properties[property].__permissions) {
					permissions[property] = properties[property].__permissions;
				}
			}
		}

		this.__flattenedPermissionProperties = permissions;
		return permissions;
	}

	static encode(obj) {
		return JSON.stringify(obj);
		// return JSON.parse(Schema.encodeKey(JSON.stringify(obj)));
	}

	static decode(obj) {
		return JSON.parse(obj);
		// return JSON.parse(Schema.decodeKey(JSON.stringify(obj)));
	}

	static encodeKey(key) {
		return key.replace(/\\/g, '\\\\').replace(/\$/g, '\\u0024').replace(/\./g, '\\u002e');
	}

	static decodeKey(key) {
		return key.replace(/\\u002e/g, '.').replace(/\\u0024/g, '$').replace(/\\\\/g, '\\');
	}

	static async buildCollections(schemas) {
		const builtSchemas = await Schema.build(schemas);
		return builtSchemas.filter((s) => s.type.indexOf('collection') === 0);
	}

	static async build(schemas) {
		schemas = await Plugins.apply_filters('before_schema_build', schemas);
		schemas = schemas.map((schema) => {
			schema.properties.id = {__type: 'id', __default: 'new', __allowUpdate: false, __core: true};
			schema.properties.source = {__type: 'id', __allowUpdate: false, __core: true};
			return Schema.extend(schemas, schema);
		});
		for await (const schema of schemas) {
			const res = await this.createTimeSeriesSchema(schema.name, schema.properties);
			if (!res) continue;
			Object.keys(res).forEach((key) => {
				schemas.push(res[key]);
			});
		}
		schemas = await Plugins.apply_filters('after_schema_build', schemas);
		return schemas;
	}

	static merge(schemasA, schemasB) {
		schemasB.forEach((cS) => {
			const appSchemaIdx = schemasA.findIndex((s) => s.name === cS.name);
			const schema = schemasA[appSchemaIdx];
			if (!schema) {
				return schemasA.push(cS);
			}
			schema.properties = Object.assign(schema.properties, cS.properties);
			schemasA[appSchemaIdx] = schema;
		});

		return schemasA;
	}

	static extend(schemas, schema) {
		if (schema.extends) {
			schema.extends
				// We'll filter out any schema that's prefix with a plugin name
				.filter((dependencyName) => dependencyName.indexOf(':') === -1)
				.forEach((dependencyName) => {
					const dependencyIdx = schemas.findIndex((s) => s.name === dependencyName);
					// This should be thrown when the user adds or updates the schema.
					if (dependencyIdx === -1) {
						throw new Helpers.Errors.SchemaInvalid(`Schema dependency ${dependencyName} for ${schema.name} missing.`);
					}
					const dependency = Schema.extend(schemas, schemas[dependencyIdx]);
					if (!dependency.properties) return; // Skip if dependency has no properties
					if (!schema.properties) schema.properties = {};
					schema.properties = Object.assign(schema.properties, dependency.properties);
				});
		}

		return schema;
	}

	static async createTimeSeriesSchema(schemaName, schemaProps, timeSeries = {}) {
		if (!schemaProps || Object.keys(schemaProps).length < 1) return false;

		for await (const prop of Object.keys(schemaProps)) {
			if (typeof schemaProps[prop] !== 'object') continue;
			if (schemaProps[prop].__type && schemaProps[prop].__type === 'array') continue;

			if (schemaProps[prop].__timeSeries) {
				if (!timeSeries[schemaProps[prop].__timeSeries]) {
					timeSeries[schemaProps[prop].__timeSeries] = {
						name: `${schemaName}-${schemaProps[prop].__timeSeries}`,
						type: 'collection',
						extends: [
							'timestamps',
						],
						properties: {
							entityId: {
								__type: 'string',
								__default: null,
								__required: true,
								__allowUpdate: false,
							},
						},
					};
				}
				const timesSeriesObj = Object.assign({}, schemaProps[prop]);
				delete timesSeriesObj.__timeSeries;
				timeSeries[schemaProps[prop].__timeSeries].properties[prop] = timesSeriesObj;
				continue;
			}

			if (!schemaProps[prop].__type) {
				await this.createTimeSeriesSchema(schemaName, schemaProps[prop], timeSeries);
			}
		}

		if (Object.keys(timeSeries).length < 1) return false;
		return timeSeries;
	}
}
module.exports = Schema;

