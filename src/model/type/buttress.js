'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file buttress.js
 * @description A default model for schemas
 * @module Model
 * @exports model, schema, constants
 * @author Lighten
 *
 */

// const Buttress = require('@buttress/api');

const SchemaModel = require('../schemaModel');

/* ********************************************************************************
 *
 * LOCALS
 *
 **********************************************************************************/

class SchemaModelButtress extends SchemaModel {
	constructor() {
		throw new Error('THIS CLASS IS TO BE USED NO MORE, DOWN THIS THIS SORT OF THING');
	}

	resolveAfterInit() {
		if (this.init) return Promise.resolve();
		return new Promise((resolve) => {
			this.initPendingResolve.push(resolve);
		});
	}

	/**
	 * @param {object} body
	 * @return {Promise}
	 */
	add(body) {
		return this.resolveAfterInit()
			.then(() => this.collection.save(body));
	}

	/**
	 * @param {object} id
	 * @param {string} details
	 * @return {Promise}
	 */
	update(id, details) {
		return this.resolveAfterInit()
			.then(() => this.collection.update(id, details));
	}

	/**
	 * @param {string} id
	 * @return {Boolean}
	 */
	exists(id) {
		return this.resolveAfterInit()
			.then(() => this.collection.get(id))
			.then((res) => (res) ? true : false);
	}

	/**
	 * @param {object} details
	 * @throws Error
	 */
	isDuplicate(details) {
		throw new Error('not yet implemented');
	}

	/**
	 * @param {object} entity
	 * @return {Promise}
	 */
	rm(entity) {
		return this.resolveAfterInit()
			.then(() => this.collection.remove(entity._id));
	}

	/**
	 * @param {array} ids
	 * @return {Promise}
	 */
	rmBulk(ids) {
		return this.resolveAfterInit()
			.then(() => this.collection.bulkRemove(ids));
	}

	/**
	 * @param {object} query
	 * @return {Promise}
	 */
	rmAll(query) {
		return this.resolveAfterInit()
			.then(() => this.collection.removeAll(query));
	}

	/**
	 * @param {string} id
	 * @return {Promise}
	 */
	findById(id) {
		return this.resolveAfterInit()
			.then(() => this.collection.get(id));
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @param {Int} limit - should return a stream
	 * @param {Int} skip - should return a stream
	 * @param {Object} sort - mongoDB sort object
	 * @param {Boolean} project - mongoDB project ids
	 * @return {Promise} - resolves to an array of docs
	 */
	find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		// Logging.logSilly(`find: ${this.collectionName} ${query}`);

		// Stream this?
		return this.resolveAfterInit()
			.then(() => this.collection.search(query, limit, skip, sort, {project}));
	}

	/**
	 * @return {Promise}
	 */
	findAll() {
		return this.resolveAfterInit()
			.then(() => this.collection.getAll());
	}

	/**
	 * @param {Array} ids - mongoDB query
	 * @return {Promise}
	 */
	findAllById(ids) {
		return this.resolveAfterInit()
			.then(() => this.collection.bulkGet(ids));
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise}
	 */
	count(query) {
		return this.resolveAfterInit()
			.then(() => this.collection.count(query));
	}
}

module.exports = SchemaModelButtress;
