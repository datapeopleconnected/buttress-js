const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class UpdateOne
 */
module.exports = class UpdateOne extends Route {
	constructor(schema, appShort, nrp) {
		super([
			`${schema.name}/:id`,
			`${schema.name}/:sourceId/:id`,
		], `UPDATE ${schema.name}`, nrp);
		this.__configureSchemaRoute();
		this.verb = Route.Constants.Verbs.PUT;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityDescription = `UPDATE ${schema.name}`;
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

		this._entity = null;
	}

	async _validate(req, res, token) {
		const {validation, body} = this.model.validateUpdate(req.body);
		req.body = body;
		if (!validation.isValid) {
			if (validation.isPathValid === false) {
				this.log(`${this.schema.name}: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR, req.id);
				throw new Helpers.Errors.RequestError(400, `${this.schema.name}: Update path is invalid: ${validation.invalidPath}`);
			}
			if (validation.isValueValid === false) {
				this.log(`${this.schema.name}: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR, req.id);
				if (validation.isMissingRequired) {
					throw new Helpers.Errors.RequestError(
						400,
						`${this.schema.name}: Missing required property updating ${req.body.path}: ${validation.missingRequired}`,
					);
				}

				throw new Helpers.Errors.RequestError(
					400,
					`${this.schema.name}: Update value is invalid for path ${req.body.path}: ${validation.invalidValue}`,
				);
			}
		}

		const exists = await this.model.exists(req.params.id, req.params.sourceId);
		if (!exists) {
			this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.id);
			throw new Helpers.Errors.RequestError(400, `invalid_id`);
		}

		return true;
	}

	_exec(req, res, validate) {
		return this.model.updateByPath(req.body, req.params.id, req.params.sourceId, null);
	}
};
