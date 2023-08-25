const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class GetMany
 */
module.exports = class GetMany extends Route {
	constructor(schema, appShort, nrp) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}/bulk/load`, `BULK GET ${schema.name}`, nrp);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.SEARCH;
		this.permissions = Route.Constants.Permissions.READ;

		this.activityDescription = `BULK GET ${schema.name}`;
		this.activityBroadcast = false;

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
		return this.model.find(
			{id: {$in: query.ids.map((id) => this.model.createId(id))}},
			{}, 0, 0, null, query.project,
		);
	}
};
