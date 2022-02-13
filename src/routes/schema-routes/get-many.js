const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class GetMany
 */
module.exports = class GetMany extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/bulk/load`, `BULK GET ${schema.name}`);
		this.verb = Route.Constants.Verbs.POST;
		this.auth = Route.Constants.Auth.ADMIN;
		this.permissions = Route.Constants.Permissions.READ;

		this.activityDescription = `BULK GET ${schema.name}`;
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
			const _ids = req.body;
			if (!_ids) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
			}
			if (!_ids.length) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, 'invalid_id'));
			}
			resolve(_ids);
		});
	}

	_exec(req, res, ids) {
		return this.model.findAllById(ids);
	}
};
