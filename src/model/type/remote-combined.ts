'use strict';

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

const Helpers = require('../../helpers');
const StandardModel = require('./standard');
const RemoteModel = require('./remote');

/**
 * @class RemoteCombinedModel
 */
class RemoteCombinedModel extends StandardModel {
	constructor(schemaData, app, services) {
		super(schemaData, app, services);

		// This is reference to a copy of the model in our local datastore.
		this.localModel = null;

		this.remoteModels = [];

		this._sdsRouting = services.get('sdsRouting');
	}

	async initAdapter(localDataStore, remoteDatastores) {
		if (localDataStore) {
			this.localModel = new StandardModel(this.schemaData, this.app, this.__services);

			// this.localModel.adapter = localDataStore.adapter.cloneAdapterConnection();
			await this.localModel.initAdapter(localDataStore);
			// await this.localModel.adapter.connect();
			// await this.localModel.adapter.setCollection(`${this.schemaData.name}`);
			// await this.localModel.adapter.updateSchema(this.schemaData);
		}

		for await (const remoteDatastore of remoteDatastores) {
			const model = new RemoteModel(this.schemaData, this.app, remoteDatastore.dataSharingId, this.__services);

			// TODO: handle a model which is unable to connect.
			model.adapter = remoteDatastore.adapter.cloneAdapterConnection();

			// We want api call to return a stream directly without any tampering.
			model.adapter.returnPausedStream = true;

			await model.adapter.connect();
			await model.adapter.setCollection(`${this.schemaData.name}`);

			// TODO: this shouldn't be necessary when using a standard model.
			if (model.adapter.getSchema) {
				const remoteSchemas = await model.adapter.getSchema(false, [this.schemaData.name]);
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

	async _getTargetModel(sourceId) {
		if (!sourceId || sourceId === this.app.id.toString()) return this.localModel;

		const dataSharingId = await this._sdsRouting.get(this.app.id.toString(), sourceId);
		if (dataSharingId) {
			const model = this.remoteModels.find((remoteModel) => remoteModel.dataSharingId.toString() === dataSharingId);
			if (!model) {
				throw new Error('Unable to find remote model');
			}

			return model;
		}
	}

	/**
	 * @param {object} body
	 * @return {Promise}
	 */
	async add(body) {
		return (await this._getTargetModel(body.sourceId)).add(body);
	}

	/**
	 * @param {object} details
	 * @param {string} id
	 * @param {string} sourceId
	 * @return {Promise}
	 */
	async update(details, id, sourceId) {
		return (await this._getTargetModel(sourceId)).updateById(id, details);
	}

	/**
	 * @param {object} body
	 * @param {string} id
	 * @param {string} sourceId
	 * @return {promise}
	 */
	async updateByPath(body, id, sourceId) {
		return (await this._getTargetModel(sourceId)).updateByPath(body, id);
	}

	/**
	 * @param {string} id
	 * @param {string} sourceId
	 * @return {Boolean}
	 */
	async exists(id, sourceId) {
		return (await this._getTargetModel(sourceId)).exists(id);
	}

	/**
	 * @param {object} details
	 * @param {string} sourceId
	 * @return {Boolean}
	 */
	async isDuplicate(details, sourceId) {
		return (await this._getTargetModel(sourceId)).isDuplicate(details);
		// // Make a call to each api, if any return true then return true.
		// const calls = this.remoteModels.map((remoteModel) => remoteModel.isDuplicate(details));
		// const results = await Promise.all(calls);
		// return results.some((result) => result);
	}

	/**
	 * @param {object} entity
	 * @param {string} sourceId
	 * @return {Promise}
	 */
	async rm(entity, sourceId) {
		return await this._getTargetModel(sourceId).rm(entity.id);
	}

	/**
	 * @param {array} ids
	 * @return {Promise}
	 */
	async rmBulk(ids) {
		return this.localModel.rmBulk(ids);
	}

	/**
	 * @param {array} query
	 * @return {Promise}
	 */
	async rmAll(query) {
		return this.localModel.rmAll(query);
	}

	/**
	 * @param {string} id
	 * @param {string} sourceId
	 * @return {Promise}
	 */
	async findById(id, sourceId) {
		return await this._getTargetModel(sourceId).findById(id);
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
	async find(query, excludes = {}, limit = 0, skip = 0, sort = {}, project = null) {
		const sortMap = new Map(Object.entries(sort));
		if (sortMap.size < 1) sortMap.set('id', 1);

		// Make a call out to each of the remotes, and merge the streams into on single stream.
		const sources = [];

		sources.push(await this.localModel.find(query, excludes, limit, skip, sort, project));

		for await (const remote of this.remoteModels) {
			sources.push(await remote.find(query, excludes, limit, skip, sort, project));
		}

		const combinedStream = new Helpers.Stream.SortedStreams(sources, (a, b) => Helpers.compareByProps(sortMap, a, b), limit);

		// When a chunk is sent, we'll inform the routing service of the sourceId.
		// We're always expecting the first source to be the local model.
		combinedStream.on('chunkSent', (data) => {
			return (data.sourceIdx > 0) ? this._sdsRouting.inform(this.app.id.toString(), data.chunk.sourceId,
				this.remoteModels[data.sourceIdx - 1].dataSharingId.toString()) : null;
		});

		return combinedStream;
	}

	/**
	 * @return {Promise}
	 */
	async findAll() {
		// Make a call out to each of the remotes, and merge the streams into on single stream.
		const sources = [];

		for await (const remote of this.remoteModels) {
			sources.push(await remote.findAll());
		}

		const combinedStream = new Helpers.Stream.SortedStreams(sources);

		// When a chunk is sent, we'll inform the routing service of the sourceId.
		combinedStream.on('chunkSent', (data) =>
			this._sdsRouting.inform(this.app.id.toString(), data.chunk.sourceId, this.remoteModels[data.sourceIdx].dataSharingId.toString()));

		return combinedStream;
	}

	/**
	 * @param {Array} ids - mongoDB query
	 * @return {Promise}
	 * @deprecated - use find
	 */
	findAllById(ids) {
		return this.remote.findAllById(ids);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise}
	 */
	async count(query) {
		// Make a call out to each of the remotes, and merge the streams into on single stream.
		const sourceReqs = [];

		for await (const remote of this.remoteModels) {
			sourceReqs.push(await remote.count(query));
		}

		return (await Promise.all(sourceReqs)).reduce((acc, val) => acc + val, 0);
	}

	/**
	 * @return {Promise}
	 */
	async drop() {
		return await this.localModel.drop();
	}
}

module.exports = RemoteCombinedModel;
