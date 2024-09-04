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

import Stream from 'node:stream';
import {ObjectId} from 'bson';
import ButtressAPI, {Errors as BAPIErrors} from '@buttress/api';

import Errors from '../../helpers/errors';
import {parseJsonArrayStream} from '../../helpers/stream';
import Logging from '../../helpers/logging';

import AbstractAdapter from '../abstract-adapter';

class AdapterId {
	static new(id: string) {
		return new ObjectId(id);
	}

	static isValid(id: string) {
		return ObjectId.isValid(id);
	}

	static instanceOf(id: string | ObjectId) {
		return id instanceof ObjectId;
	}
}

export default class Buttress extends AbstractAdapter {
	init: boolean;
	initPendingResolve: Function[];

	protected __connection: any;

	collection: any;

	constructor(uri, options, connection = null) {
		super(uri, options, connection);

		this.__connection = ButtressAPI.new();

		this.init = false;
		this.initPendingResolve = [];
	}

	async connect() {
		if (this.init) return this.__connection;

		const protocol = this.uri.protocol === 'butts:' ? 'https' : 'http';

		await this.__connection.init({
			buttressUrl: `${protocol}://${this.uri.host}`,
			appToken: this.uri.searchParams.get('token'),
			apiPath: this.uri.pathname,
		});
		Logging.logDebug(`connected to: ${this.uri.host}${this.uri.pathname}`);

		// this.collection = this.buttress.getCollection(collection);
		// this.setCollection(this.uri.pathname.replace(/\//g, ''));
		this.init = true;
		this.initPendingResolve.forEach((r) => r());
	}

	cloneAdapterConnection() {
		return new Buttress(this.uri, this.options, this.__connection);
	}

	async close() {
		// TODO: Handle closing down socket connections??
		this.__connection = null;
		this.init = false;
		this.initPendingResolve = [];
	}

	async setCollection(collectionName: string) {
		try {
			this.collection = this.__connection.getCollection(collectionName);
		} catch (err: unknown) {
			if (err instanceof BAPIErrors.SchemaNotFound) throw new Errors.SchemaNotFound((err).message);
			else throw err;
		}
	}

	async getSchema(rawSchema = false, only = []) {
		await this.resolveAfterInit();
		return await this.__connection.App.getSchema(rawSchema, {
			params: {
				only: only.join(','),
			},
		});
	}

	async activateDataSharing(registrationToken, newToken) {
		await this.resolveAfterInit();
		return await this.__connection.AppDataSharing.activate(registrationToken, newToken);
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

	handleResult(result: Stream.Readable | any) {
		if (result instanceof Stream.Readable && result.readable) {
			// Stream will be an array of objects, parse them out.
			return result.pipe(parseJsonArrayStream());
		}

		return result;
	}

	async batchUpdateProcess(id, body) {
		await this.resolveAfterInit();
		const result = await this.collection.update(id, body);
		return this.handleResult(result);
	}

	/**
	 * @param {object} body
	 * @return {Promise}
	 */
	async add(body) {
		body = this.convertBSONObjects(body);
		await this.resolveAfterInit();

		const result = (Array.isArray(body)) ? await this.collection.bulkSave(body, {stream: true}) :
			await this.collection.save(body, {stream: true});

		return this.handleResult(result);
	}

	/**
	 * @param {string} id
	 * @return {Boolean}
	 */
	async exists(id) {
		id = this.convertBSONObjects(id);
		await this.resolveAfterInit();
		const result = await this.collection.get(id);
		return (result) ? true : false;
	}

	/**
	 * @param {object} details
	 * @return {Promise}
	 */
	isDuplicate() {
		return Promise.resolve(false);
	}

	/**
	 * @param {string} id
	 * @return {Promise}
	 */
	async rm(id: string) {
		// entity = this.convertBSONObjects(entity);
		await this.resolveAfterInit();
		const result = await this.collection.remove(id);
		return this.handleResult(result);
	}

	/**
	 * @param {array} ids
	 * @return {Promise}
	 */
	async rmBulk(ids) {
		ids = this.convertBSONObjects(ids);
		await this.resolveAfterInit();
		const result = await this.collection.bulkRemove(ids);
		return this.handleResult(result);
	}

	/**
	 * @param {object} query
	 * @return {Promise}
	 */
	async rmAll(query) {
		await this.resolveAfterInit();
		const result = await this.collection.removeAll(query);
		return this.handleResult(result);
	}

	/**
	 * @param {string} id
	 * @return {Promise}
	 */
	async findById(id) {
		id = this.convertBSONObjects(id);
		await this.resolveAfterInit();
		const result = await this.collection.get(id);
		return this.handleResult(result);
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
	async findAllById(ids) {
		ids = this.convertBSONObjects(ids);
		await this.resolveAfterInit();
		const result = await this.collection.bulkGet(ids);
		return this.handleResult(result);
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise}
	 */
	async count(query) {
		query = this.convertBSONObjects(query);
		await this.resolveAfterInit();
		const result = await this.collection.count(query);
		return this.handleResult(result);
	}

	/**
	 * @return {Promise}
	 */
	async drop() {
		await this.resolveAfterInit();
		const result = await this.collection.removeAll();
		return this.handleResult(result);
	}
};
