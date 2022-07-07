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

const ObjectId = require('mongodb').ObjectId;
// const Logging = require('../logging');
const Shared = require('./shared');
const Sugar = require('sugar');
const Helpers = require('../helpers');
const shortId = require('../helpers').shortId;

/* ********************************************************************************
 *
 * LOCALS
 *
 **********************************************************************************/

class SchemaModel {
	constructor(MongoDb, schemaData, app) {
		this.schemaData = schemaData;
		this.flatSchemaData = Helpers.getFlattenedSchema(this.schemaData);

		this.app = app || null;

		this.appShortId = (app) ? shortId(app._id) : null;
		this.collectionName = `${schemaData.collection}`;

		if (this.appShortId) {
			this.collectionName = `${this.appShortId}-${this.collectionName}`;
		}

		this.collection = MongoDb.collection(this.collectionName);
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

	static parseQuery(query, envFlat = {}, schemaFlat = {}) {
		const output = {};

		for (let property in query) {
			if (!{}.hasOwnProperty.call(query, property)) continue;
			if (property === '__crPath') continue;
			const command = query[property];

			if (property === '$or' && Array.isArray(command) && command.length > 0) {
				output['$or'] = command.map((q) => SchemaModel.parseQuery(q, envFlat, schemaFlat));
			} else if (property === '$and' && Array.isArray(command) && command.length > 0) {
				output['$and'] = command.map((q) => SchemaModel.parseQuery(q, envFlat, schemaFlat));
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
						const path = property.split('.');
						let lastVal = schemaFlat;
						path.forEach((p) => {
							if (lastVal[p] && lastVal[p].__type === 'array' && lastVal[p].__schema) {
								lastVal = lastVal[p].__schema;
							} else if (lastVal[p]) {
								lastVal = lastVal[p];
							} else {
								lastVal = null;
							}
						});

						if (lastVal) propSchema = lastVal;
					}

					if (operator === '$elemMatch' && propSchema && propSchema.__schema) {
						operand = SchemaModel.parseQuery(operand, envFlat, propSchema.__schema);
					} else if (propSchema) {
						if (propSchema.__type === 'array' && propSchema.__schema) {
							Object.keys(operand).forEach((op) => {
								if (propSchema.__schema[op].__type === 'id') {
									Object.keys(operand[op]).forEach((key) => {
										operand[op][key] = new ObjectId(operand[op][key]);
									});
								}
							});
						}

						if (propSchema.__type === 'date' && typeof operand === 'string') {
							operand = new Date(operand);
						}

						if ((propSchema.__type === 'id' || propSchema.__itemtype === 'id') && typeof operand === 'string') {
							operand = new ObjectId(operand);
						}
						if ((propSchema.__type === 'id' || propSchema.__itemtype === 'id') && Array.isArray(operand)) {
							operand = operand.map((o) => new ObjectId(o));
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
						propertyQuery = SchemaModel.parseQuery(propertyQuery, env);

						const fields = {};
						fields[propertyPath] = true;

						tasks.push(() => {
							return collection.find(propertyQuery, fields)
								.then((res) => {
									// Map fetched properties into a array.
									env[property] = res.map((i) => i[propertyMap]);
									// Hack - Flattern any sub arrays down to the single level.
									env[property] = [].concat(...env[property]);
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
			.then(() => SchemaModel.parseQuery(roles.schema.authFilter.query, env, this.flatSchemaData));
	}

	/*
	* @param {Object} body - body passed through from a POST request
	* @return {Promise} - returns a promise that is fulfilled when the database request is completed
	*/
	__add(body, internals) {
		return (prev) => {
			const entity = Object.assign({}, internals);

			if (body.id) {
				entity._id = new ObjectId(body.id);
			}

			if (this.schemaData.extends && this.schemaData.extends.includes('timestamps')) {
				entity.createdAt = Sugar.Date.create();
				entity.updatedAt = (body.updatedAt) ? Sugar.Date.create(body.updatedAt) : null;
			}

			const validated = Shared.applyAppProperties(this.schemaData, body);
			return prev.concat([Object.assign(validated, entity)]);
		};
	}
	add(body, internals) {
		const sharedAddFn = Shared.add(this.collection, (item) => this.__add(item, internals));
		return sharedAddFn(body);
	}

	update(query, id) {
		// Logging.logSilly(`update: ${this.collectionName} ${id} ${query}`);

		return new Promise((resolve, reject) => {
			this.collection.updateOne({_id: id}, {
				$set: query,
			}, (err, object) => {
				if (err) throw new Error(err);

				resolve(object);
			});
		});
	}
	validateUpdate(body) {
		const sharedFn = Shared.validateUpdate({}, this.schemaData);
		return sharedFn(body);
	}
	updateByPath(body, id) {
		const sharedFn = Shared.updateByPath({}, this.schemaData, this.collection);

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

		return sharedFn(body, id);
	}

	exists(id) {
		// Logging.logSilly(`exists: ${this.collectionName} ${id}`);

		return this.collection.find({_id: new ObjectId(id)})
			.limit(1)
			.count()
			.then((count) => count > 0);
	}

	/*
	* @return {Promise} - returns a promise that is fulfilled when the database request is completed
	*/
	isDuplicate(details) {
		return Promise.resolve(false);
	}

	/**
	 * @param {App} entity - entity object to be deleted
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rm(entity) {
		// Logging.log(`DELETING: ${entity._id}`, Logging.Constants.LogLevel.DEBUG);
		return new Promise((resolve) => {
			this.collection.deleteOne({_id: new ObjectId(entity._id)}, (err, cursor) => {
				if (err) throw err;
				resolve(cursor);
			});
		});
	}

	/**
	 * @param {Array} ids - Array of entity ids to delete
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmBulk(ids) {
		// Logging.log(`rmBulk: ${this.collectionName} ${ids}`, Logging.Constants.LogLevel.SILLY);
		return this.rmAll({_id: {$in: ids}});
	}

	/*
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmAll(query) {
		if (!query) query = {};
		// Logging.logSilly(`rmAll: ${this.collectionName} ${query}`);

		return new Promise((resolve) => {
			this.collection.deleteMany(query, (err, doc) => {
				if (err) throw err;
				resolve(doc);
			});
		});
	}

	/**
	 * @param {String} id - entity id to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findById(id) {
		// Logging.logSilly(`Schema:findById: ${this.collectionName} ${id}`);

		if (id instanceof ObjectId === false) {
			id = new ObjectId(id);
		}

		return new Promise((resolve) => {
			this.collection.findOne({_id: id}, {}, (err, doc) => {
				if (err) throw err;
				resolve(doc);
			});
		});
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @param {Boolean} stream - should return a stream
	 * @param {Int} limit - should return a stream
	 * @param {Int} skip - should return a stream
	 * @param {Object} sort - mongoDB sort object
	 * @param {Boolean} project - mongoDB project ids
	 * @return {Promise} - resolves to an array of docs
	 */
	find(query, excludes = {}, stream = false, limit = 0, skip = 0, sort, project = null) {
		// Logging.logSilly(`find: ${this.collectionName} ${query}`);
		if (stream) {
			let results = this.collection.find(query, excludes).skip(skip).limit(limit).sort(sort);

			if (project) {
				results = results.project(project);
			}

			return results;
		}

		return new Promise((resolve) => {
			this.collection.find(query, excludes)
				.skip(skip)
				.limit(limit)
				.sort(sort)
				.toArray((err, doc) => {
					if (err) throw err;
					resolve(doc);
				});
		});
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @return {Promise} - resolves to an array of docs
	 */
	findOne(query, excludes = {}) {
		// Logging.logSilly(`findOne: ${this.collectionName} ${query}`);

		return new Promise((resolve) => {
			this.collection.find(query, excludes).toArray((err, doc) => {
				if (err) throw err;
				resolve(doc[0]);
			});
		});
	}

	/**
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAll() {
		// Logging.logSilly(`findAll: ${this.collectionName}`);

		return this.collection.find({});
	}

	/**
	 * @param {Array} ids - Array of entities ids to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAllById(ids) {
		// Logging.logSilly(`update: ${this.collectionName} ${ids}`);

		return this.collection.find({_id: {$in: ids.map((id) => new ObjectId(id))}}, {});
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - resolves to an array of Companies
	 */
	count(query) {
		return this.collection.countDocuments(query);
	}
}

module.exports = SchemaModel;
