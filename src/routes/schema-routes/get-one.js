const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

const SchemaModel = require('../../model/schemaModel');

/**
 * @class GetOne
 */
module.exports = class GetOne extends Route {
	constructor(schema, appShort) {
		super(`${schema.name}/:id`, `GET ${schema.name}`);
		this.verb = Route.Constants.Verbs.GET;
		this.auth = Route.Constants.Auth.USER;
		this.permissions = Route.Constants.Permissions.READ;

		this.activityDescription = `GET ${schema.name}`;
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

		query._id = this.model.createId();

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
