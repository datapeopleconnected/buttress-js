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
import { URL } from 'url';
import { Errors } from '../helpers';

export default class AbstractAdapter {
	uri: URL;
	options?: unknown;
	requiresFormalSchema: boolean;
	protected __connection?: unknown;
	collection?: unknown;

	constructor(uri: URL, options: unknown, connection?: unknown) {
		this.uri = uri;
		this.options = options;

		this.requiresFormalSchema = false;

		this.__connection = connection;

		this.collection = null;
	}

	cloneAdapterConnection() {
		throw new Errors.NotYetImplemented('cloneAdapterConnection');
	}

	setCollection(collectionName: string) {
		throw new Errors.NotYetImplemented('setCollection');
	}

	updateSchema(schemaData: unknown) {
		if (!this.requiresFormalSchema) return;

		throw new Errors.NotYetImplemented('updateSchema');
	}

	get ID(): unknown {
		throw new Errors.NotYetImplemented('get ID');
	}

	add(body: unknown, modifier: unknown) {
		throw new Errors.NotYetImplemented('add');
	}

	async batchUpdateProcess(id: string, body: unknown, context: unknown, schemaConfig: unknown): Promise<unknown> {
		throw new Errors.NotYetImplemented('batchUpdateProcess');
	}

	updateById(id: string, query: unknown) {
		throw new Errors.NotYetImplemented('updateById');
	}

	updateOne(query: unknown, update: unknown) {
		throw new Errors.NotYetImplemented('updateOne');
	}

	exists(id: string, extra = {}) {
		throw new Errors.NotYetImplemented('exists');
	}

	/*
	* @return {Promise} - returns a promise that is fulfilled when the database request is completed
	*/
	isDuplicate(details: unknown) {
		throw new Errors.NotYetImplemented('isDuplicate');
	}

	/**
	 * @param {App} id - id of the object to be deleted
	 */
	rm(id: unknown) {
		throw new Errors.NotYetImplemented('rm');
	}

	/**
	 * @param {Array} ids - Array of entity ids to delete
	 */
	rmBulk(ids: unknown) {
		throw new Errors.NotYetImplemented('rmBulk');
	}

	/*
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmAll(query: unknown) {
		throw new Errors.NotYetImplemented('rmAll');
	}

	/**
	 * @param {String} id - entity id to get
	 */
	findById(id: unknown) {
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
	find(query: unknown, excludes = {}, limit = 0, skip = 0, sort = null, project = null) {
		throw new Errors.NotYetImplemented('find');
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 */
	findOne(query: unknown, excludes = {}) {
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
	findAllById(ids: string[]) {
		throw new Errors.NotYetImplemented('findAllById');
	}

	/**
	 * @param {Object} query - mongoDB query
	 */
	count(query: unknown) {
		throw new Errors.NotYetImplemented('count');
	}

	/**
	 */
	drop() {
		throw new Errors.NotYetImplemented('drop');
	}
};
