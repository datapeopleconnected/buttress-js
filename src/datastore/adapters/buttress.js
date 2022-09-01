'use strict';

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

const Stream = require('stream');
const JSONStream = require('JSONStream');
const ObjectId = require('mongodb').ObjectId;
const ButtressAPI = require('@buttress/api');

const {Errors} = require('../../helpers');
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

module.exports = class Buttress extends AbstractAdapter {
	constructor(uri, options, connection = null) {
		super(uri, options, connection);

		this.connection = ButtressAPI.new();

		// console.log(uri, options, connection);

		// eslint-disable-next-line no-unused-vars
		// const [_, collection] = schemaData.remote.split('.');

		// this.endpoint = dataSharing.remoteApp.endpoint;
		// this.token = dataSharing.remoteApp.token;
		// this.apiPath = dataSharing.remoteApp.apiPath;

		// this.buttress = ButtressAPI.new();

		// // Hack - Give a little time for another instance to get up to speed
		// // before trying to init

		this.init = false;
		this.initPendingResolve = [];

		// // TOOD: Handle the case we're another instance isn't available
		// setTimeout(() => {
		// 	this.buttress.init({
		// 		buttressUrl: this.endpoint,
		// 		appToken: this.token,
		// 		apiPath: this.apiPath,
		// 		allowUnauthorized: true, // WUT!?
		// 	})
		// 		.then(() => {
		// 			this.collection = this.buttress.getCollection(collection);
		// 			this.init = true;
		// 			this.initPendingResolve.forEach((r) => r());
		// 		});
		// }, 500);
	}

	async connect() {
		if (this.init) return this.connection;

		await this.connection.init({
			buttressUrl: `https://${this.uri.host}`,
			appToken: this.uri.searchParams.get('token'),
			apiPath: this.uri.pathname,
			allowUnauthorized: true, // WUT!?
		});
		Logging.logDebug(`connected to: ${this.uri.host}${this.uri.pathname}`);

		// this.collection = this.buttress.getCollection(collection);
		// this.setCollection(this.uri.pathname.replace(/\//g, ''));
		this.init = true;
		this.initPendingResolve.forEach((r) => r());
	}

	cloneAdapterConnection() {
		return new Buttress(this.uri, this.options, this.connection);
	}

	async setCollection(collectionName) {
		try {
			this.collection = this.connection.getCollection(collectionName);
		} catch (err) {
			if (err instanceof ButtressAPI.Errors.SchemaNotFound) throw new Errors.SchemaNotFound(err.message);
			else throw err;
		}
	}

	async getSchema(only = []) {
		await this.resolveAfterInit();
		return await this.connection.App.getSchema({
			params: {
				only: only.join(','),
			},
		});
	}

	get ID() {
		return AdapterId;
	}

	resolveAfterInit() {
		if (this.init) return Promise.resolve();
		return new Promise((resolve) => {
			this.initPendingResolve.push(resolve);
		});
	}

	convertBSONObjects(target) {
		if (target instanceof ObjectId) {
			return target.toString();
		} else if (Array.isArray(target)) {
			return target.map((value) => this.convertBSONObjects(value));
		} else if (typeof target === 'object' && target !== null) {
			for (const key in target) {
				if (!{}.hasOwnProperty.call(target, key)) continue;
				target[key] = this.convertBSONObjects(target[key]);
			}
		}
		return target;
	}

	handleResult(result) {
		if (result instanceof Stream && result.readable) {
			return result.pipe(JSONStream.parse('.'));
		}

		return result;
	}

	async batchUpdateProcess(id, body) {
		await this.resolveAfterInit();
		return await this.collection.update(id, body);
	}

	/**
	 * @param {object} body
	 * @return {Promise}
	 */
	add(body) {
		body = this.convertBSONObjects(body);
		return this.resolveAfterInit()
			.then(() => {
				if (Array.isArray(body)) {
					return this.collection.bulkSave(body);
				}

				return this.collection.save(body);
			});
	}

	/**
	 * @param {string} id
	 * @return {Boolean}
	 */
	exists(id) {
		id = this.convertBSONObjects(id);
		return this.resolveAfterInit()
			.then(() => this.collection.get(id))
			.then((res) => (res) ? true : false);
	}

	/**
	 * @param {object} details
	 * @return {Promise}
	 */
	isDuplicate() {
		return Promise.resolve(false);
	}

	/**
	 * @param {object} entity
	 * @return {Promise}
	 */
	rm(entity) {
		entity = this.convertBSONObjects(entity);
		return this.resolveAfterInit()
			.then(() => this.collection.remove(entity._id));
	}

	/**
	 * @param {array} ids
	 * @return {Promise}
	 */
	rmBulk(ids) {
		ids = this.convertBSONObjects(ids);
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
		id = this.convertBSONObjects(id);
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
	async find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		// Logging.logSilly(`find: ${this.collectionName} ${query}`);
		query = this.convertBSONObjects(query);

		// Stream this?
		await this.resolveAfterInit();
		const result = await this.collection.search(query, limit, skip, sort, {
			project,
			stream: true,
		});

		return this.handleResult(result);
	}

	/**
	 * @return {Promise}
	 */
	async findAll() {
		await this.resolveAfterInit();
		const result = await this.collection.getAll();
		return this.handleResult(result);
	}

	/**
	 * @param {Array} ids - mongoDB query
	 * @return {Promise}
	 */
	findAllById(ids) {
		ids = this.convertBSONObjects(ids);
		return this.resolveAfterInit()
			.then(() => this.collection.bulkGet(ids));
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise}
	 */
	count(query) {
		query = this.convertBSONObjects(query);
		return this.resolveAfterInit()
			.then(() => this.collection.count(query));
	}

	/**
	 * @return {Promise}
	 */
	drop() {
		return this.resolveAfterInit()
			.then(() => this.collection.removeAll());
	}
};
