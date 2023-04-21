const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class SearchList
 */
module.exports = class SearchList extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}`, `SEARCH ${schema.name} LIST`);
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.LIST;

		this.activityDescription = `SEARCH ${schema.name} LIST`;
		this.activityBroadcast = false;

		let schemaCollection = schema.name;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.name}`;
		}

		// Fetch model
		this.schema = new Schema(schema);
		this.model = Model[schemaCollection];

		if (!this.model) {
			throw new Helpers.Errors.RouteMissingModel(`SearchList Route missing model ${schemaCollection}`);
		}
	}

	_validate(req, res, token) {
		const result = {
			query: {},
			skip: (req.body && req.body.skip) ? parseInt(req.body.skip) : 0,
			limit: (req.body && req.body.limit) ? parseInt(req.body.limit) : 0,
			sort: (req.body && req.body.sort) ? req.body.sort : {},
			project: (req.body && req.body.project)? req.body.project : false,
		};

		if (isNaN(result.skip)) throw new Helpers.Errors.RequestError(400, `invalid_value_skip`);
		if (isNaN(result.limit)) throw new Helpers.Errors.RequestError(400, `invalid_value_limit`);

		let query = {};

		if (!query.$and) {
			query.$and = [];
		}

		// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
		if (req.body && req.body.query) {
			query.$and.push(req.body.query);
		}

		query = this.model.parseQuery(query, {}, this.model.flatSchemaData);

		result.query = query;
		return result;
	}

	_exec(req, res, validateResult) {
		return this.model.find(validateResult.query, {},
			validateResult.limit, validateResult.skip, validateResult.sort, validateResult.project);
	}
};
