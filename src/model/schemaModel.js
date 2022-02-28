'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file schemaModel.js
 * @description A default model for schemas
 * @module Model
 * @exports model, schema, constants
 * @author Chris Bates-Keegan
 *
 */

const Logging = require('../logging');
const Shared = require('./shared');
const Helpers = require('../helpers');
const shortId = require('../helpers').shortId;

const Sugar = require('sugar');

/* ********************************************************************************
 *
 * LOCALS
 *
 **********************************************************************************/

class SchemaModel {
	constructor(schemaData, app) {
		this.schemaData = schemaData;
		this.flatSchemaData = Helpers.getFlattenedSchema(this.schemaData);

		this.app = app || null;

		this.appShortId = (app) ? shortId(app._id) : null;
	}

	initAdapter(datastore) {
		if (datastore) {
			Logging.logSilly(`initAdapter ${this.schemaData.collection}`);
			this.adapter = datastore.adapter.cloneAdapterConnection();
			this.adapter.connect();
			this.adapter.setCollection(`${this.schemaData.collection}`);
		}
	}

	createId(id) {
		return this.adapter.createId(id);
	}

	__doValidation(body) {
		const res = {
			isValid: true,
			missing: [],
			invalid: [],
		};

		const app = Shared.validateAppProperties(this.schemaData, body);
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
		const output = {};

		for (let property in query) {
			if (!{}.hasOwnProperty.call(query, property)) continue;
			if (property === '__crPath') continue;
			const command = query[property];

			if (property === '$or' && Array.isArray(command) && command.length > 0) {
				output['$or'] = command.map((q) => this.parseQuery(q, envFlat, schemaFlat));
			} else if (property === '$and' && Array.isArray(command) && command.length > 0) {
				output['$and'] = command.map((q) => this.parseQuery(q, envFlat, schemaFlat));
			} else {
				for (let operator in command) {
					if (!{}.hasOwnProperty.call(command, operator)) continue;
					let operand = command[operator];
					let operandOptions = null;
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
					let propSchema = null;
					if (!schemaFlat[property] && property === 'id') {
						// Convert id -> _id to handle querying of document root index without having to pass _id
						property = '_id';
						propSchema = {
							__type: 'id',
						};
					} else if (schemaFlat[property]) {
						propSchema = schemaFlat[property];
					} else {
						// TODO: Should maybe reject query
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
				}
			}
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
			authUserId: token._user,
		};

		const tasks = [];

		if (roles.schema.authFilter.env) {
			for (const property in roles.schema.authFilter.env) {
				if (!{}.hasOwnProperty.call(roles.schema.authFilter.env, property)) continue;
				const query = roles.schema.authFilter.env[property];

				let propertyMap = '_id';
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

						tasks.push(() => {
							const rxsResult = collection.find(propertyQuery, fields);

							return new Promise((resolve) => {
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
			entity._id = this.adapter.createId(body.id);
		}

		if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
			entity.createdAt = Sugar.Date.create();
			entity.updatedAt = (body.updatedAt) ? Sugar.Date.create(body.updatedAt) : null;
		}

		const validated = Shared.applyAppProperties(this.schemaData, body);

		return Object.assign(validated, entity);
	}
	add(body, internals) {
		return this.adapter.add(body, (item) => this.__parseAddBody(item, internals));
	}

	/**
	 * @param {*} query
	 * @param {*} update
	 * @return {promise}
	 */
	update(query, update) {
		return this.adapter.update(query, update);
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
	 * @return {promise}
	 */
	async updateByPath(body, id) {
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

		return await body.reduce(async (prev, update) => {
			const arr = await prev;
			const config = flattenedSchema === false ? false : flattenedSchema[update.path];
			return arr.concat([
				await this.adapter.batchUpdateProcess(id, update, extendedPathContext[update.contextPath], config),
			]);
		}, Promise.resolve([]));
	}

	/**
	 * @param {*} id
	 * @param {*} extra
	 * @return {Promise}
	 */
	exists(id, extra = {}) {
		return this.adapter.exists(id, extra);
	}

	/**
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	isDuplicate() {
		return this.adapter.isDuplicate();
	}

	/**
	 * @param {string} id - id to be deleted
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rm(id) {
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
	find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		const test = this.adapter.find(query, excludes, limit, skip, sort, project);
		return test;
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

module.exports = SchemaModel;
