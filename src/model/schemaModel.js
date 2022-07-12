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
const Helpers = require('../helpers');
const shortId = require('../helpers').shortId;

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
	 * @static
	 * @param {object} query
	 * @param {object} [envFlat={}]
	 * @param {object} [schemaFlat={}]
	 * @return {object} query
	 */
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
						propertyQuery = SchemaModel.parseQuery(propertyQuery, env);

						const fields = {};
						fields[propertyPath] = true;

						tasks.push(() => {
							const result = collection.find(propertyQuery, fields);

							if (Helpers.isCursor(result)) {
								const stream = result.clone().stream();

								return new Promise((resolve) => {
									stream.on('data', (res) => {
										if (!env[property]) env[property] = [];
										// Map fetched properties into a array.
										env[property].push(res[propertyMap]);
										// Hack - Flattern any sub arrays down to the single level.
										env[property] = [].concat(...env[property]);
									});
									stream.once('end', () => resolve());
								});
							}

							return result.then((res) => {
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

	/**
	 * @throws Error
	 */
	add() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	update() {
		throw new Error('not yet implemented');
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

	/**
	 * @throws Error
	 */
	exists() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	isDuplicate() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	rm() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	rmBulk() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	rmAll() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	findById() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	find() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	findOne() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	findAll() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	findAllById() {
		throw new Error('not yet implemented');
	}

	/**
	 * @throws Error
	 */
	count() {
		throw new Error('not yet implemented');
	}
}

module.exports = SchemaModel;
