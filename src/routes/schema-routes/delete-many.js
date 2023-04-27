const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class DeleteMany
 */
module.exports = class DeleteMany extends Route {
	constructor(path, schema, appShort) {
		super(`${path}/bulk/delete`, `BULK DELETE ${schema.name}`);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.DELETE;

		this.activityDescription = `BULK DELETE ${schema.name}`;
		this.activityBroadcast = true;

		let schemaCollection = schema.name;
		if (appShort) {
			schemaCollection = `${appShort}-${schema.name}`;
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
			let ids = req.body;

			if (!ids) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `Requires ids`));
			}
			if (!ids.length) {
				this.log(`ERROR: No ${this.schema.name} IDs provided`, Route.LogLevel.ERR, req.id);
				return reject(new Helpers.Errors.RequestError(400, `Expecting array of ids`));
			}

			try {
				ids = ids.map((id) => this.model.createId(id));
			} catch (err) {
				return reject(new Helpers.Errors.RequestError(400, `All ids must be string of 12 bytes or a string of 24 hex characters`));
			}

			// if (this._ids.length > 600) {
			//   this.log('ERROR: No more than 300 company IDs are supported', Route.LogLevel.ERR);
			//   reject({statusCode: 400, message: 'ERROR: No more than 300 company IDs are supported'});
			//   return;
			// }
			resolve(ids);
		});
	}

	_exec(req, res, ids) {
		return this.model.rmBulk(ids)
			.then(() => true);
	}
};
