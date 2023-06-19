const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class AddMany
 */
module.exports = class AddMany extends Route {
	constructor(schema, appShort, nrp) {
		super(`${schema.name}/bulk/add`, `BULK ADD ${schema.name}`, nrp);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.ADD;

		this.activityDescription = `BULK ADD ${schema.name}`;
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
	}

	_validate(req, res, token) {
		return new Promise((resolve, reject) => {
			const entities = req.body;
			if (entities instanceof Array === false) {
				this.log(`ERROR: You need to supply an array of ${this.schema.name}`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `array_required`));
			}
			// if (companies.length > 601) {
			//   this.log(`ERROR: No more than 300`, Route.LogLevel.ERR);
			//   reject({statusCode: 400, message: `Invalid data: send no more than 300 ${this.schema.name} at a time`});
			//   return;
			// }

			const validation = this.model.validate(entities);
			if (!validation.isValid) {
				if (validation.missing.length > 0) {
					this.log(`ERROR: Missing field: ${validation.missing[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Missing field: ${validation.missing[0]}`));
				}
				if (validation.invalid.length > 0) {
					this.log(`ERROR: Invalid value: ${validation.invalid[0]}`, Route.LogLevel.ERR, req.id);
					return reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Invalid value: ${validation.invalid[0]}`));
				}

				return reject(new Helpers.Errors.RequestError(400, `unknown_error`));
			}
			resolve(entities);
		});
	}

	_exec(req, res, entities) {
		return this.model.add(entities);
	}
};
