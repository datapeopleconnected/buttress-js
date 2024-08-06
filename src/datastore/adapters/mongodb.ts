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
import Stream from 'stream';
import {ObjectId, MongoClient, MongoClientOptions, Db, Collection, Document} from 'mongodb';

// The adapter shouldn't be making calls back out to the model, we're too deep.
import Model from '../../model';
import * as Helpers from '../../helpers';
import Logging from '../../helpers/logging';

import AbstractAdapter from '../abstract-adapter';

class AdapterId {
	static new(id: string) {
		return new ObjectId(id);
	}

	static isValid(id: string) {
		return ObjectId.isValid(id);
	}

	static instanceOf(id) {
		return id instanceof ObjectId;
	}
}

interface BJSDocument {
	[key: string]: any;
}

interface Context {
	[key: string]: any;
	type: string;
}

interface SchemaConfig {
	__schema: any;
}

export default class MongodbAdapter extends AbstractAdapter {

	private _client?: MongoClient;

	options?: MongoClientOptions;

	protected __connection?: Db;

	collection?: Collection;

	async connect() {
		if (this.__connection) return this.__connection;

		// Remove the pathname as we'll selected the db using the client method
		const connectionString = this.uri.href.replace(this.uri.pathname, '');

		this._client = await MongoClient.connect(connectionString, this.options || {});

		this.__connection = this._client.db(this.uri.pathname.replace(/\//g, ''));

		return this.__connection;
	}

	async close() {
		if (!this._client) return;
		try {
			await this._client.close();
		} catch (err: any) {
			console.error('Caught error while closing mongo connection');
			console.error(err);
		}
		delete this.__connection;
		delete this._client;
	}

	cloneAdapterConnection() {
		return new MongodbAdapter(this.uri, this.options, this.__connection);
	}

	async setCollection(collectionName: string) {
		if (!this.__connection) throw new Error('No connection');
		this.collection = this.__connection.collection(collectionName);
	}

	get ID() {
		return AdapterId;
	}

	add(body, modifier) {
		return this.__batchAddProcess(body, modifier);
	}

	async __batchAddProcess(body: BJSDocument[], modifier: any) {
		if (body instanceof Array === false) {
			body = [body];
		}

		const documents = await body.reduce(async (prev, item) => {
			const arr = await prev;
			return arr.concat([
				this._prepareDocumentForMongo(modifier(item)),
			]);
		}, Promise.resolve([]));

		const ops = documents.map((c: BJSDocument) => {
			return {insertOne: {document: c}};
		});

		if (ops.length < 1) return Promise.resolve([]);

		const res = await this.collection?.bulkWrite(ops);
		if (!res) throw new Error('Unable to bulk write');

		const readable = new Stream.Readable({objectMode: true});
		readable._read = () => {};

		// Lets merged the inserted ids back into the documents, previously we were
		// looking them up in the database again which is a waste of time.
		new Promise<void>((resolve) => setTimeout(() => {
			documents.forEach((document: any, idx: number) => {
				document._id = res.insertedIds[idx];
				readable.push(document);
			});
			readable.push(null);
			resolve();
		}, 1));

		return this._modifyDocumentStream(readable);
	}

	async batchUpdateProcess(id: string, body: {path: string, value: any}, context: Context, schemaConfig: SchemaConfig, model?: string) {
		if (!context) throw new Error(`batchUpdateProcess called without context; ${id}`);

		const updateType = context.type;
		let response: any = null;

		const ops: {updateOne: any}[] = [];

		switch (updateType) {
		default: {
			throw new Error(`Invalid update type: ${updateType}`);
		}
		case 'vector-add': {
			let value: any = null;
			if (schemaConfig && schemaConfig.__schema) {
				const fb = Helpers.Schema.getFlattenedBody(body.value);
				value = Helpers.Schema.sanitizeObject(schemaConfig.__schema, fb);
			} else {
				value = body.value;
			}

			if (!schemaConfig && model) {
				const entity = await Model.getModel(model).findById(id);
				const objValue: {[key: string]: any} = {};
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
			let value: any = null;
			if (schemaConfig && schemaConfig.__schema) {
				const fb = Helpers.Schema.getFlattenedBody(body.value);
				value = Helpers.Schema.sanitizeObject(schemaConfig.__schema, fb);
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

		const res = await this.collection?.bulkWrite(ops);
		if (!res) throw new Error('Unable to bulk write');

		return {
			type: updateType,
			path: body.path,
			value: response,
		};
	}

	async update(select: any, update: any) {
		const object = await this.collection?.updateMany(this._prepareQueryForMongo(select), update);
		return this._modifyDocument(object);
	}

	async updateOne(query: any, update: any) {
		const object = await this.collection?.updateOne(this._prepareQueryForMongo(query), update);
		return this._modifyDocument(object);
	}

	async updateById(id: string, query: any) {
		const object = await this.collection?.updateOne({_id: new ObjectId(id)}, query);

		return this._modifyDocument(object);
	}

	exists(id: string, extra = {}) {
		if (!this.collection) throw new Error('No collection');

		Logging.logSilly(`exists: ${this.collection.namespace} ${id}`);

		return this.collection?.countDocuments({
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
	 * @param {string} id - id to be deleted
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async rm(entity: any) {
		const cursor = this.collection?.deleteOne({_id: new ObjectId(entity._id)});
		if (!cursor) throw new Error('Unable to delete');

		return cursor;
	}

	/**
	 * @param {Array} ids - Array of entity ids to delete
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmBulk(ids: any) {
		// Logging.log(`rmBulk: ${this.collection.namespace} ${ids}`, Logging.Constants.LogLevel.SILLY);
		return this.rmAll({_id: {$in: ids}});
	}

	/*
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	async rmAll(query: any) {
		if (!query) query = {};

		const doc = await this.collection?.deleteMany(this._prepareQueryForMongo(query));
		if (!doc) throw new Error('Unable to deleteMany');

		return doc;
	}

	/**
	 * @param {String} id - entity id to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	async findById(id: string) {
		// Logging.logSilly(`Schema:findById: ${this.collection.namespace} ${id}`);

		const document = await this.collection?.findOne({_id: new ObjectId(id)}, {});
		if (!document) throw new Error('Unable to find document');

		return this._modifyDocument(document);
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
	find(query:any, excludes = {}, limit = 0, skip = 0, sort: any = null, project = null) {
		if (!this.collection) throw new Error('No collection');

		if (Logging.level === Logging.Constants.LogLevel.SILLY) {
			Logging.logSilly(`find: ${this.collection.namespace} query: ${JSON.stringify(query)}, excludes: ${excludes}`+
				`limit: ${limit}, skip: ${skip}, sort: ${JSON.stringify(sort)}`);
		}

		let results = this.collection.find(this._prepareQueryForMongo(query), excludes)
			.skip(skip)
			.limit(limit)
			.sort(sort);

		if (project) {
			results = results.project(project);
		}

		return this._modifyDocumentStream(results.stream());
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @return {Promise} - resolves to an array of docs
	 */
	async findOne(query: any, excludes = {}) {
		const doc = await this.collection?.findOne(this._prepareQueryForMongo(query), this._prepareQueryForMongo(excludes));

		return (doc) ? this._modifyDocument(doc) : null;
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
	findAllById(ids: string[]) {
		// Logging.logSilly(`update: ${this.collection.namespace} ${ids}`);

		return this.find({_id: {$in: ids.map((id) => new ObjectId(id))}}, {});
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - resolves to an array of Companies
	 */
	count(query: any) {
		return this.collection?.countDocuments(this._prepareQueryForMongo(query));
	}

	/**
	 * @return {Promise}
	 */
	async drop() {
		try {
			const res = await this.collection?.drop();
			if (!res) throw new Error('Unable to drop');

			return true;
		} catch (err: any) {
			if (err.code === 26) return true; // NamespaceNotFound

			throw err;
		}
	}

	// Modify a straem of docuemnts, converting _id to id
	_modifyDocument(doc: any) {
		if (doc && doc._id) {
			doc.id = doc._id;
			delete doc._id;
		}

		return doc;
	}
	_modifyDocumentStream(stream: Stream.Readable) {
		const transformStream = new Stream.Transform({
			objectMode: true,
			transform: (doc, enc, cb) => cb(null, this._modifyDocument(doc)),
		});

		return stream.pipe(transformStream);
	}

	// Methods for modifying a document or query to handle converting from id to _id
	_prepareDocumentForMongo(document: any) {
		if (document && document.id) {
			document._id = document.id;
			delete document.id;
		}
		return document;
	}
	_prepareQueryForMongo(query: any) {
		if (!query) return query;

		if (query.id) {
			query._id = this._convertIdValue(query.id);
			delete query.id;
		} else if (query['$or'] || query['$and']) {
			if (query['$or']) {
				query['$or'] = query['$or'].map((q: any) => this._prepareQueryForMongo(q));
			} else if (query['$and']) {
				query['$and'] = query['$and'].map((q: any) => this._prepareQueryForMongo(q));
			}
		}

		return query;
	}

	/**
	 * Handling converting part of an expression to a object id.
	 * @param {object | string} expression
	 * @return {object | string}
	 */
	_convertIdValue(expression) {
		if (typeof expression === 'object' && !(expression instanceof ObjectId)) {
			const keys = Object.keys(expression);
			if (keys.length === 1) {
				const [key] = keys;
				const value = this._getExpressionValue(expression[key]);
				return {[key]: value};
			} else {
				// Not sure what we've got here.
				Logging.logDebug(JSON.stringify(expression));
				throw new Error('Unknown expression in query.');
			}
		}

		// It's not an object, so must be a value.
		return new ObjectId(expression);
	}

	/**
	 * Handling getting a value of an expression and converting it to object id.
	 * @param {array | string} value
	 * @return {array | string}
	 */
	_getExpressionValue(value) {
		if (Array.isArray(value)) {
			return (value.length > 0) ? value.map((v) => new ObjectId(v)) : value;
		} else {
			return new ObjectId(value);
		}
	}
};
