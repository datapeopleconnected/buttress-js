
const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Logging = require('../../logging');
const Schema = require('../../schema');

const SchemaModel = require('../../model/schemaModel');

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
};
