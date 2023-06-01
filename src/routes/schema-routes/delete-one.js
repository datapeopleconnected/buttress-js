const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class DeleteOne
 */
module.exports = class DeleteOne extends Route {
	constructor(schema, appShort, nrp) {
		super(`${schema.name}/:id`, `DELETE ${schema.name}`, nrp);
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.name;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.name}`;
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
};
