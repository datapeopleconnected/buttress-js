const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class DeleteAll
 */
module.exports = class DeleteAll extends Route {
	constructor(schema, appShort, nrp) {
		super(`${schema.name}`, `DELETE ALL ${schema.name}`, nrp);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.DEL;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `DELETE ALL ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.name;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.name}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`${this.name} missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		return Promise.resolve();
	}

	_exec(req, res, validate) {
		return this.model.rmAll()
			.then(() => true);
	}
};
