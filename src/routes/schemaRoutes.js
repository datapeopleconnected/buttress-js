'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file schemaRoutes.js
 * @description A list of default routes for schema
 * @module routes
 * @author Chris Bates-Keegan
 *
 */

const Logging = require('../logging');
const Route = require('./route');
const Model = require('../model');
const Helpers = require('../helpers');
const Schema = require('../schema');
const SchemaModel = require('../model/schemaModel');
const ObjectId = require('mongodb').ObjectId;

const routes = [];

/**
 * @class GetList
 */
class GetList extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}`, `GET ${schema.name} LIST`);
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.LIST;

		this.activityDescription = `GET ${schema.name} LIST`;
		this.activityBroadcast = false;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		this.slowLogging = false;

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		Logging.logSilly(`Created route: ${this.name} for ${schemaCollection}`);

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		Logging.logTimer(`${this.name}:_validate:start`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
		let generateQuery = Promise.resolve({});
		if (token.authLevel < 3) {
			generateQuery = this.model.generateRoleFilterQuery(token, req.roles, Model);
		}

		const result = {
			query: {},
			project: (req.body && req.body.project)? req.body.project : false,
		};

		return generateQuery
			.then((query) => {
				if (!query.$and) {
					query.$and = [];
				}

				// access control query
				if (req.body && req.body.query) {
					query.$and.push(req.body.query);
				}

				if (req.body && req.body.query && req.body.query.zeroResults) {
					return false;
				}

				Logging.logTimer(`${this.name}:_validate:end`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
				return SchemaModel.parseQuery(query, {}, this.model.flatSchemaData);
			})
			.then((query) => {
				result.query = query;
				return result;
			});
	}

	_exec(req, res, validateResult) {
		if (validateResult.query === false) {
			return [];
		}

		Logging.logTimer(`${this.name}:_validate:start`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
		return this.model.find(validateResult.query, {}, true, 0, 0, {}, validateResult.project);
	}
}
routes.push(GetList);

/**
 * @class SearchList
 */
class SearchList extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}`, `SEARCH ${schema.name} LIST`);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.LIST;

		this.activityDescription = `SEARCH ${schema.name} LIST`;
		this.activityBroadcast = false;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`SearchList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		let generateQuery = Promise.resolve({});
		if (token.authLevel < 3) {
			generateQuery = this.model.generateRoleFilterQuery(token, req.roles, Model);
		}

		const result = {
			query: {},
			skip: (req.body && req.body.skip) ? parseInt(req.body.skip) : 0,
			limit: (req.body && req.body.limit) ? parseInt(req.body.limit) : 0,
			sort: (req.body && req.body.sort) ? req.body.sort : {},
			project: (req.body && req.body.project)? req.body.project : false,
		};

		return generateQuery
			.then((query) => {
				if (!query.$and) {
					query.$and = [];
				}

				// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
				if (req.body && req.body.query) {
					query.$and.push(req.body.query);
				}

				if (req.body && req.body.query && req.body.query.zeroResults) {
					return false;
				}

				return SchemaModel.parseQuery(query, {}, this.model.flatSchemaData);
			})
			.then((query) => {
				result.query = query;
				return result;
			});
	}

	_exec(req, res, validateResult) {
		if (validateResult.query === false) {
			return [];
		}

		return this.model.find(validateResult.query, {}, true,
			validateResult.limit, validateResult.skip, validateResult.sort, validateResult.project);
	}
}
routes.push(SearchList);

/**
 * @class Count
 */
class SearchCount extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/count`, `COUNT ${schema.name}`);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.SERACH;

		this.activityDescription = `COUNT ${schema.name}`;
		this.activityBroadcast = false;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`getCount Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		let generateQuery = Promise.resolve({});
		if (token.authLevel < 3) {
			generateQuery = this.model.generateRoleFilterQuery(token, req.roles, Model);
		}

		const result = {
			query: {},
		};

		return generateQuery
			.then((query) => {
				if (!query.$and) {
					query.$and = [];
				}

				// TODO: Vaildate this input against the schema, schema properties should be tagged with what can be queried
				if (req.body && req.body.query) {
					query.$and.push(req.body.query);
				} else if (req.body && !req.body.query) {
					query.$and.push(req.body);
				}

				if (req.body && req.body.query && req.body.query.zeroResults) {
					return false;
				}

				return SchemaModel.parseQuery(query, {}, this.model.flatSchemaData);
			})
			.then((query) => {
				result.query = query;
				return result;
			});
	}

	_exec(req, res, validateResult) {
		if (validateResult.query === false) {
			return 0;
		}

		return this.model.count(validateResult.query);
	}
}
routes.push(SearchCount);

/**
 * @class GetOne
 */
class GetOne extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/:id`, `GET ${schema.name}`);
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.READ;

		this.activityDescription = `GET ${schema.name}`;
		this.activityBroadcast = false;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			let objectId = null;
			const project = (req.body && req.body.project)? req.body.project : false;

			try {
				objectId = new ObjectId(req.params.id);
			} catch (err) {
				this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
			}

			const generateQuery = Promise.resolve({_id: objectId});
			return generateQuery
				.then((generateQuery) => {
					let query = generateQuery;
					if (req.body.query && Object.keys(req.body.query).length > 0) {
						query = req.body.query;

						query = SchemaModel.parseQuery(query, {}, this.model.flatSchemaData);
						query._id = objectId;
					}

					return query;
				})
				.then((query) => {
					this.model.findById(query, project)
						.then((entity) => {
							if (!entity) {
								this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
								return reject(new Helpers.Errors.RequestError(400, 'invalid_id or access_control_not_fullfilled'));
							}
							resolve(entity);
						});
				});
		});
	}

	_exec(req, res, entity) {
		return Promise.resolve(entity);
	}
}
routes.push(GetOne);

/**
 * @class GetMany
 */
class GetMany extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/bulk/load`, `BULK GET ${schema.name}`);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;

		this.activityDescription = `BULK GET ${schema.name}`;
		this.activityBroadcast = false;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const _ids = req.body.query.ids;
			const project = (req.body && req.body.project)? req.body.project : false;

			if (!_ids) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
			}
			if (!_ids.length) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
			}
			resolve({ids: _ids, project: project});
		});
	}

	_exec(req, res, query) {
		return this.model.findAllById(query.ids, query.project);
	}
}
routes.push(GetMany);

/**
 * @class AddOne
 */
class AddOne extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}`, `ADD ${schema.name}`);
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.ADD;

		this.activityDescription = `ADD ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const validation = this.model.validate(req.body);
			if (!validation.isValid) {
				if (validation.missing.length > 0) {
					this.log(`${this.schema.name}: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
				}
				if (validation.invalid.length > 0) {
					this.log(`${this.schema.name}: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
				}

				this.log(`${this.schema.name}: Unhandled Error`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Unhandled error.`));
			}

			this.model.isDuplicate(req.body)
				.then((res) => {
					if (res === true) {
						this.log(`${this.schema.name}: Duplicate entity`, Route.LogLevel.ERR, req.id);
						return reject(new Helpers.Errors.RequestError(400, `duplicate`));
					}
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return this.model.add(req.body);
	}
}
routes.push(AddOne);

/**
 * @class AddMany
 */
class AddMany extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/bulk/add`, `BULK ADD ${schema.name}`);
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.ADD;

		this.activityDescription = `BULK ADD ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const entities = req.body;
			if (entities instanceof Array === false) {
				this.log(`ERROR: You need to supply an array of ${this.schema.name}`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `array_required`));
			}
			// if (companies.length > 601) {
			//   this.log(`ERROR: No more than 300`, Route.LogLevel.ERR);
			//   reject({statusCode: 400, message: `Invalid data: send no more than 300 ${this.schema.name} at a time`});
			//   return;
			// }

			const validation = this.model.validate(entities);
			if (!validation.isValid) {
				if (validation.missing.length > 0) {
					this.log(`ERROR: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
				}
				if (validation.invalid.length > 0) {
					this.log(`ERROR: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
				}

				return reject(new Helpers.Errors.RequestError(400, `unknown_error`));
			}
			resolve(entities);
		});
	}

	_exec(req, res, entities) {
		return this.model.add(entities);
	}
}
routes.push(AddMany);

/**
 * @class UpdateOne
 */
class UpdateOne extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/:id`, `UPDATE ${schema.name}`);
		this.verb = Route.Constants.Verbs.PUT;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityDescription = `UPDATE ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}

		this._entity = null;
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const validation = this.model.validateUpdate(req.body);
			if (!validation.isValid) {
				if (validation.isPathValid === false) {
					this.log(`${this.schema.name}: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Update path is invalid: ${validation.invalidPath}`));
				}
				if (validation.isValueValid === false) {
					this.log(`${this.schema.name}: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR, req.id);
					if (validation.isMissingRequired) {
						return reject(new Helpers.Errors.RequestError(
							400,
							`${this.schema.name}: Missing required property updating ${req.body.path}: ${validation.missingRequired}`,
						));
					}

					return reject(new Helpers.Errors.RequestError(
						400,
						`${this.schema.name}: Update value is invalid for path ${req.body.path}: ${validation.invalidValue}`,
					));
				}
			}

			this.model.exists(req.params.id)
				.then((exists) => {
					if (!exists) {
						this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.id);
						return reject(new Helpers.Errors.RequestError(400, `invalid_id`));
					}
					resolve(true);
				});
		});
	}

	_exec(req, res, validate) {
		return this.model.updateByPath(req.body, req.params.id);
	}
}
routes.push(UpdateOne);

/**
 * @class UpdateMany
 */
class UpdateMany extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/bulk/update`, `BULK UPDATE ${schema.name}`);
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityDescription = `BULK UPDATE ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}

		this._entity = null;
	}

	_validate(req, res, token) {
		if (!Array.isArray(req.body)) {
			this.log(`${this.schema.name}: Expected body to be an array of updates`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Expected body to be an array of updates`));
		}

		// Reduce down duplicate entity updates into one object
		const data = req.body.reduce((reducedUpdates, update) => {
			const existing = reducedUpdates.find((u) => u.id === update.id);

			if (!existing) {
				reducedUpdates.push(update);
			} else {
				if (!Array.isArray(existing.body)) existing.body = [existing.body];
				if (!Array.isArray(update.body)) update.body = [update.body];
				existing.body = [...existing.body, ...update.body];
			}

			return reducedUpdates;
		}, []);

		return data.reduce((prev, update) => {
			return prev.then(() => {
				const validation = this.model.validateUpdate(update.body);
				if (!validation.isValid) {
					if (validation.isPathValid === false) {
						this.log(`${this.schema.name}: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR, req.id);
						return update.validation = {
							code: 400,
							message: `${this.schema.name}: Update path is invalid: ${validation.invalidPath}`,
						};
					}
					if (validation.isValueValid === false) {
						this.log(`${this.schema.name}: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR, req.id);
						if (validation.isMissingRequired) {
							return update.validation = {
								code: 400,
								message: `${this.schema.name}: Missing required property updating ${req.body.path}: ${validation.missingRequired}`,
							};
						}

						return update.validation = {
							code: 400,
							message: `${this.schema.name}: Update value is invalid for path ${req.body.path}: ${validation.invalidValue}`,
						};
					}
				}

				return this.model.exists(update.id)
					.then((exists) => {
						if (!exists) {
							this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.id);
							return update.validation = {
								code: 400,
								message: `${this.schema.name}: Missing required property updating ${req.body.path}: ${validation.missingRequired}`,
							};
						}

						return update.validation = true;
					});
			});
		}, Promise.resolve())
			.then(() => data);
	}

	_exec(req, res, data) {
		const output = [];
		return data.reduce(
			(prev, body) => prev
				.then(() => this.model.updateByPath(body.body, body.id))
				.then((result) => output.push({id: body.id, results: result})),
			Promise.resolve(),
		)
			.then(() => output);
	}
}
routes.push(UpdateMany);

/**
 * @class DeleteOne
 */
class DeleteOne extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/:id`, `DELETE ${schema.name}`);
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}

		this._entity = false;
	}

	_validate(req, res, token) {
		return this.model.findById(req.params.id)
			.then((entity) => {
				if (!entity) {
					this.log(`${this.schema.name}: Invalid ID`, Route.LogLevel.ERR, req.id);
					return {statusCode: 400};
				}
				this._entity = entity;
				return true;
			});
	}

	_exec(req, res, validate) {
		return this.model.rm(this._entity)
			.then(() => true);
	}
}
routes.push(DeleteOne);

/**
 * @class DeleteMany
 */
class DeleteMany extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/bulk/delete`, `BULK DELETE ${schema.name}`);
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `BULK DELETE ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			let ids = req.body;

			if (!ids) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `Requires ids`));
			}
			if (!ids.length) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `Expecting array of ids`));
			}

			try {
				ids = ids.map((id) => new ObjectId(id));
			} catch (err) {
				return reject(new Helpers.Errors.RequestError(400, `All ids must be string of 12 bytes or a string of 24 hex characters`));
			}

			// if (this._ids.length > 600) {
			//   this.log('ERROR: No more than 300 company IDs are supported', Route.LogLevel.ERR);
			//   reject({statusCode: 400, message: 'ERROR: No more than 300 company IDs are supported'});
			//   return;
			// }
			resolve(ids);
		});
	}

	_exec(req, res, ids) {
		return this.model.rmBulk(ids)
			.then(() => true);
	}
}
routes.push(DeleteMany);

/**
 * @class DeleteAll
 */
class DeleteAll extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}`, `DELETE ALL ${schema.name}`);
		this.verb = Route.Constants.Verbs.DEL;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE ALL ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.collection;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.collection}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`GetList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return Promise.resolve();
	}

	_exec(req, res, validate) {
		return this.model.rmAll()
			.then(() => true);
	}
}
routes.push(DeleteAll);

/**
 * @type {*[]}
 */
module.exports = routes;
