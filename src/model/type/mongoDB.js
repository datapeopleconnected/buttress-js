'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file mongoDB.js
 * @description A default model for schemas
 * @module Model
 * @exports model, schema, constants
 * @author Chris Bates-Keegan
 *
 */

const ObjectId = require('mongodb').ObjectId;
const Sugar = require('sugar');

const Logging = require('../../logging');

const Shared = require('../shared');
const SchemaModel = require('../schemaModel');

/* ********************************************************************************
 *
 * LOCALS
 *
 **********************************************************************************/

class SchemaModelMongoDB extends SchemaModel {
	constructor(MongoDb, schemaData, app) {
		super(schemaData, app);

		this.collectionName = `${schemaData.collection}`;

		if (this.appShortId) {
			this.collectionName = `${this.appShortId}-${this.collectionName}`;
		}

		this.collection = MongoDb.collection(this.collectionName);
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

	exists(id, extra = {}) {
		Logging.logSilly(`exists: ${this.collectionName} ${id}`);

		return this.collection.find({
			_id: new ObjectId(id),
			...extra,
		})
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
	 * @param {String} query - a query that contains an entity id to get
	 * @param {Boolean} project - mongoDB project ids
	 * @return {Promise} - resolves to an array of Companies
	 */
	findById(query, project = null) {
		// Logging.logSilly(`Schema:findById: ${this.collectionName} ${id}`);
		if (query instanceof ObjectId === true || typeof query !== 'object') {
			query = {_id: query}
		}

		if (query._id instanceof ObjectId === false) {
			query._id = new ObjectId(query._id);
		}

		return this.collection.findOne(query, {projection: project});
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
		Logging.logSilly(`find: ${this.collectionName} ${query}`);
		if (stream) {
			let results = this.collection.find(query, excludes).skip(skip).limit(limit).sort(sort);

			if (project) {
				results = results.project(project);
			}

			return results;
		}

		// return new Promise((resolve) => {
		return this.collection.find(query, excludes)
			.skip(skip)
			.limit(limit)
			.sort(sort)
			.project(project);
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
	 * @param {Boolean} project - mongoDB project ids
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAllById(ids, project) {
		// Logging.logSilly(`update: ${this.collectionName} ${ids}`);

		return this.collection
			.find({_id: {$in: ids.map((id) => new ObjectId(id))}}, {})
			.project(project);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - resolves to an array of Companies
	 */
	count(query) {
		return this.collection.countDocuments(query);
	}

	/**
	 * @return {Promise}
	 */
	drop() {
		return this.collection.drop()
			.catch((err) => {
				if (err.code === 26) return true; // NamespaceNotFound

				throw err;
			});
	}
}

module.exports = SchemaModelMongoDB;
