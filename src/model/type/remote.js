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

const Helpers = require('../../helpers');
const SchemaModel = require('../schemaModel');

/**
 * SchemaModelButtress
 */
class SchemaModelRemote extends SchemaModel {
	constructor(schemaData, app, local, remote, nrp) {
		super(schemaData, app, nrp);

		this.local = local;
		this.remote = remote;
	}

	async initAdapter(localDataStore, remoteDatastore) {
		if (localDataStore) {
			this.local.adapter = localDataStore.adapter.cloneAdapterConnection();
			await this.local.adapter.connect();
			await this.local.adapter.setCollection(`${this.schemaData.name}`);
			await this.local.adapter.updateSchema(this.schemaData);
		}
		if (remoteDatastore) {
			this.remote.adapter = remoteDatastore.adapter.cloneAdapterConnection();
			await this.remote.adapter.connect();
			await this.remote.adapter.setCollection(`${this.schemaData.name}`);
		}

		// Compile remote schema
		if (this.remote.adapter.getSchema) {
			const remoteSchemas = await this.remote.adapter.getSchema([this.schemaData.name]);
			if (remoteSchemas && remoteSchemas.length > 0) {
				delete this.schemaData.remote;
				this.schemaData = Helpers.mergeDeep(this.schemaData, remoteSchemas.pop());
			}
		}
	}

	createId(id) {
		return this.remote.adapter.ID.new(id);
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

		return this.remote.updateById(id, details);
	}

	/**
	 * @param {object} body
	 * @param {string} id
	 * @return {promise}
	 */
	updateByPath(body, id) {
		return this.remote.updateByPath(body, id);
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
	 * @return {Boolean}
	 */
	isDuplicate(details) {
		return this.remote.isDuplicate(details);
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
	 * @param {Int} limit - should return a stream
	 * @param {Int} skip - should return a stream
	 * @param {Object} sort - mongoDB sort object
	 * @param {Boolean} project - mongoDB project ids
	 * @return {Promise} - resolves to an array of docs
	 */
	find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		return this.remote.find(query, excludes, limit, skip, sort, project);
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

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise}
	 */
	drop() {
		return this.local.drop();
	}
}

module.exports = SchemaModelRemote;
