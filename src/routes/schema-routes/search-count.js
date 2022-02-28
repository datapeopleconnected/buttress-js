const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

const SchemaModel = require('../../model/schemaModel');

/**
 * @class Count
 */
module.exports = class SearchCount extends Route {
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

				// TODO: Validate this input against the schema, schema properties should be tagged with what can be queried
				if (req.body && req.body.query) {
					query.$and.push(req.body.query);
				} else if (req.body && !req.body.query) {
					query.$and.push(req.body);
				}

				return this.model.parseQuery(query, {}, this.model.flatSchemaData);
			})
			.then((query) => {
				result.query = query;
				return result;
			});
	}

	_exec(req, res, validateResult) {
		return this.model.count(validateResult.query);
	}
};
