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
const StandardModel = require('./standard');

/**
 * @class RemoteModel
 */
class RemoteModel extends StandardModel {
	constructor(schemaData, app, nrp) {
		super(schemaData, app, nrp);

		// This is reference to a copy of the model in our local datastore.
		this.localModel = null;

		this.remoteModels = [];
	}

	async initAdapter(localDataStore, remoteDatastores) {
		console.log('RemoteModel', 'initAdapter', this.schemaData.name, remoteDatastores.length);

		if (localDataStore) {
			this.localModel = new StandardModel(this.schemaData, this.app, this.__nrp);

			this.localModel.adapter = localDataStore.adapter.cloneAdapterConnection();
			await this.localModel.adapter.connect();
			await this.localModel.adapter.setCollection(`${this.schemaData.name}`);
			await this.localModel.adapter.updateSchema(this.schemaData);
		}

		for await (const remoteDatastore of remoteDatastores) {
			const model = new StandardModel(this.schemaData, this.app, this.__nrp);

			// TODO: handle a model which is unable to connect.
			model.adapter = remoteDatastore.adapter.cloneAdapterConnection();

			// We want api call to return a stream directly without any tampering.
			model.adapter.returnPausedStream = true;

			await model.adapter.connect();
			await model.adapter.setCollection(`${this.schemaData.name}`);

			// TODO: this shouldn't be nessasry when using a standard model.
			if (model.adapter.getSchema) {
				const remoteSchemas = await model.adapter.getSchema([this.schemaData.name]);
				if (remoteSchemas && remoteSchemas.length > 0) {
					delete this.schemaData.remotes;
					this.schemaData = Helpers.mergeDeep(this.schemaData, remoteSchemas.pop());
				}
			}

			this.remoteModels.push(model);
		}
	}

	createId(id) {
		// NOTE: This could be linked to the add problem, the Id will want to be created based
		// on the remote.
		return this.localModel.adapter.ID.new(id);
	}

	/**
	 * @param {object} body
	 * @return {Promise}
	 */
	add(body) {
		// TODO: local schema additional properties and save them locally.
		// - Changes which only involve properties form the local schema don't have to go out to the remote.

		// DISCISSION: How should we resolve the where a data entity should be pushed to?
		// - maybe there will be a field in the schema that specifics this?

		return this.localModel.add(body);
	}

	/**
	 * @param {object} details
	 * @param {string} id
	 * @return {Promise}
	 */
	update(details, id) {
		// TODO: local schema additional properties and save them locally.
		// - Changes which only involve properties form the local schema don't have to go out to the remote.

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
	async isDuplicate(details) {
		// Make a call to each api, if any return true then return true.
		const calls = this.remoteModels.map((remoteModel) => remoteModel.isDuplicate(details));
		const results = await Promise.all(calls);

		return results.some((result) => result);
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
	async find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		// Make a call out to each of the remotes, and merge the streams into on single stream.
		const sources = [];

		console.log(`REMOTE MODELS: ${this.remoteModels.length}`);

		for await (const remote of this.remoteModels) {
			sources.push(await remote.find(query, excludes, limit, skip, sort, project));
		}

		console.log(`SOURCES: ${sources.length}`);

		// TODO: investigate why only one stream is returning. Looks like we may have
		// missed the bus.

		return new Helpers.Stream.SortedStreams(sources, (a, b) => a - b, limit);
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
		return this.localModel.drop();
	}
}

module.exports = RemoteModel;
