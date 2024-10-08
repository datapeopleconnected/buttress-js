'use strict';

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
import Sugar from 'sugar';

import Logging from '../../helpers/logging';
import * as Helpers from '../../helpers';

import * as Shared from '../shared';
import NRP from 'node-redis-pubsub';

/* ********************************************************************************
 *
 * LOCALS
 *
 **********************************************************************************/

export default class StandardModel {
	schemaData: any;
	flatSchemaData: any;

	app: any;

	appShortId: any;
	collectionName: any;

	__services: any;
	__nrp?: NRP.NodeRedisPubSub;
	__modelManager: any;

	adapter: any;

	constructor(schemaData, app, services) {
		this.schemaData = schemaData;
		this.flatSchemaData = (schemaData) ? Helpers.getFlattenedSchema(this.schemaData) : null;

		this.app = app || null;

		this.appShortId = (app) ? Helpers.shortId(app.id) : null;
		this.collectionName = (schemaData) ? `${schemaData.name}` : null;

		if (this.appShortId) {
			this.collectionName = `${this.appShortId}-${this.collectionName}`;
		}

		this.__services = services;

		this.__nrp = services.get('nrp');
		if (!this.__nrp) throw new Error('Unable to find nrp in services');

		this.__modelManager = this.__services.get('modelManager');
		if (!this.__modelManager) throw new Error('Unable to find modelManager in services');

		if (schemaData.core) {
			this.__nrp.on('app:update-schema', (data: any) => {
				data = JSON.parse(data);
				if (!app || (app.id.toString() !== data.appId)) return;

				data.schemas.forEach((schema) => {
					if (schema.name !== this.schemaData.name) return;

					this.schemaData = schema;
				});
			});
		}
	}

	async initAdapter(datastore) {
		if (datastore) {
			Logging.logSilly(`initAdapter ${this.schemaData.name}`);
			this.adapter = datastore.adapter.cloneAdapterConnection();
			await this.adapter.connect();
			await this.adapter.setCollection(this.collectionName);
			await this.adapter.updateSchema(this.schemaData);
		}
	}

	createId(id?: string) {
		return this.adapter.ID.new(id);
	}

	__doValidation(body) {
		const res: {
			isValid: boolean;
			missing: string[];
			invalid: string[];
		} = {
			isValid: true,
			missing: [],
			invalid: [],
		};

		const app = Shared.validateSchemaObject(this.schemaData, body);
		if (app.isValid === false) {
			res.isValid = false;
			res.invalid = res.invalid.concat(app.invalid);
			res.missing = res.missing.concat(app.missing);
		}

		return res;
	}
	validate(body) {
		if (body instanceof Array === false) {
			body = [body];
		}
		const validation = body.map((b) => this.__doValidation(b)).filter((v) => v.isValid === false);

		return validation.length >= 1 ? validation[0] : {isValid: true};
	}

	/**
	 * @param {object} query
	 * @param {object} [envFlat={}]
	 * @param {object} [schemaFlat={}]
	 * @return {object} query
	 */
	parseQuery(query, envFlat = {}, schemaFlat = {}) {
		let output = {};

		for (const property in query) {
			if (!{}.hasOwnProperty.call(query, property)) continue;
			if (property === '__crPath') continue;
			const command = query[property];

			if (property === '$or' && Array.isArray(command)) {
				if (command.length > 0) {
					output['$or'] = command.map((q) => this.parseQuery(q, envFlat, schemaFlat));
				}
			} else if (property === '$and' && Array.isArray(command)) {
				if (command.length > 0) {
					output['$and'] = command.map((q) => this.parseQuery(q, envFlat, schemaFlat));
				}
			} else if (typeof command === 'object') {
				for (let operator in command) {
					if (!{}.hasOwnProperty.call(command, operator)) continue;
					const operand = command[operator];
					let operandOptions: string | undefined = undefined;

					switch (operator) {
					case '$not':
						operator = '$ne';
						break;

					case '$elMatch':
						operator = '$elemMatch';
						break;
					case '$gtDate':
						operator = '$gt';
						break;
					case '$ltDate':
						operator = '$lt';
						break;
					case '$gteDate':
						operator = '$gte';
						break;
					case '$lteDate':
						operator = '$lte';
						break;

					case '$rex':
					case '$rexi':
						operator = '$regex';
						operandOptions = 'i';
						break;
					case '$inProp':
						operator = '$regex';
						break;

					default:
						// TODO: Throw an error if operator isn't supported
					}

					output = this.parseQueryProperty(property, operator, operand, operandOptions, output, envFlat, schemaFlat);
				}
			} else {
				// Direct compare
				output = this.parseQueryProperty(property, '$eq', command, null, output, envFlat, schemaFlat);
			}
		}

		return output;
	}

	parseQueryProperty(property, operator, operand, operandOptions?, output = {}, envFlat = {}, schemaFlat = {}) {
		// Check to see if operand is a path and fetch value
		if (operand && operand.indexOf && operand.indexOf('.') !== -1) {
			let path = operand.split('.');
			const key = path.shift();

			path = path.join('.');

			if (key === 'env' && envFlat[path]) {
				operand = envFlat[path];
			} else {
				// throw new Error(`Unable to find ${path} in schema.authFilter.env`);
			}
		}

		// Convert id
		let propSchema: any = undefined;
		if (schemaFlat[property]) {
			propSchema = schemaFlat[property];
		} else if (Object.keys(schemaFlat).length > 0) {
			// throw new Helpers.Errors.RequestError(400, `unknown property ${property} in query`);
		}

		if (operator === '$elemMatch' && propSchema && propSchema.__schema) {
			operand = this.parseQuery(operand, envFlat, propSchema.__schema);
		} else if (propSchema) {
			if (propSchema.__type === 'array' && propSchema.__schema) {
				Object.keys(operand).forEach((op) => {
					if (propSchema.__schema[op].__type === 'id') {
						Object.keys(operand[op]).forEach((key) => {
							operand[op][key] = this.createId(operand[op][key]);
						});
					}
				});
			}

			if (propSchema.__type === 'date' && typeof operand === 'string') {
				operand = new Date(operand);
			}

			if ((propSchema.__type === 'id' || propSchema.__itemtype === 'id') && typeof operand === 'string') {
				operand = this.createId(operand);
			}
			if ((propSchema.__type === 'id' || propSchema.__itemtype === 'id') && Array.isArray(operand)) {
				operand = operand.map((o) => this.createId(o));
			}
		}

		if (!output[property]) {
			output[property] = {};
		}

		if (operandOptions) {
			output[property][`$options`] = operandOptions;
		}

		if (operator.indexOf('$') !== 0) {
			output[property][`$${operator}`] = operand;
		} else {
			output[property][`${operator}`] = operand;
		}

		return output;
	}

	/**
	 * @param {stirng} token
	 * @param {*} roles
	 * @param {*} Model
	 * @return {Promise}
	 */
	generateRoleFilterQuery(token, roles, Model) {
		if (!roles.schema || !roles.schema.authFilter) {
			return Promise.resolve({});
		}

		const env = {
			authUserId: token._userId,
		};

		const tasks: Function[] = [];

		if (roles.schema.authFilter.env) {
			for (const property in roles.schema.authFilter.env) {
				if (!{}.hasOwnProperty.call(roles.schema.authFilter.env, property)) continue;
				const query = roles.schema.authFilter.env[property];

				let propertyMap = 'id';
				if (query.map) {
					propertyMap = query.map;
				}
				for (const command in query) {
					if (!{}.hasOwnProperty.call(query, command)) continue;

					if (command.includes('schema.')) {
						const commandPath = command.split('.');
						commandPath.shift(); // Remove "schema"
						const collectionName = commandPath.shift();
						const collectionPath = `${this.appShortId}-${collectionName}`;
						const collection = Model[collectionPath];

						if (!collection) {
							throw new Error(`Unable to find a collection named ${collectionName} while building authFilter.env`);
						}

						const propertyPath = commandPath.join('.');

						let propertyQuery = {};
						propertyQuery[propertyPath] = query[command];
						propertyQuery = this.parseQuery(propertyQuery, env);

						const fields = {};
						fields[propertyPath] = true;

						tasks.push(async () => {
							const rxsResult = await collection.find(propertyQuery, fields);

							return new Promise<void>((resolve) => {
								if (!env[property]) env[property] = [];

								rxsResult.on('data', (res) => {
									// Map fetched properties into a array.
									env[property].push(res[propertyMap]);
									// Hack - Flattern any sub arrays down to the single level.
									env[property] = [].concat(...env[property]);
								});
								rxsResult.once('end', () => resolve());
							});
						});
					} else {
						// Unknown operation
					}
				}
			}
		}

		// Engage.
		return tasks.reduce((prev, task) => prev.then(() => task()), Promise.resolve())
			.then(() => this.parseQuery(roles.schema.authFilter.query, env, this.flatSchemaData));
	}

	/*
	* @param {Object} body - body passed through from a POST request
	* @return {Promise} - returns a promise that is fulfilled when the database request is completed
	*/
	__parseAddBody(body, internals) {
		const entity = Object.assign({}, internals);

		if (body.id) {
			entity.id = this.adapter.ID.new(body.id);
		} else {
			entity.id = this.adapter.ID.new();
		}

		if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
			entity.createdAt = Sugar.Date.create();
			entity.updatedAt = (body.updatedAt) ? Sugar.Date.create(body.updatedAt) : null;
		}

		return Object.assign(Shared.sanitizeSchemaObject(this.schemaData, body), entity);
	}
	add(body, internals?: any) {
		return this.adapter.add(body, (item) => this.__parseAddBody(item, internals));
	}

	/**
	 * @param {*} select
	 * @param {*} update
	 * @return {promise}
	 */
	update(select, update) {
		return this.adapter.update(select, update);
	}

	/**
	 * @param {*} query
	 * @param {*} update
	 * @return {promise}
	 */
	updateOne(query, update) {
		return this.adapter.updateOne(query, update);
	}

	/**
	 * @param {*} id
	 * @param {*} query
	 * @return {promise}
	 */
	updateById(id, query) {
		return this.adapter.updateById(id, query);
	}

	/**
	 * @param {object} body
	 * @return {promise}
	 */
	validateUpdate(body) {
		const sharedFn = Shared.validateUpdate({}, this.schemaData);
		return sharedFn(body);
	}

	/**
	 * @param {object} body
	 * @param {string} id
	 * @param {string} sourceId
	 * @param {string} model
	 * @return {promise}
	 */
	// TODO: Model shouldn't be being passed through this way.
	async updateByPath(body, id, sourceId = null, model = null) {
		if (body instanceof Array === false) {
			body = [body];
		}

		if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
			body.push({
				path: 'updatedAt',
				value: new Date(),
				contextPath: '^updatedAt$',
			});
		}

		// const schema = __getCollectionSchema(collectionName);
		const flattenedSchema = this.schemaData ? Helpers.getFlattenedSchema(this.schemaData) : false;
		const extendedPathContext = Shared.extendPathContext({}, flattenedSchema, '');

		// TODO: This isn't processing updates in a batch
		return await body.reduce(async (prev, update) => {
			const arr = await prev;
			let config = flattenedSchema === false ? false : flattenedSchema[update.path];
			if (!config && flattenedSchema) {
				config = flattenedSchema[update.path.replace(/\.\d+/g, '')];
			}

			// If we're doing a vector-add operation but the user has provided an array as the value then we want to
			// update the whole property.
			let context = extendedPathContext[update.contextPath];
			if (context.type === 'vector-add' && Array.isArray(body.value)) {
				context = {type: 'scalar', values: []};
			}

			return arr.concat([
				await this.adapter.batchUpdateProcess(id, update, context, config, model),
			]);
		}, Promise.resolve([]));
	}

	/**
	 * @param {string} id
	 * @param {string} sourceId
	 * @param {object} extra
	 * @return {Promise}
	 */
	exists(id, sourceId = null, extra = {}) {
		return this.adapter.exists(id, extra);
	}

	/**
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	isDuplicate(details) {
		return this.adapter.isDuplicate(details);
	}

	/**
	 * @param {string} id - id to be deleted
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rm(id: string) {
		return this.adapter.rm(id);
	}

	/**
	 * @param {Array} ids - Array of entity ids to delete
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmBulk(ids) {
		return this.adapter.rmBulk(ids);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmAll(query) {
		return this.adapter.rmAll(query);
	}

	/**
	 * @param {String} id - entity id to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findById(id) {
		return this.adapter.findById(id);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @param {Int} limit - should return a stream
	 * @param {Int} skip - should return a stream
	 * @param {Object} sort - mongoDB sort object
	 * @param {Boolean} project - mongoDB project ids
	 * @return {ReadableStream} - stream
	 */
	find(query, excludes?: any, limit?: number, skip?: number, sort?: any, project?: any) {
		return this.adapter.find(query, excludes, limit, skip, sort, project);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @return {Promise} - resolves to an array of docs
	 */
	findOne(query, excludes = {}) {
		return this.adapter.findOne(query, excludes);
	}

	/**
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAll() {
		return this.adapter.findAll();
	}

	/**
	 * @param {Array} ids - Array of entities ids to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findByIds(ids) {
		return this.adapter.findAllById(ids);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - resolves to an array of Companies
	 */
	count(query) {
		return this.adapter.count(query);
	}

	/**
	 * @return {Promise}
	 */
	drop() {
		return this.adapter.drop();
	}
}