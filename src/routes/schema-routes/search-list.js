const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

const SchemaModel = require('../../model/schemaModel');

/**
 * @class SearchList
 */
module.exports = class SearchList extends Route {
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

				return this.model.parseQuery(query, {}, this.model.flatSchemaData);
			})
			.then((query) => {
				result.query = query;
				return result;
			});
	}

	_exec(req, res, validateResult) {
		return this.model.find(validateResult.query, {},
			validateResult.limit, validateResult.skip, validateResult.sort, validateResult.project);
	}
};
