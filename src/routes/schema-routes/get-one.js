const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class GetOne
 */
module.exports = class GetOne extends Route {
	constructor(schema, appShort, nrp) {
		super(`${schema.name}/:id`, `GET ${schema.name}`, nrp);
		this.verb = Route.Constants.Verbs.GET;
		this.permissions = Route.Constants.Permissions.READ;

		this.activityDescription = `GET ${schema.name}`;
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

	async _validate(req, res, token) {
		let objectId = null;
		const project = (req.body && req.body.project)? req.body.project : false;

		try {
			objectId = this.model.createId(req.params.id);
		} catch (err) {
			this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, 'invalid_id');
		}

		let query = {_id: objectId};
		if (req.body.query && Object.keys(req.body.query).length > 0) {
			query = req.body.query;

			query = this.model.parseQuery(query, {}, this.model.flatSchemaData);
			query._id = objectId;
		}

		return {
			query,
			project,
		};
	}

	async _exec(req, res, validate) {
		const rxsEntity = await this.model.find(validate.query, {}, 1, 0, null, validate.project);
		const entity = await Helpers.streamFirst(rxsEntity);

		if (!entity) {
			this.log(`${this.schema.name}: Invalid ID: ${req.params.id}`, Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, 'invalid_id or access_control_not_fullfilled');
		}

		return entity;
	}
};
