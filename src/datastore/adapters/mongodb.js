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

const ObjectId = require('mongodb').ObjectId;
const MongoClient = require('mongodb').MongoClient;

const Model = require('../../model');
const Helpers = require('../../helpers');
const Logging = require('../../helpers/logging');

const AbstractAdapter = require('../abstract-adapter');

class AdapterId {
	static new(id) {
		return new ObjectId(id);
	}

	static isValid(id) {
		return ObjectId.isValid(id);
	}
}

module.exports = class MongodbAdapter extends AbstractAdapter {
	constructor(uri, options, connection = null) {
		super(uri, options, connection);

		this._client = null;
	}

	async connect() {
		if (this.connection) return this.connection;

		// Remove the pathname as we'll selected the db using the client method
		const connectionString = this.uri.href.replace(this.uri.pathname, '');

		this._client = await MongoClient.connect(connectionString, this.options);

		return this.connection = this._client.db(this.uri.pathname.replace(/\//g, ''));
	}

	async close() {
		if (!this._client) return;
		this._client.close();
	}

	cloneAdapterConnection() {
		return new MongodbAdapter(this.uri, this.options, this.connection);
	}

	async setCollection(collectionName) {
		this.collection = this.connection.collection(collectionName);
	}

	get ID() {
		return AdapterId;
	}

	add(body, modifier) {
		return this.__batchAddProcess(body, modifier);
	}

	async __batchAddProcess(body, modifier) {
		if (body instanceof Array === false) {
			body = [body];
		}

		const documents = await body.reduce(async (prev, item) => {
			const arr = await prev;
			return arr.concat([
				await modifier(item),
			]);
		}, Promise.resolve([]));

		const ops = documents.map((c) => {
			return {
				insertOne: {
					document: c,
				},
			};
		});

		// return await new Promise((resolve, reject) => {
		if (ops.length < 1) return Promise.resolve([]);

		const res = await this.collection.bulkWrite(ops);

		const insertedIds = Object.values(res.insertedIds).map((id) => new ObjectId(id));

		return this.find({_id: {$in: insertedIds}});
	}

	async batchUpdateProcess(id, body, context, schemaConfig, model = '') {
		if (!context) {
			throw new Error(`batchUpdateProcess called without context; ${id}`);
		}

		const updateType = context.type;
		let response = null;

		const ops = [];

		switch (updateType) {
		default: {
			throw new Error(`Invalid update type: ${updateType}`);
		}
		case 'vector-add': {
			let value = null;
			if (schemaConfig && schemaConfig.__schema) {
				const fb = Helpers.Schema.getFlattenedBody(body.value);
				value = Helpers.Schema.populateObject(schemaConfig.__schema, fb);
			} else {
				value = body.value;
			}

			if (!schemaConfig && model) {
				const entity = await Model[model].findById(id);
				const objValue = {};
				let updateValueExists = true;
				let modifiedPath = '';
				let basePath = body.path;
				let obj = entity;

				body.path.split('.').forEach((key) => {
					modifiedPath = (modifiedPath) ? key : `${modifiedPath}.${key}`;
					if (!obj[key]) {
						basePath = basePath.replace(`.${key}`, '');
						updateValueExists = false;
						if (!Number(key) && Number(key) !== 0) {
							objValue[key] = value;
						}
						return;
					}

					obj = obj[key];
				}, entity);

				if (!updateValueExists) {
					body.path = basePath;
					value = objValue;
				}
			}

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$push: {
							[body.path]: value,
						},
					},
				},
			});
			response = value;
		} break;
		case 'vector-rm': {
			const params = body.path.split('.');
			params.splice(-1, 1);
			const rmPath = params.join('.');
			const index = params.pop();
			body.path = params.join('.');

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$unset: {
							[rmPath]: null,
						},
					},
				},
			});
			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$pull: {
							[body.path]: null,
						},
					},
				},
			});

			response = {numRemoved: 1, index: index};
		} break;
		case 'scalar': {
			let value = null;
			if (schemaConfig && schemaConfig.__schema) {
				const fb = Helpers.Schema.getFlattenedBody(body.value);
				value = Helpers.Schema.populateObject(schemaConfig.__schema, fb);
			} else {
				value = body.value;
			}

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$set: {
							[body.path]: value,
						},
					},
				},
			});

			response = value;
		} break;
		case 'scalar-increment': {
			const params = body.path.split('.');
			params.splice(-1, 1);
			const path = params.join('.');

			ops.push({
				updateOne: {
					filter: {_id: new ObjectId(id)},
					update: {
						$inc: {
							[path]: body.value,
						},
					},
				},
			});

			response = body.value;
		} break;
		}

		return new Promise((resolve, reject) => {
			if (!ops.length) throw new Error('Aargh');

			this.collection.bulkWrite(ops, (err, res) => {
				if (err) return reject(err);

				resolve({
					type: updateType,
					path: body.path,
					value: response,
				});
			});
		});
	}

	update(select, update) {
		return new Promise((resolve, reject) => {
			this.collection.updateMany(select, update, (err, object) => {
				if (err) return reject(new Error(err));

				resolve(object);
			});
		});
	}

	updateOne(query, update) {
		return new Promise((resolve, reject) => {
			this.collection.updateOne(query, update, (err, object) => {
				if (err) return reject(new Error(err));

				resolve(object);
			});
		});
	}

	updateById(id, query) {
		// Logging.logSilly(`updateById: ${id} ${query}`);

		return new Promise((resolve, reject) => {
			this.collection.updateOne({_id: id}, query, (err, object) => {
				if (err) return reject(new Error(err));

				resolve(object);
			});
		});
	}

	exists(id, extra = {}) {
		Logging.logSilly(`exists: ${this.collection.namespace} ${id}`);

		return this.collection.countDocuments({
			_id: new ObjectId(id),
			...extra,
		})
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
		// Logging.log(`rmBulk: ${this.collection.namespace} ${ids}`, Logging.Constants.LogLevel.SILLY);
		return this.rmAll({_id: {$in: ids}});
	}

	/*
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmAll(query) {
		if (!query) query = {};
		// Logging.logSilly(`rmAll: ${this.collection.namespace} ${query}`);

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
		// Logging.logSilly(`Schema:findById: ${this.collection.namespace} ${id}`);

		if (id instanceof ObjectId === false) {
			id = new ObjectId(id);
		}

		return this.collection.findOne({_id: id}, {});
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
		if (Logging.level === Logging.Constants.LogLevel.SILLY) {
			Logging.logSilly(`find: ${this.collection.namespace} query: ${JSON.stringify(query)}, excludes: ${excludes}`+
				`limit: ${limit}, skip: ${skip}, sort: ${JSON.stringify(sort)}`);
		}

		let results = this.collection.find(query, excludes)
			.skip(skip)
			.limit(limit)
			.sort(sort);

		if (project) {
			results = results.project(project);
		}

		return results.stream();
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @return {Promise} - resolves to an array of docs
	 */
	findOne(query, excludes = {}) {
		// Logging.logSilly(`findOne: ${this.collection.namespace} ${query}`);

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
		// Logging.logSilly(`findAll: ${this.collection.namespace}`);

		return this.find({});
	}

	/**
	 * @param {Array} ids - Array of entities ids to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAllById(ids) {
		// Logging.logSilly(`update: ${this.collection.namespace} ${ids}`);

		return this.find({_id: {$in: ids.map((id) => new ObjectId(id))}}, {});
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
};
