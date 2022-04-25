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

const ObjectId = require('mongodb').ObjectId;
const ButtressAPI = require('@buttress/api');

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

		// this.init = false;
		// this.initPendingResolve = [];

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

		// this.collection = this.buttress.getCollection(collection);
		// this.setCollection(this.uri.pathname.replace(/\//g, ''));
		this.init = true;
		// this.initPendingResolve.forEach((r) => r());
	}

	cloneAdapterConnection() {
		return new Buttress(this.uri, this.options, this.connection);
	}

	async setCollection(collectionName) {
		this.collection = this.connection.getCollection(collectionName);
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

	/**
	 * @param {object} body
	 * @return {Promise}
	 */
	add(body) {
		return this.resolveAfterInit()
			.then(() => this.collection.save(body));
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
			.then(() => this.collection.search(query, limit, skip, sort, {
				project,
				stream: true,
			}));
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

	/**
	 * @return {Promise}
	 */
	drop() {
		return this.resolveAfterInit()
			.then(() => this.collection.removeAll());
	}
};
