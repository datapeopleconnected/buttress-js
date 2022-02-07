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

const SchemaModel = require('../schemaModel');

/**
 * SchemaModelButtress
 */
class SchemaModelRemote extends SchemaModel {
	constructor(schemaData, app, local, remote) {
		super(schemaData, app);

		this.local = local;
		this.remote = remote;
	}

	/**
	 * @param {object} body
	 * @return {Promise}
	 */
	add(body) {
		// Seperate property updates

		return this.remote.add(body);
	}

	/**
	 * @param {object} details
	 * @param {string} id
	 * @return {Promise}
	 */
	update(details, id) {
		// Seperate local updates from remote

		return this.remote.update(details, id);
	}

	/**
	 * @param {string} id
	 * @return {Boolean}
	 */
	exists(id) {
		return this.remote.exists(id);
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
		return this.remote.rm(entity);
	}

	/**
	 * @param {array} ids
	 * @return {Promise}
	 */
	rmBulk(ids) {
		return this.remote.rmBulk(ids);
	}

	/**
	 * @param {object} query
	 * @return {Promise}
	 */
	rmAll(query) {
		return this.remote.rmAll(query);
	}

	/**
	 * @param {string} id
	 * @return {Promise}
	 */
	findById(id) {
		return this.remote.findById(id);
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
		const res = this.remote.find(query, excludes, stream, limit, skip, sort, project);

		console.log('DEBUG', typeof res);

		return res;
	}

	/**
	 * @return {Promise}
	 */
	findAll() {
		return this.remote.findAll();
	}

	/**
	 * @param {Array} ids - mongoDB query
	 * @return {Promise}
	 */
	findAllById(ids) {
		return this.remote.findAllById(ids);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise}
	 */
	count(query) {
		return this.remote.count(query);
	}
}

module.exports = SchemaModelRemote;
