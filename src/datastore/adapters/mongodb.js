const ObjectId = require('mongodb').ObjectId;
const MongoClient = require('mongodb').MongoClient;

const Helpers = require('../../helpers');
const Logging = require('../../logging');

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
	}

	connect() {
		if (this.connection) return this.connection;

		// Remove the pathname as we'll selected the db using the client method
		const connectionString = this.uri.href.replace(this.uri.pathname, '');

		return MongoClient.connect(connectionString, this.options)
			.then((client) => this.connection = client.db(this.uri.pathname.replace(/\//g, '')));
	}

	cloneAdapterConnection() {
		return new MongodbAdapter(this.uri, this.options, this.connection);
	}

	setCollection(collectionName) {
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

	update(filter, update) {
		return new Promise((resolve, reject) => {
			this.collection.updateMany(filter, update, (err, object) => {
				if (err) return reject(new Error(err));

				resolve(object);
			});
		});
	}

	async batchUpdateProcess(id, body, context, schemaConfig) {
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

	updateById(id, query) {
		// Logging.logSilly(`update: ${this.collectionName} ${id} ${query}`);

		return new Promise((resolve, reject) => {
			this.collection.updateOne({_id: id}, {
				$set: query,
			}, (err, object) => {
				if (err) return reject(new Error(err));

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
	 * @param {String} id - entity id to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findById(id) {
		// Logging.logSilly(`Schema:findById: ${this.collectionName} ${id}`);

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
		Logging.logSilly(`find: ${this.collectionName} ${query}`);

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

		return this.find({});
	}

	/**
	 * @param {Array} ids - Array of entities ids to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAllById(ids) {
		// Logging.logSilly(`update: ${this.collectionName} ${ids}`);

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
