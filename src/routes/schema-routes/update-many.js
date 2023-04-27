const Route = require('../route');
const Model = require('../../model');
const Helpers = require('../../helpers');
const Schema = require('../../schema');

/**
 * @class UpdateMany
 */
module.exports = class UpdateMany extends Route {
	constructor(path, schema, appShort) {
		super(`${path}/bulk/update`, `BULK UPDATE ${schema.name}`);
		this.verb = Route.Constants.Verbs.POST;
		this.permissions = Route.Constants.Permissions.WRITE;

		this.activityDescription = `BULK UPDATE ${schema.name}`;
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

		this._entity = null;
	}

	_validate(req, res, token) {
		if (!Array.isArray(req.body)) {
			this.log(`${this.schema.name}: Expected body to be an array of updates`, Route.LogLevel.ERR, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(400, `${this.schema.name}: Expected body to be an array of updates`));
		}

		// Reduce down duplicate entity updates into one object
		const data = req.body.reduce((reducedUpdates, update) => {
			const existing = reducedUpdates.find((u) => u.id === update.id);

			if (!existing) {
				reducedUpdates.push(update);
			} else {
				if (!Array.isArray(existing.body)) existing.body = [existing.body];
				if (!Array.isArray(update.body)) update.body = [update.body];
				existing.body = [...existing.body, ...update.body];
			}

			return reducedUpdates;
		}, []);

		return data.reduce((prev, update) => {
			return prev.then(() => {
				const validation = this.model.validateUpdate(update.body);
				if (!validation.isValid) {
					if (validation.isPathValid === false) {
						this.log(`${this.schema.name}: Update path is invalid: ${validation.invalidPath}`, Route.LogLevel.ERR, req.id);
						return update.validation = {
							code: 400,
							message: `${this.schema.name}: Update path is invalid: ${validation.invalidPath}`,
						};
					}
					if (validation.isValueValid === false) {
						this.log(`${this.schema.name}: Update value is invalid: ${validation.invalidValue}`, Route.LogLevel.ERR, req.id);
						if (validation.isMissingRequired) {
							return update.validation = {
								code: 400,
								message: `${this.schema.name}: Missing required property updating ${req.body.path}: ${validation.missingRequired}`,
							};
						}

						return update.validation = {
							code: 400,
							message: `${this.schema.name}: Update value is invalid for path ${req.body.path}: ${validation.invalidValue}`,
						};
					}
				}

				return this.model.exists(update.id)
					.then((exists) => {
						if (!exists) {
							this.log('ERROR: Invalid ID', Route.LogLevel.ERR, req.id);
							return update.validation = {
								code: 400,
								message: `${this.schema.name}: Missing required property updating ${req.body.path}: ${validation.missingRequired}`,
							};
						}

						return update.validation = true;
					});
			});
		}, Promise.resolve())
			.then(() => data);
	}

	_exec(req, res, data) {
		const output = [];
		return data.reduce(
			(prev, body) => prev
				.then(() => this.model.updateByPath(body.body, body.id))
				.then((result) => output.push({id: body.id, results: result})),
			Promise.resolve(),
		)
			.then(() => output);
	}
};
