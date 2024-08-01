'use strict';

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

const Helpers = require('../helpers');

/**
 * @class Projection
 */
class Projection {
	constructor() {
		this.logicalOperator = [
			'$and',
			'$or',
		];

		this._ignoredQueryKeys = [
			'__crPath',
			'project',
		];
	}

	async addAccessControlPolicyQueryProjection(req, userPolicies, schema) {
		const isPoliciesAllowed = [];

		await Object.keys(userPolicies).reduce(async (prev, key) => {
			await prev;
			isPoliciesAllowed.push(await this.__applyPolicyProjectinos(req, userPolicies[key].projection, schema));
		}, Promise.resolve());

		return isPoliciesAllowed.every((flag) => flag);
	}

	async __applyPolicyProjectinos(req, projections, schema) {
		const requestMethod = req.method;
		const flattenedSchema = Helpers.getFlattenedSchema(schema);
		let requestBody = req.body;

		const outcome = projections.reduce((arr, proj) => {
			const projectionKeys = proj.keys;
			const projection = {};

			if (projectionKeys && projectionKeys.length > 0) {
				projectionKeys.forEach((key) => {
					projection[key] = 1;
				});
			}

			if (requestMethod === 'POST') {
				const updatePaths = Object.keys(requestBody).map((key) => key);

				if (projectionKeys.length > 0) {
					const removedPaths = updatePaths
						.filter((key) => projectionKeys.every((updateKey) => updateKey !== key))
						.filter((path) => flattenedSchema[path]);

					removedPaths.forEach((i) => {
						// TODO think about required fields that users do not have write access to
						const config = flattenedSchema[i];
						requestBody[i] = Helpers.Schema.getPropDefault(config);
					});
				}

				arr.push(true);
			} else if (requestMethod === 'PUT') {
				let update = false;
				if (!Array.isArray(requestBody) && typeof requestBody === 'object') {
					requestBody = [requestBody];
				}

				const updatePaths = requestBody.map((elem) => elem.path);
				const allowedPathUpdates = projectionKeys.filter((key) => updatePaths.some((updateKey) => {
					const pattern = new RegExp(`^${key}`);
					return pattern.test(updateKey);
				}));
				if (allowedPathUpdates.length === updatePaths.length || projectionKeys.length < 1) {
					update = true;
				}
				arr.push(update);
			} else {
				arr.push((projectionKeys.length > 0)? this.__checkPorjectionPath(requestBody, projectionKeys) : true);
			}

			req.body.project = (req.body.project)? {...req.body.project, ...projection} : projection;
			return arr;
		}, []);

		return outcome.every((flag) => flag);
	}

	__checkPorjectionPath(requestBody, projectionKeys) {
		const query = (requestBody.query) ? requestBody.query : requestBody;
		const paths = Object.keys(query).filter((key) => key && !this._ignoredQueryKeys.includes(key));
		let queryKeys = [];

		paths.forEach((path) => {
			if (this.logicalOperator.includes(path)) {
				query[path].forEach((p) => {
					queryKeys = queryKeys.concat(Object.keys(p));
				});
				return;
			}

			queryKeys = queryKeys.concat(Object.keys(path));
		});

		return queryKeys.every((key) => projectionKeys.includes(key));
	}
}
module.exports = new Projection();
