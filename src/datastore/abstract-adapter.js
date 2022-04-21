const {Errors} = require('../helpers');

module.exports = class AbstractAdapter {
	constructor(uri, options, connection = null) {
		this.uri = uri;
		this.options = options;

		this.requiresFormalSchema = false;

		this.connection = connection;

		this.collection = null;
	}

	cloneAdapterConnection() {
		throw new Errors.NotYetImplemented('cloneAdapterConnection');
	}

	setCollection(collectionName) {
		throw new Errors.NotYetImplemented('setCollection');
	}

	updateSchema(schemaData) {
		if (!this.requiresFormalSchema) return;

		throw new Errors.NotYetImplemented('updateSchema');
	}

	get ID() {
		throw new Errors.NotYetImplemented('get ID');
	}

	add(body, modifier) {
		throw new Errors.NotYetImplemented('add');
	}

	async batchUpdateProcess(id, body, context, schemaConfig) {
		throw new Errors.NotYetImplemented('batchUpdateProcess');
	}

	updateById(id, query) {
		throw new Errors.NotYetImplemented('updateById');
	}

	exists(id, extra = {}) {
		throw new Errors.NotYetImplemented('exists');
	}

	/*
	* @return {Promise} - returns a promise that is fulfilled when the database request is completed
	*/
	isDuplicate(details) {
		throw new Errors.NotYetImplemented('isDuplicate');
	}

	/**
	 * @param {App} entity - entity object to be deleted
	 */
	rm(entity) {
		throw new Errors.NotYetImplemented('rm');
	}

	/**
	 * @param {Array} ids - Array of entity ids to delete
	 */
	rmBulk(ids) {
		throw new Errors.NotYetImplemented('rmBulk');
	}

	/*
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmAll(query) {
		throw new Errors.NotYetImplemented('rmAll');
	}

	/**
	 * @param {String} id - entity id to get
	 */
	findById(id) {
		throw new Errors.NotYetImplemented('findById');
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @param {Int} limit - should return a stream
	 * @param {Int} skip - should return a stream
	 * @param {Object} sort - mongoDB sort object
	 * @param {Boolean} project - mongoDB project ids
	 */
	find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		throw new Errors.NotYetImplemented('find');
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 */
	findOne(query, excludes = {}) {
		throw new Errors.NotYetImplemented('findOnedd');
	}

	/**
	 */
	findAll() {
		throw new Errors.NotYetImplemented('findAll');
	}

	/**
	 * @param {Array} ids - Array of entities ids to get
	 */
	findAllById(ids) {
		throw new Errors.NotYetImplemented('findAllById');
	}

	/**
	 * @param {Object} query - mongoDB query
	 */
	count(query) {
		throw new Errors.NotYetImplemented('count');
	}

	/**
	 */
	drop() {
		throw new Errors.NotYetImplemented('drop');
	}
};
