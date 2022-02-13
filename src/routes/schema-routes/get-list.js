
const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Logging = require('../../logging');
const Schema = require('../../schema');

/**
 * @class GetList
 */
module.exports = class GetList extends Route {
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
		let query = Promise.resolve({});
		if (token.authLevel < 3) {
			query = this.model.generateRoleFilterQuery(token, req.roles, Model);
		}

		Logging.logTimer(`${this.name}:_validate:end`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
		return query;
	}

	_exec(req, res, query) {
		Logging.logTimer(`${this.name}:_validate:start`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
		return this.model.find(query, {}, true);
	}
};
