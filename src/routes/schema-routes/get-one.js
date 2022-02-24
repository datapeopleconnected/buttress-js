const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

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
			try {
				objectId = this.model.createId(req.params.id);
			} catch (err) {
				this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
			}

			this.model.findById(objectId)
				.then((entity) => {
					if (!entity) {
						this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
						return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
					}
					resolve(entity);
				});
		});
	}

	_exec(req, res, entity) {
		return Promise.resolve(entity);
	}
};
