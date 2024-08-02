/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
 *
 * This file is part of Buttress.
 * Buttress is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public Licence as published by the Free Software
 * Foundation, either version 3 of the Licence, or (at your option) any later version.
 * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public Licence for more details.
 * You should have received a copy of the GNU Affero General Public Licence along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */

import Route from '../route';
import Model from '../../model';
import * as Helpers from '../../helpers';
import Schema from '../../schema';

/**
 * @class UpdateMany
 */
module.exports = class UpdateMany extends Route {
	constructor(schema, appShort, nrp) {
		const schemaRoutePath = Schema.modelToRoute(schema.name);

		super(`${schemaRoutePath}/bulk/update`, `BULK UPDATE ${schema.name}`, nrp);
		this.__configureSchemaRoute();
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
			throw new Helpers.Errors.RouteMissingModel(`${this.name} missing model ${schemaCollection}`);
		}
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
				const {validation, body} = this.model.validateUpdate(update.body);
				update.body = body;
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

				return this.model.exists(update.id, body.sourceId)
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
		const output: {
			id: string,
			sourceId: string,
			results: any,
		}[] = [];

		return data.reduce(
			(prev, body) => prev
				.then(() => this.model.updateByPath(body.body, body.id, body.sourceId))
				.then((result) => output.push({id: body.id, sourceId: body.sourceId, results: result})),
			Promise.resolve(),
		)
			.then(() => output);
	}
};
