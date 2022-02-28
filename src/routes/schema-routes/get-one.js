const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

const SchemaModel = require('../../model/schemaModel');

/**
 * @class GetOne
 */
module.exports = class GetOne extends Route {
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
				objectId = this.model.createId(req.params.id);
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
};
